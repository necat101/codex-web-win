import JSON5 from "json5";
import { Buffer } from "node:buffer";
import {
  isAllowedToolChoice,
  namespacedToolName,
  resolveToolChoiceWireName,
  toolAllowedByChoice,
  type CodexParsedRequest,
  type CodexTool,
} from "../../types";

export const DEEPSEEK_TOOL_CALL_KEY = "codex_tool_calls";
export const DEEPSEEK_MAX_PARALLEL_TOOL_CALLS = 8;

export interface DeepSeekToolRequest {
  name: string;
  arguments: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Native Codex apply_patch requires every line in an Add File body to carry
 * the `+` hunk prefix, including blank lines. DeepSeek reliably prefixes
 * non-empty file content but occasionally renders an intended `+` blank line
 * as a physically empty line. Repair only Add File bodies, where the intended
 * meaning is unambiguous; Update/Delete hunks remain strict because a bare
 * blank line there could mean context or a mutation.
 */
export function normalizeDeepSeekApplyPatchBlankLines(patch: string): string {
  const newline = patch.includes("\r\n") ? "\r\n" : patch.includes("\n") ? "\n" : patch.includes("\r") ? "\r" : undefined;
  if (!newline) return patch;

  let inAddFile = false;
  return patch.split(/\r\n|\n|\r/).map(line => {
    if (line.startsWith("*** Add File: ")) {
      inAddFile = true;
      return line;
    }
    if (line.startsWith("*** ")) {
      inAddFile = false;
      return line;
    }
    if (inAddFile && /^[\t ]*$/.test(line)) return `+${line}`;
    return line;
  }).join(newline);
}

/**
 * DeepSeek Web can add one Markdown/display escaping layer to the contents of
 * an apply_patch string after it has already serialized the JSON envelope. In
 * that shape patch markers arrive as `\*\*\* Begin Patch`, punctuation inside
 * added file content is escaped too, and JSON newlines can survive parsing as
 * literal `\n` text. Only peel this layer when the patch's own opening marker
 * proves that it was renderer-escaped; ordinary patches, Windows paths, regex
 * literals, and other tool arguments remain untouched.
 */
export function normalizeDeepSeekApplyPatchRendererEscapes(patch: string): string {
  const leading = patch.match(/^\s*/)?.[0] ?? "";
  const body = patch.slice(leading.length);
  if (!body.startsWith("\\*\\*\\* Begin Patch")) return patch;

  let normalized = body.replace(/\\([\\`*{}\[\]()#+\-.!_>])/g, "$1");
  const patchLineStart = String.raw`(?:\*\*\*|\*\* End Patch|@@|[+\- ])`;
  normalized = normalized.replace(new RegExp(String.raw`\\r\\n(?=${patchLineStart})`, "g"), "\r\n");
  normalized = normalized.replace(new RegExp(String.raw`\\n(?=${patchLineStart})`, "g"), "\n");
  normalized = normalized.replace(new RegExp(String.raw`\\r(?=${patchLineStart})`, "g"), "\r");
  normalized = normalized.replace(/(^|\r\n|\n|\r)\*\* End Patch(?=(?:\\r\\n|\\n|\\r|\r\n|\n|\r|$))/, "$1*** End Patch");
  normalized = normalized.replace(/(\*\*\* End Patch)\\r\\n$/, "$1\r\n");
  normalized = normalized.replace(/(\*\*\* End Patch)\\n$/, "$1\n");
  normalized = normalized.replace(/(\*\*\* End Patch)\\r$/, "$1\r");
  return leading + normalized;
}

/**
 * The Windows native exec wrapper can lose PowerShell parser diagnostics when
 * a multiline command itself cannot be parsed (notably malformed/mangled
 * here-strings), yielding exit code 1 with empty output. A second observed
 * failure mode is outer-shell expansion corrupting single-line PowerShell
 * expressions such as `$($_.LineNumber)` before the requested command reaches
 * PowerShell. Encode those shell-sensitive commands into a one-line child
 * PowerShell invocation and parse the original source inside that child, where
 * the source is opaque to the outer shell and parser failures can be written
 * explicitly to stderr. Plain single-line commands and non-Windows hosts keep
 * their native shape.
 */
export function wrapDeepSeekWindowsPowerShellCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32" || !/[\r\n$`]/.test(command)) return command;
  const source = Buffer.from(command, "utf8").toString("base64");
  const statusTrailer = Buffer.from([
    "if (-not $?) {",
    "  if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
    "  exit 1",
    "}",
  ].join("\n"), "utf8").toString("base64");
  const wrapper = [
    `$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${source}'))`,
    `$statusTrailer = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${statusTrailer}'))`,
    "try {",
    "  $block = [ScriptBlock]::Create($source + [Environment]::NewLine + $statusTrailer)",
    "} catch {",
    "  [Console]::Error.WriteLine($_.Exception.Message)",
    "  exit 1",
    "}",
    "& $block",
  ].join("\n");
  const encoded = Buffer.from(wrapper, "utf16le").toString("base64");
  return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}

function normalizeDeepSeekHarnessToolRequests(
  requests: DeepSeekToolRequest[],
  tools: CodexTool[],
): DeepSeekToolRequest[] {
  return requests.map(request => {
    const tool = tools.find(candidate => namespacedToolName(candidate.namespace, candidate.name) === request.name);
    if (!tool) return request;

    if (tool.name === "apply_patch" && typeof request.arguments.input === "string") {
      const input = normalizeDeepSeekApplyPatchRendererEscapes(request.arguments.input);
      return {
        ...request,
        arguments: {
          ...request.arguments,
          input: normalizeDeepSeekApplyPatchBlankLines(input),
        },
      };
    }

    const requestedShell = typeof request.arguments.shell === "string"
      ? request.arguments.shell.trim().toLowerCase()
      : "";
    const powerShellTransport = !requestedShell
      || requestedShell === "powershell"
      || requestedShell === "powershell.exe"
      || requestedShell === "pwsh"
      || requestedShell === "pwsh.exe";

    if (tool.name === "exec_command"
      && powerShellTransport
      && typeof request.arguments.cmd === "string") {
      return {
        ...request,
        arguments: {
          ...request.arguments,
          cmd: wrapDeepSeekWindowsPowerShellCommand(request.arguments.cmd),
        },
      };
    }

    if (tool.name === "shell_command"
      && powerShellTransport
      && typeof request.arguments.command === "string") {
      return {
        ...request,
        arguments: {
          ...request.arguments,
          command: wrapDeepSeekWindowsPowerShellCommand(request.arguments.command),
        },
      };
    }

    return request;
  });
}

function normalizeDeepSeekMarkupTags(text: string): string {
  // DeepSeek's Markdown renderer may escape Codex-style XML-ish tool markup
  // more than once (for example `\\\\<tool\\\\_calls>`). Normalize only the
  // tag syntax so parameter payloads such as Windows paths keep their literal
  // backslashes intact.
  return text.replace(/\\*<[^>]+>/g, tag => tag.replace(/\\+/g, ""));
}

function normalizeDeepSeekDsmlMarkupTags(text: string): string {
  const normalized = normalizeDeepSeekMarkupTags(text.trim());
  return normalized.replace(
    /<(\/?)[^>\r\n]*DSML[^>\r\n]*?\b(tool_calls|invoke|parameter|argument|arg)\b([^>]*)>/gi,
    (_match, closing: string, tagName: string, attributes: string) => {
      const rawTagName = tagName.toLowerCase();
      const normalizedTagName = rawTagName === "argument" || rawTagName === "arg"
        ? "parameter"
        : rawTagName;
      if (closing) return `</${normalizedTagName}>`;
      const normalizedAttributes = normalizedTagName === "parameter"
        ? attributes.replace(/\s+string\s*=\s*"true"/i, "")
        : attributes;
      return `<${normalizedTagName}${normalizedAttributes}>`;
    },
  );
}

/**
 * DeepSeek's renderer sometimes combines the normal Codex opening tags with
 * its private DSML end sentinel. The sentinel is not XML and has also been
 * observed without a final `>`, so the strict markup parser cannot see an
 * otherwise complete request. Repair only a terminal, explicitly opened
 * `<tool_calls>` block. Ordinary prose and examples followed by prose remain
 * outside this compatibility path.
 */
function normalizeDeepSeekTerminalToolCallsMarkup(text: string): string {
  let normalized = normalizeDeepSeekDsmlMarkupTags(normalizeDeepSeekMarkupTags(text.trim()));
  const openings = [...normalized.matchAll(/<tool_calls>\s*/gi)];
  if (openings.length === 0) return normalized;

  const opening = openings[openings.length - 1]!;
  const openingIndex = opening.index ?? 0;
  const bodyStart = openingIndex + opening[0].length;
  let body = normalized.slice(bodyStart);

  if (!/<\/tool_calls>\s*$/i.test(body)) {
    const dsmlSentinel = body.match(/<\/[^<>\r\n]*DSML[^<>\r\n]*(?:>|$)\s*$/i);
    if (dsmlSentinel?.index !== undefined) {
      body = `${body.slice(0, dsmlSentinel.index).trimEnd()}\n</tool_calls>`;
    } else if (/<\/invoke>\s*$/i.test(body)) {
      // The JSON-shaped compatibility parser already accepts a missing terminal
      // envelope close. Apply the same tightly scoped rule to invoke markup.
      body = `${body.trimEnd()}\n</tool_calls>`;
    } else {
      return normalized;
    }
  }

  // A second renderer variant drops the final parameter close immediately
  // before </invoke>, most often for freeform apply_patch input. Infer it only
  // when an invoke contains exactly one parameter opening and no parameter
  // closing; more ambiguous damage is left for the bounded correction loop.
  body = body.replace(/<invoke\b[^>]*>[\s\S]*?<\/invoke>/gi, invoke => {
    const parameterOpenings = [...invoke.matchAll(/<(parameter|argument|arg)\b[^>]*>/gi)];
    const parameterClosings = [...invoke.matchAll(/<\/(parameter|argument|arg)>/gi)];
    if (parameterOpenings.length !== 1 || parameterClosings.length !== 0) return invoke;
    const tagName = parameterOpenings[0]![1]!.toLowerCase();
    const closeIndex = invoke.toLowerCase().lastIndexOf("</invoke>");
    if (closeIndex < 0) return invoke;
    return `${invoke.slice(0, closeIndex).trimEnd()}</${tagName}>\n${invoke.slice(closeIndex)}`;
  });

  normalized = `${normalized.slice(0, bodyStart)}${body}`;
  return normalized;
}

function normalizeDeepSeekDsmlObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeDeepSeekDsmlObjectKeys);
  if (!isRecord(value)) return value;
  const normalized: Record<string, unknown> = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey.replace(/\\+_/g, "_");
    if (key in normalized) {
      throw new Error(`DeepSeek DSML tool request repeated normalized key ${key}`);
    }
    normalized[key] = normalizeDeepSeekDsmlObjectKeys(rawValue);
  }
  return normalized;
}

function repairDeepSeekJsonUnknownEscapes(text: string): string {
  // DeepSeek's rendered text can collapse JSON's doubled Windows-path
  // backslashes while leaving the surrounding JSON otherwise intact. JSON.parse
  // rejects those strings (`C:\Users` contains an invalid `\U` escape). Repair
  // only invalid JSON escapes while inside strings so a literal backslash is
  // preserved. Valid JSON escapes keep their normal meaning.
  let repaired = "";
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === '"' || char === "'") {
      if (quote === undefined) quote = char;
      else if (quote === char) quote = undefined;
      repaired += char;
      continue;
    }
    if (quote === undefined || char !== "\\") {
      repaired += char;
      continue;
    }

    const next = text[index + 1];
    if (next === undefined) {
      repaired += "\\\\";
      continue;
    }
    if (`"'\\/bfnrt`.includes(next)) {
      repaired += char + next;
      index += 1;
      continue;
    }
    if (next === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(index + 2, index + 6))) {
      repaired += text.slice(index, index + 6);
      index += 5;
      continue;
    }

    // `\\_` is also emitted around identifiers such as
    // `functions\\_\\_exec\\_command`. Preserve it here; identifier-only
    // normalization happens after parsing so a legitimate path like
    // `C:\\_workspace` is never corrupted.
    repaired += "\\\\";
  }
  return repaired;
}

function nextNonWhitespaceIndex(text: string, start: number): number {
  let index = start;
  while (index < text.length && /\s/.test(text[index]!)) index += 1;
  return index;
}

function looksLikeJsonObjectKeyAt(text: string, start: number): boolean {
  const index = nextNonWhitespaceIndex(text, start);
  const quote = text[index];
  if (quote !== '"' && quote !== "'") return false;

  for (let cursor = index + 1; cursor < text.length; cursor += 1) {
    const char = text[cursor]!;
    if (char === "\\") {
      cursor += 1;
      continue;
    }
    if (char !== quote) continue;
    return text[nextNonWhitespaceIndex(text, cursor + 1)] === ":";
  }
  return false;
}

function repairDeepSeekUnescapedStringQuotes(text: string): string {
  // A DeepSeek renderer variant applies the same display escape depth to JSON
  // syntax quotes and to quotes that belong inside a string argument. Peeling
  // that display layer therefore produces invalid JSON such as:
  //   {"cmd":"New-Item -Path "C:\\work" | Write-Output "done"","workdir":"C:\\work"}
  // Strict parsing is always attempted first. This fallback only escapes a
  // quote that cannot plausibly terminate the current JSON string at the
  // current container level. That keeps structural quotes intact while
  // recovering quoted shell/PowerShell fragments inside string arguments.
  let repaired = "";
  const containers: Array<"{" | "["> = [];
  let quote: '"' | "'" | undefined;
  let stringRole: "key" | "value" = "value";

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;

    if (quote !== undefined) {
      if (char === "\\") {
        repaired += char;
        if (index + 1 < text.length) {
          repaired += text[index + 1]!;
          index += 1;
        }
        continue;
      }
      if (char !== quote) {
        repaired += char;
        continue;
      }

      const nextIndex = nextNonWhitespaceIndex(text, index + 1);
      const next = text[nextIndex];
      const container = containers.at(-1);
      const canClose = stringRole === "key"
        ? next === ":"
        : container === "{"
          ? next === "}" || (next === "," && looksLikeJsonObjectKeyAt(text, nextIndex + 1))
          : container === "["
            ? next === "]" || next === ","
            : next === undefined;

      if (canClose) {
        quote = undefined;
        repaired += char;
      } else {
        repaired += `\\${char}`;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      const container = containers.at(-1);
      let previousIndex = repaired.length - 1;
      while (previousIndex >= 0 && /\s/.test(repaired[previousIndex]!)) previousIndex -= 1;
      const previous = previousIndex >= 0 ? repaired[previousIndex] : undefined;
      stringRole = container === "{" && (previous === "{" || previous === ",") ? "key" : "value";
      quote = char;
      repaired += char;
      continue;
    }

    if (char === "{" || char === "[") containers.push(char);
    else if (char === "}" && containers.at(-1) === "{") containers.pop();
    else if (char === "]" && containers.at(-1) === "[") containers.pop();
    repaired += char;
  }

  return repaired;
}

function repairDeepSeekParenthesizedToolCallsEnvelope(text: string): string | undefined {
  // A DeepSeek renderer variant has been observed turning the preferred
  // `codex_tool_calls` array delimiters into escaped parentheses while leaving
  // the call object itself intact, for example:
  //   {\"codex\_tool\_calls\":\\({\"name\":...}\\)}
  // Repair only a whole, single-field preferred envelope. Requiring escaped
  // parentheses immediately around an object keeps this compatibility rule
  // from rewriting ordinary parentheses inside command strings or prose.
  const candidate = stripWholeJsonFence(text.trim());
  const key = candidate.match(/^\{\s*\\*["']codex\\*_tool\\*_calls\\*["']\s*:\s*/);
  if (!key) return undefined;

  const valueStart = key[0].length;
  const open = candidate.slice(valueStart).match(/^\\+\(\s*(?=\{)/);
  const close = candidate.match(/\\+\)\s*\}\s*$/);
  if (!open || !close || close.index === undefined) return undefined;

  const openEnd = valueStart + open[0].length;
  const closeStart = close.index;
  if (closeStart < openEnd) return undefined;
  const body = candidate.slice(openEnd, closeStart).trim();
  if (!body.startsWith("{") || !body.endsWith("}")) return undefined;

  const outerClose = candidate.slice(closeStart + close[0].length - 1);
  if (outerClose !== "}") return undefined;
  return `${candidate.slice(0, valueStart)}[${body}]}`;
}

function parseDeepSeekRenderedJson(text: string): unknown | undefined {
  let candidate = stripWholeJsonFence(text.trim());
  const looseStringQuoteCandidates: string[] = [];
  for (let depth = 0; depth < 5; depth += 1) {
    const parenthesized = repairDeepSeekParenthesizedToolCallsEnvelope(candidate);
    for (const baseVariant of parenthesized ? [candidate, parenthesized] : [candidate]) {
      const preferredEnvelope = /^\{\s*\\*["']codex\\*_tool\\*_calls\\*["']\s*:/.test(baseVariant);
      const rawVariants = preferredEnvelope
        ? [baseVariant, `${baseVariant}}`, `${baseVariant}}}`]
        : [baseVariant];
      for (const rawVariant of rawVariants) {
        const repaired = repairDeepSeekJsonUnknownEscapes(rawVariant);
        looseStringQuoteCandidates.push(repaired);
        for (const variant of [rawVariant, repaired]) {
          try {
            return JSON.parse(variant);
          } catch {
            // Try the next conservative renderer repair below.
          }
        }
        try {
          return JSON5.parse(repaired);
        } catch {
          // JSON5 is a data-only fallback for renderer-added trailing commas,
          // single quotes, or unquoted object keys. Unknown escapes were repaired
          // first so Windows paths do not silently lose their backslashes.
        }
      }
    }

    // DeepSeek sometimes adds one or more display-escape layers to every quote
    // in the JSON blob. Peel one layer at a time rather than unescaping the
    // entire string, which would damage Windows paths and payload text.
    const next = candidate.replace(/\\\"/g, '"');
    if (next === candidate) break;
    candidate = next;
  }

  for (const repaired of looseStringQuoteCandidates.reverse()) {
    const stringQuoteRepaired = repairDeepSeekUnescapedStringQuotes(repaired);
    if (stringQuoteRepaired === repaired) continue;
    try {
      return JSON.parse(stringQuoteRepaired);
    } catch {
      try {
        return JSON5.parse(stringQuoteRepaired);
      } catch {
        // Try the next less-normalized renderer candidate.
      }
    }
  }
  return undefined;
}

function parseDeepSeekSelectivelyEscapedJson(body: string): unknown | undefined {
  // Some DeepSeek renderer builds escape JSON quotes for display without
  // applying the corresponding extra escape layer to backslashes inside JSON
  // string values. Decoding the whole body as a JSON string in that case turns
  // a valid Windows path such as `C:\\Users` into invalid JSON (`C:\Users`).
  // Peel only quote escapes, trying a few renderer depths, and leave all other
  // backslashes exactly as rendered.
  let candidate = body;
  for (let depth = 0; depth < 4; depth += 1) {
    const next = candidate.replace(/\\"/g, '"');
    if (next === candidate) break;
    candidate = next;
    try {
      return JSON.parse(candidate);
    } catch {
      // A nested quoted argument may need another renderer quote layer peeled.
    }
  }
  return undefined;
}

function normalizeDeepSeekToolCallObject(value: unknown): unknown {
  const normalized = normalizeDeepSeekDsmlObjectKeys(value);
  if (!isRecord(normalized)) return normalized;
  const name = normalized.name;
  return typeof name === "string"
    ? { ...normalized, name: name.replace(/\\+_/g, "_") }
    : normalized;
}

function parseDeepSeekDsmlToolPayload(text: string): unknown[] | undefined {
  const normalized = normalizeDeepSeekMarkupTags(text.trim());
  // DeepSeek occasionally ignores the requested Codex JSON envelope and emits
  // its own terminal DSML tool-call wrapper instead. Treat that wrapper as a
  // compatibility transport only; the calls still pass through the same exact
  // active-tool validation as native Codex envelopes below.
  const envelope = normalized.match(
    /<[^>\r\n]*DSML[^>\r\n]*\btool_calls"?\s*>\s*(?:&#x20;|&nbsp;|\u00a0)*\s*([\s\S]*?)\s*<\/[^>\r\n]*DSML[^>\r\n]*>\s*$/i,
  );
  if (!envelope) return undefined;

  const body = (envelope[1] ?? "").trim();
  if (!body) throw new Error("DeepSeek emitted DSML tool_calls without any tool calls");

  let payload = parseDeepSeekRenderedJson(body);
  if (payload === undefined) {
    // Some DeepSeek renderer revisions expose the JSON object with one extra
    // string-escape layer (for example `{\"name\":...}`). Decode that layer
    // without rewriting ordinary backslashes inside an already valid payload.
    try {
      payload = JSON.parse(JSON.parse(`"${body}"`));
    } catch {
      payload = parseDeepSeekSelectivelyEscapedJson(body);
      if (payload === undefined) {
        throw new Error("DeepSeek DSML tool_calls payload must contain valid JSON");
      }
    }
  }

  const calls = Array.isArray(payload) ? payload : [payload];
  return calls.map(normalizeDeepSeekToolCallObject);
}

function requestToolPayloadToCall(value: unknown): unknown {
  const normalized = normalizeDeepSeekToolCallObject(value);
  if (!isRecord(normalized)) return normalized;

  const keys = Object.keys(normalized);
  const argumentContainers = ["arguments", "args", "parameters"]
    .filter(key => key in normalized);
  if (argumentContainers.length > 1) {
    throw new Error("DeepSeek request_tool payload contains multiple argument containers");
  }

  if (argumentContainers.length === 1) {
    const container = argumentContainers[0]!;
    const extraKeys = keys.filter(key => key !== "name" && key !== container);
    if (extraKeys.length > 0) {
      throw new Error("DeepSeek request_tool payload mixes nested and flattened arguments");
    }
    let argumentsValue = normalized[container];
    if (typeof argumentsValue === "string") {
      argumentsValue = parseDeepSeekRenderedJson(argumentsValue);
    }
    return { name: normalized.name, arguments: argumentsValue };
  }

  // The request_tool dialect seen in the DeepSeek web renderer places the
  // advertised tool's arguments directly beside `name` rather than under an
  // `arguments` object. Canonicalize that shape before normal validation.
  const { name, ...argumentsObject } = normalized;
  return { name, arguments: argumentsObject };
}

function parseDeepSeekRequestToolPayload(text: string): unknown[] | undefined {
  const normalized = normalizeDeepSeekMarkupTags(text.trim());
  const pattern = /<request_tool\b[^>]*>\s*([\s\S]*?)\s*<\/request_tool>/gi;
  const matches = [...normalized.matchAll(pattern)];
  if (matches.length === 0) {
    if (/<\/?request_tool\b/i.test(normalized)) {
      throw new Error("DeepSeek emitted malformed request_tool markup");
    }
    return undefined;
  }

  const last = matches[matches.length - 1]!;
  const lastEnd = (last.index ?? 0) + last[0].length;
  // Never execute a tool-looking example that is followed by ordinary prose.
  if (normalized.slice(lastEnd).trim()) return undefined;

  const terminalMatches = [last];
  let terminalStart = last.index ?? 0;
  for (let index = matches.length - 2; index >= 0; index -= 1) {
    const previous = matches[index]!;
    const previousEnd = (previous.index ?? 0) + previous[0].length;
    if (normalized.slice(previousEnd, terminalStart).trim()) break;
    terminalMatches.unshift(previous);
    terminalStart = previous.index ?? 0;
  }

  return terminalMatches.flatMap(match => {
    let body = (match[1] ?? "").trim();
    if (!body) throw new Error("DeepSeek emitted request_tool without a tool payload");
    // Some renderer builds put backslash-only line continuation markers around
    // the JSON body. Remove only decoration outside a top-level object/array;
    // never rewrite backslashes inside the payload itself.
    body = body.replace(/^\\+\s*(?=[{[])/, "");
    body = body.replace(/([}\]])\s*\\+$/, "$1");
    const payload = parseDeepSeekRenderedJson(body);
    if (payload === undefined) {
      throw new Error("DeepSeek request_tool payload must contain valid JSON");
    }
    const calls = Array.isArray(payload) ? payload : [payload];
    return calls.map(requestToolPayloadToCall);
  });
}

function parseDeepSeekDirectToolCallsPayload(text: string): unknown[] | undefined {
  const normalized = normalizeDeepSeekMarkupTags(text.trim());
  const openPattern = /<tool_calls>\s*/gi;
  const opens = [...normalized.matchAll(openPattern)];
  if (opens.length === 0) return undefined;

  const open = opens[opens.length - 1]!;
  const openIndex = open.index ?? 0;
  const prefix = normalized.slice(0, openIndex).trim();
  // This fallback exists for the same pre-action narration DeepSeek sometimes
  // prepends to a real tool request. Do not execute JSON examples embedded in
  // ordinary explanatory prose.
  if (prefix && !deepSeekResponseNeedsToolRecovery(prefix)) return undefined;

  let body = normalized.slice(openIndex + open[0].length).trim();
  const closed = body.match(/^([\s\S]*?)\s*<\/tool_calls>\s*$/i);
  if (closed) body = (closed[1] ?? "").trim();
  else if (/<\/tool_calls>/i.test(body)) return undefined;

  // Invoke/parameter markup has its own stricter parser below. This branch is
  // only for the JSON-shaped dialect DeepSeek currently emits directly inside
  // <tool_calls>.
  if (!body || /<(?:invoke|parameter|argument|arg)\b/i.test(body)) return undefined;

  let payload = parseDeepSeekRenderedJson(body);
  if (payload === undefined && /^\s*\{/.test(body) && /\]\s*$/.test(body)) {
    // One renderer revision drops the opening '[' from a tool-call array while
    // leaving its closing ']'. Restoring that single structural character is
    // unambiguous because the body already starts with an object and terminates
    // with the matching array close.
    payload = parseDeepSeekRenderedJson(`[${body}`);
  }
  if (payload === undefined) {
    if (/^\s*[\[{]/.test(body)) {
      throw new Error("DeepSeek tool_calls JSON payload must contain valid JSON");
    }
    return undefined;
  }

  const calls = Array.isArray(payload) ? payload : [payload];
  if (calls.length === 0) throw new Error("DeepSeek emitted tool_calls without any tool calls");
  return calls.map(requestToolPayloadToCall);
}

function schemaProperty(tool: CodexTool, name: string): Record<string, unknown> | undefined {
  const properties = isRecord(tool.parameters.properties) ? tool.parameters.properties : undefined;
  const property = properties?.[name];
  return isRecord(property) ? property : undefined;
}

function markupParameterValue(tool: CodexTool, name: string, text: string): unknown {
  const value = text.trim();
  const property = schemaProperty(tool, name);
  const type = property?.type;
  if (type === "integer" || type === "number") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || (type === "integer" && !Number.isInteger(parsed))) {
      throw new Error(`DeepSeek tool parameter ${name} must be a ${type}`);
    }
    return parsed;
  }
  if (type === "boolean") {
    if (value === "true") return true;
    if (value === "false") return false;
    throw new Error(`DeepSeek tool parameter ${name} must be a boolean`);
  }
  if (type === "object" || type === "array") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error(`DeepSeek tool parameter ${name} must contain valid JSON`);
    }
    if ((type === "object" && !isRecord(parsed)) || (type === "array" && !Array.isArray(parsed))) {
      throw new Error(`DeepSeek tool parameter ${name} must be a JSON ${type}`);
    }
    return parsed;
  }
  return value;
}

function resolveDeepSeekToolRequest(
  tools: CodexTool[],
  requestedName: string,
): { tool: CodexTool; wireName: string } | undefined {
  const normalizedName = requestedName.trim().replace(/\\+_/g, "_");
  const exact = tools.find(tool => namespacedToolName(tool.namespace, tool.name) === normalizedName);
  if (exact) return { tool: exact, wireName: namespacedToolName(exact.namespace, exact.name) };

  // Models use several conventional namespace separators even when the Codex
  // wire contract advertises `namespace__name`. Resolve only aliases that map
  // to exactly one active tool; this never widens the advertised tool set.
  const qualifiedMatches = tools.filter(tool => {
    if (!tool.namespace) return false;
    return [
      `${tool.namespace}.${tool.name}`,
      `${tool.namespace}/${tool.name}`,
      `${tool.namespace}::${tool.name}`,
    ].includes(normalizedName);
  });
  if (qualifiedMatches.length === 1) {
    const tool = qualifiedMatches[0]!;
    return { tool, wireName: namespacedToolName(tool.namespace, tool.name) };
  }

  // DeepSeek sometimes drops the namespace prefix from an otherwise valid
  // advertised tool name (for example `functions__exec_command` becomes
  // `exec_command`). Accept that compatibility spelling only when the base
  // name identifies exactly one active tool. Ambiguous names remain rejected.
  const baseMatches = tools.filter(tool => tool.name === normalizedName);
  if (baseMatches.length !== 1) return undefined;
  const tool = baseMatches[0]!;
  return { tool, wireName: namespacedToolName(tool.namespace, tool.name) };
}

function parseDeepSeekMarkupToolRequests(
  text: string,
  tools: CodexTool[],
): DeepSeekToolRequest[] | undefined {
  const normalized = normalizeDeepSeekTerminalToolCallsMarkup(text);
  // Compatibility mode accepts a terminal tool block even when DeepSeek
  // prepends ordinary assistant prose or an <aside>. The block still has to be
  // the final content in the response; embedded examples followed by prose are
  // never executed.
  const envelope = normalized.match(/<tool_calls>\s*([\s\S]*?)\s*<\/tool_calls>\s*$/i);
  if (!envelope) return undefined;

  const body = envelope[1] ?? "";
  const invokePattern = /<invoke\s+name\s*=\s*(["'])([^"']+)\1\s*>\s*([\s\S]*?)\s*<\/invoke>/gi;
  const requests: DeepSeekToolRequest[] = [];
  let bodyCursor = 0;
  for (const match of body.matchAll(invokePattern)) {
    const matchIndex = match.index ?? 0;
    if (body.slice(bodyCursor, matchIndex).trim()) {
      throw new Error("DeepSeek tool_calls markup contains unsupported content between invoke blocks");
    }
    bodyCursor = matchIndex + match[0].length;

    const requestedName = match[2]!;
    const resolved = resolveDeepSeekToolRequest(tools, requestedName);
    if (!resolved) {
      throw new Error(`DeepSeek requested a tool that the active Codex round did not advertise: ${requestedName}`);
    }
    const { tool, wireName } = resolved;

    const argsBody = match[3] ?? "";
    // DeepSeek's renderer sometimes annotates parameter tags with a boolean
    // `string` hint (for example `string="false"` on integer-valued fields).
    // The active Codex tool schema remains authoritative for coercion, so accept
    // only that known renderer annotation and continue parsing the body through
    // markupParameterValue. Unknown attributes still fail closed below.
    const parameterPattern = /<(parameter|argument|arg)\s+name\s*=\s*(["'])([^"']+)\2(?:\s+string\s*=\s*(["'])(?:true|false)\4)?\s*>([\s\S]*?)<\/\1>/gi;
    const args: Record<string, unknown> = {};
    let argsCursor = 0;
    for (const parameter of argsBody.matchAll(parameterPattern)) {
      const parameterIndex = parameter.index ?? 0;
      if (argsBody.slice(argsCursor, parameterIndex).trim()) {
        throw new Error(`DeepSeek tool request ${requestedName} contains unsupported parameter markup`);
      }
      argsCursor = parameterIndex + parameter[0].length;
      const parameterName = parameter[3]!;
      if (parameterName in args) {
        throw new Error(`DeepSeek tool request ${requestedName} repeated parameter ${parameterName}`);
      }
      args[parameterName] = markupParameterValue(tool, parameterName, parameter[5] ?? "");
    }
    if (argsBody.slice(argsCursor).trim()) {
      throw new Error(`DeepSeek tool request ${requestedName} contains unsupported parameter markup`);
    }
    requests.push({ name: wireName, arguments: args });
  }
  if (body.slice(bodyCursor).trim()) {
    throw new Error("DeepSeek tool_calls markup contains unsupported trailing content");
  }
  if (requests.length === 0) {
    throw new Error("DeepSeek emitted tool_calls markup without any tool calls");
  }
  return requests;
}

function parseDeepSeekDsmlMarkupToolRequests(
  text: string,
  tools: CodexTool[],
): DeepSeekToolRequest[] | undefined {
  const normalized = normalizeDeepSeekMarkupTags(text.trim());
  const hasDsmlInvoke = /<(?!\/)[^>\r\n]*DSML[^>\r\n]*?\binvoke\b/i.test(normalized);
  const hasDsmlToolCallsEnvelope = /<(?!\/)[^>\r\n]*DSML[^>\r\n]*?\btool_calls\b/i.test(normalized);
  const hasPlainInvoke = /<invoke\b/i.test(normalized);
  if (!hasDsmlInvoke && !(hasDsmlToolCallsEnvelope && hasPlainInvoke)) return undefined;
  return parseDeepSeekMarkupToolRequests(normalizeDeepSeekDsmlMarkupTags(normalized), tools);
}

function parseDeepSeekNamedDsmlMarkupToolRequests(
  text: string,
  tools: CodexTool[],
): DeepSeekToolRequest[] | undefined {
  const normalized = normalizeDeepSeekMarkupTags(text.trim());
  const tokenPattern = /<(\/?)\s*[^>\r\n]*DSML[^>\r\n]*>/gi;
  const tokens = [...normalized.matchAll(tokenPattern)];
  if (tokens.length === 0) return undefined;

  // A newer DeepSeek renderer emits its private DSML hierarchy without the
  // explicit `invoke` / `parameter` tag names used by older builds:
  //   <DSML tool_calls>
  //   <DSML name="functions__apply_patch">
  //   <DSML name="input">*** Begin Patch ...</DSML>
  //   </DSML>
  //   </DSML>
  // Treat only a terminal tool_calls hierarchy as executable. Generic DSML
  // closing sentinels are positional, so parse them with a tiny stack instead
  // of trying to rewrite them into XML with a regular expression.
  const envelopeTokenIndex = tokens.findLastIndex(token => {
    const closing = token[1] === "/";
    return !closing && /\btool(?:\\*_)+calls\b/i.test(token[0]);
  });
  if (envelopeTokenIndex < 0) return undefined;

  const envelopeToken = tokens[envelopeTokenIndex]!;
  const envelopeStart = envelopeToken.index ?? 0;
  const prefix = normalized.slice(0, envelopeStart).trim();
  const explicitToolRequestNarration = /\b(?:let me|i(?:'|’)ll|i will|i need to)\s+(?:now\s+)?request\s+(?:it|this|that|the\s+(?:tool|call|command|patch))\b/i;
  if (prefix && !deepSeekResponseNeedsToolRecovery(prefix) && !explicitToolRequestNarration.test(prefix)) return undefined;

  const suffixTokens = tokens.slice(envelopeTokenIndex);
  const hasNamedChild = suffixTokens.some(token => token[1] !== "/" && /\bname\s*=\s*(["'])[^"']+\1/i.test(token[0]));
  if (!hasNamedChild) return undefined;

  const isSpacing = (value: string): boolean => !value
    .replace(/(?:&#x20;|&nbsp;|\u00a0)/gi, "")
    .trim();
  const tagName = (tag: string): string | undefined => {
    const match = tag.match(/\bname\s*=\s*(["'])([^"']+)\1/i);
    return match?.[2]?.replace(/\\+_/g, "_");
  };

  type Frame =
    | { kind: "envelope" }
    | { kind: "tool"; requestedName: string; tool: CodexTool; wireName: string; arguments: Record<string, unknown> }
    | { kind: "parameter"; name: string; text: string };

  const stack: Frame[] = [];
  const requests: DeepSeekToolRequest[] = [];
  let cursor = envelopeStart;
  let closedEnvelope = false;

  for (const token of suffixTokens) {
    if (closedEnvelope) break;
    const tokenIndex = token.index ?? 0;
    const between = normalized.slice(cursor, tokenIndex);
    const top = stack.at(-1);
    if (top?.kind === "parameter") top.text += between;
    else if (stack.length > 0 && !isSpacing(between)) {
      throw new Error("DeepSeek DSML tool_calls markup contains unsupported content between tags");
    }

    const rawTag = token[0];
    const closing = token[1] === "/";
    cursor = tokenIndex + rawTag.length;

    if (!closing) {
      if (stack.length === 0) {
        if (!/\btool(?:\\*_)+calls\b/i.test(rawTag)) return undefined;
        stack.push({ kind: "envelope" });
        continue;
      }

      const name = tagName(rawTag);
      if (!name) {
        throw new Error("DeepSeek DSML tool_calls markup contains an unnamed opening tag");
      }
      const parent = stack.at(-1)!;
      if (parent.kind === "envelope") {
        const resolved = resolveDeepSeekToolRequest(tools, name);
        if (!resolved) {
          throw new Error(`DeepSeek requested a tool that the active Codex round did not advertise: ${name}`);
        }
        stack.push({
          kind: "tool",
          requestedName: name,
          tool: resolved.tool,
          wireName: resolved.wireName,
          arguments: {},
        });
        continue;
      }
      if (parent.kind === "tool") {
        if (name in parent.arguments) {
          throw new Error(`DeepSeek tool request ${parent.requestedName} repeated parameter ${name}`);
        }
        stack.push({ kind: "parameter", name, text: "" });
        continue;
      }
      throw new Error("DeepSeek DSML tool request contains nested parameter markup");
    }

    const frame = stack.pop();
    if (!frame) {
      throw new Error("DeepSeek DSML tool_calls markup contains an unmatched closing tag");
    }
    if (frame.kind === "parameter") {
      const toolFrame = stack.at(-1);
      if (toolFrame?.kind !== "tool") {
        throw new Error("DeepSeek DSML tool parameter closed outside a tool request");
      }
      toolFrame.arguments[frame.name] = markupParameterValue(toolFrame.tool, frame.name, frame.text);
      continue;
    }
    if (frame.kind === "tool") {
      requests.push({ name: frame.wireName, arguments: frame.arguments });
      continue;
    }

    closedEnvelope = true;
  }

  if (!closedEnvelope || stack.length !== 0) {
    throw new Error("DeepSeek emitted malformed name-only DSML tool_calls markup");
  }
  if (!isSpacing(normalized.slice(cursor))) {
    throw new Error("DeepSeek DSML tool_calls markup contains unsupported trailing content");
  }
  if (requests.length === 0) {
    throw new Error("DeepSeek emitted DSML tool_calls markup without any tool calls");
  }
  return requests;
}

export function deepSeekEffectiveTools(parsed: CodexParsedRequest): CodexTool[] {
  if (parsed._compactionRequest || parsed._localCompactionRequest) return [];
  const tools = parsed.context.tools ?? [];
  const choice = parsed.options.toolChoice;
  if (choice === "none") return [];
  if (typeof choice === "object" && choice !== null && "name" in choice) {
    const wireName = resolveToolChoiceWireName(tools, choice.name);
    return tools.filter(tool => namespacedToolName(tool.namespace, tool.name) === wireName);
  }
  if (isAllowedToolChoice(choice)) {
    const allowed = new Set(choice.allowedTools);
    return tools.filter(tool => toolAllowedByChoice(tool, allowed));
  }
  return tools;
}

export function deepSeekToolCallRequired(parsed: CodexParsedRequest): boolean {
  const choice = parsed.options.toolChoice;
  return choice === "required"
    || (isAllowedToolChoice(choice) && choice.mode === "required")
    || (typeof choice === "object" && choice !== null && "name" in choice);
}

function toolContract(tool: CodexTool): Record<string, unknown> {
  return {
    name: namespacedToolName(tool.namespace, tool.name),
    description: tool.description,
    arguments_schema: tool.parameters,
    ...(tool.freeform ? { freeform_input: true } : {}),
    ...(tool.toolSearch ? { tool_search: true } : {}),
  };
}

export function deepSeekToolInstructions(parsed: CodexParsedRequest): string | undefined {
  const tools = deepSeekEffectiveTools(parsed);
  if (tools.length === 0) return undefined;

  const required = deepSeekToolCallRequired(parsed);
  const maxCalls = parsed.options.parallelToolCalls === false ? 1 : DEEPSEEK_MAX_PARALLEL_TOOL_CALLS;
  const contracts = JSON.stringify(tools.map(toolContract));

  return [
    "Codex harness tools are available indirectly for this turn. You cannot execute them inside DeepSeek Web, but you CAN request them and Codex will execute them under the user's normal harness permissions.",
    "Tool availability never overrides safety policy, user authorization, sandboxing, or a real harness refusal. Respect those constraints and report an authoritative tool error instead of repeatedly requesting the same blocked action.",
    "For repository/file/build/debug tasks, prefer using the tools to inspect and act instead of asking the user for facts that the tools can discover.",
    "When the user asks you to change, build, fix, test, inspect, or otherwise perform work, keep working until the requested outcome is implemented and verified when practical. A plan or a list of questions is not completion.",
    "For a tool-capable coding turn, do not narrate your analysis, plan, or intended next step. Either request the needed Codex tool immediately, or give a concise final answer when no tool is needed.",
    "On Windows, PowerShell commands are supported by the Codex harness. Use normal PowerShell syntax when it is useful; the bridge may encode PowerShell-sensitive command text internally to preserve it exactly, so do not avoid PowerShell merely because the transport rewrites the command.",
    "Do not replace a tool request with progress prose such as 'I need to inspect...', 'we should check...', 'first I will...', or a long explanation of what you are about to do.",
    "Never end a response by saying you will check, inspect, run, create, edit, build, test, or continue work next. If that action needs a Codex tool, request the tool in that same response instead of narrating the future action.",
    "Do not ask a clarifying question when a reasonable local assumption, harmless default, or read-only tool inspection can resolve it. Ask only when missing information would materially change the result or require authority the user has not granted.",
    "Never claim a command ran, a file changed, or a test passed until a tool result in the serialized history confirms it.",
    `Available tools (call names and JSON argument schemas): ${contracts}`,
    `When a tool is needed, your ENTIRE response must be exactly one JSON object with this shape and no Markdown fence or prose: {"${DEEPSEEK_TOOL_CALL_KEY}":[{"name":"EXACT_TOOL_NAME","arguments":{}}]}`,
    "Do not use <tool_calls>, <invoke>, <parameter>, XML, or ChatGPT-internal tool markup. The JSON envelope above is the only preferred tool-request format.",
    "Use the exact advertised tool name. Put freeform/custom tool input in arguments.input. Use only argument fields allowed by the advertised schema.",
    "When using apply_patch to add a file, every file-content line must begin with +, including blank lines (a blank added line is a line containing only +).",
    "Never pre-write later tool calls that depend on the result of an earlier call. Request only calls that are executable from the current state; group calls only when they are independent.",
    `Request at most ${maxCalls} tool call${maxCalls === 1 ? "" : "s"} in one response. Independent calls may be grouped when parallel calls are allowed.`,
    required
      ? "The active Codex tool choice requires a tool call before a final answer."
      : "If no tool is needed, answer the user normally and do not emit the tool-call JSON envelope.",
    parsed._structuredOutput
      ? "The tool-call envelope is the only exception to the requested final structured-output format. After tool results return and no more tools are needed, produce the requested final JSON value."
      : "After tool results return, continue the task; request more tools if needed, otherwise give the final answer.",
  ].join("\n");
}

/**
 * DeepSeek occasionally acknowledges the bridge instructions but still ends a
 * turn with pre-action planning such as "Let me check the workspace first" or
 * "We need to inspect the repo." No tool call exists in that response, so
 * surfacing it as a completed Codex turn strands the task. Keep detection tied
 * to future/planning language so ordinary explanatory prose remains valid.
 */
export type DeepSeekResponseRecoveryReason =
  | "tool_protocol"
  | "capability_refusal"
  | "narration"
  | "required_tool";

function deepSeekTerminalToolIntent(text: string): boolean {
  const normalized = normalizeDeepSeekMarkupTags(text.trim());
  if (!normalized) return false;

  const preferredJsonKey = /codex(?:\\*_)+tool(?:\\*_)+calls/i.test(normalized);
  if (preferredJsonKey && normalized.startsWith("{")) return true;

  const standardToolOpen = /<tool_calls>\s*/i.test(normalized);
  const dsmlToolOpen = /<(?!\/)[^>\r\n]*DSML[^>\r\n]*\btool_calls/i.test(normalized);
  const requestToolOpen = /<request_tool\b/i.test(normalized);
  const terminalMarkup = /(?:<\/tool_calls>|<\/request_tool>|<\/invoke>|<\/[^<>\r\n]*DSML[^<>\r\n]*(?:>|$))\s*$/i
    .test(normalized);
  if ((standardToolOpen || dsmlToolOpen || requestToolOpen) && terminalMarkup) return true;

  // A response containing only the start of an explicit tool block is also a
  // protocol attempt, not a useful final answer. With a prose prefix, require
  // the same short pre-action language used by narration recovery below.
  return (standardToolOpen || dsmlToolOpen || requestToolOpen)
    && normalized.search(/<(?:tool_calls|request_tool)\b/i) === 0;
}

export function deepSeekResponseRecoveryReason(
  text: string,
): DeepSeekResponseRecoveryReason | undefined {
  if (deepSeekTerminalToolIntent(text)) return "tool_protocol";

  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;

  const tail = normalized.slice(-1_600);
  const head = normalized.slice(0, 1_600);
  const capabilityWindow = normalized.length <= 4_000 ? normalized : `${head} ${tail}`;
  const unavailableCapability = /\b(?:i|we)\s+(?:(?:do not|don't|cannot|can't)\s+(?:have\s+)?|(?:am|are|'m|'re)\s+unable\s+to\s+(?:access|use)\s+|have\s+no\s+)(?:direct\s+)?(?:access\s+to\s+)?(?:the\s+)?(?:codex\s+)?(?:tools?|filesystem|files?|workspace|repository|terminal|shell|commands?|local environment)\b/i;
  const unableToAct = /\b(?:(?:i|we)\s+(?:cannot|can't)|(?:i(?:'|’)m|i am|we(?:'|’)re|we are)\s+unable\s+to)\s+(?:directly\s+)?(?:access|inspect|read|open|run|execute|edit|modify|patch|write|create|save)\b[^.!?]{0,120}\b(?:files?|filesystem|workspace|repository|terminal|shell|commands?|tools?|local environment)\b/i;
  const toolsUnavailable = /^(?:i(?:'|’)m sorry[,;:]?\s+)?(?:the\s+)?(?:codex\s+)?(?:tools?|filesystem|terminal|shell)\s+(?:is|are|seem)\s+(?:not\s+available|unavailable|inaccessible)\b/i;
  const manualDeflection = /\bplease\s+(?:run|execute|apply|make|edit)\b[^.!?]{0,100}\b(?:yourself|manually|on your (?:machine|system))\b/i;
  const instructionsOnly = /\bi can only (?:provide|offer) (?:instructions|guidance|code)\b[^.!?]{0,100}\bnot\s+(?:run|execute|apply|make|edit|modify|perform)\b/i;
  // Do not pressure a policy/authorization refusal or reinterpret a real tool
  // error/quoted example as a false capability claim. Those are legitimate
  // final states even when local tools exist.
  const policyOrEvidence = /\b(?:safety\s+policy|policy\s+(?:does not|doesn't|prevents|prohibits)|security\s+reasons?|not\s+authori[sz]ed|without\s+authori[sz]ation|permission\s+denied|access\s+denied|command\s+failed|tool\s+result|for\s+example|quoted\s+(?:text|phrase)|the\s+(?:error|message|model|response)\s+(?:says|said|reported))\b/i;
  if (!policyOrEvidence.test(capabilityWindow) && (unavailableCapability.test(capabilityWindow)
    || unableToAct.test(capabilityWindow)
    || toolsUnavailable.test(capabilityWindow)
    || manualDeflection.test(capabilityWindow)
    || instructionsOnly.test(capabilityWindow))) {
    return "capability_refusal";
  }

  const action = "(?:check|inspect|scan|search|look\\s+(?:at|through|for)|read|open|run|execute|test|verify|build|create|set\\s*up|edit|modify|patch|fix|implement|write|save|generate|review|investigate|continue|clean(?:\\s+(?:it|this|that))?\\s+up|use\\s+(?:the\\s+)?(?:tool|terminal|shell|command|apply_patch))";
  const explicitFuture = new RegExp(
    `\\b(?:let me|i(?:'|’)ll|i will|i need to|i should|i(?:'|’)m going to|i am going to|we need to|we should|we(?:'|’)ll|we will)\\s+(?:now\\s+)?(?:first\\s+)?(?:continue\\s+)?${action}\\b`,
    "i",
  );
  if (explicitFuture.test(head) || explicitFuture.test(tail)) return "narration";

  const activePresent = /\b(?:i(?:'|’)m|i am|we(?:'|’)re|we are)\s+(?:currently\s+)?(?:checking|inspecting|scanning|searching|reading|running|testing|verifying|building|editing|modifying|patching|fixing|implementing|writing|reviewing|investigating|continuing)\b/i;
  if (activePresent.test(head) || activePresent.test(tail)) return "narration";

  // DeepSeek sometimes emits terse scratchpad-like planning without a subject,
  // e.g. "Need to inspect the repo first" or "First, check package.json".
  // Limit this compatibility case to the beginning/end of the response so an
  // ordinary explanation that merely mentions such a workflow stays final.
  const planningEdge = new RegExp(
    `(?:^|[.!?]\\s+)(?:(?:next|first)[,;:]?\\s+(?:(?:need to|must|going to)\\s+)?|(?:need to|must|going to)\\s+)${action}\\b`,
    "i",
  );
  return planningEdge.test(normalized.slice(0, 500)) || planningEdge.test(tail)
    ? "narration"
    : undefined;
}

export function deepSeekResponseNeedsToolRecovery(text: string): boolean {
  return deepSeekResponseRecoveryReason(text) !== undefined;
}

export function deepSeekToolRecoveryPrompt(
  parsed: CodexParsedRequest,
  reason: DeepSeekResponseRecoveryReason = "narration",
): string {
  const toolInstructions = deepSeekToolInstructions(parsed);
  const diagnosis = reason === "tool_protocol"
    ? "Your immediately preceding response attempted a Codex tool call, but its transport envelope was malformed or could not be validated, so Codex did not execute it."
    : reason === "capability_refusal"
      ? "Your immediately preceding response incorrectly claimed that local tools were unavailable. Codex has advertised indirect tools for this turn and will execute a valid request under the user's normal permissions."
      : reason === "required_tool"
        ? "The active Codex tool choice requires a valid tool call, but your immediately preceding response did not request one."
        : "Your immediately preceding response was planning/progress narration instead of a Codex tool request, so Codex could not perform the work you described.";
  const blocks = [
    diagnosis,
    "Continue the same task now with no analysis, plan, or preamble. Finish the actual requested work in this response instead of describing what you will do next.",
  ];
  if (toolInstructions) {
    blocks.push(
      "If workspace, command, file, build, test, or other tool work is needed, emit the required tool-request JSON in this response.",
      `<codex_bridge_protocol>\n${toolInstructions}\n</codex_bridge_protocol>`,
    );
  } else {
    blocks.push(
      "No Codex tool is active for this turn. Do not promise to create, edit, run, build, test, save, or inspect something later. Provide the complete useful result directly in the response when possible; otherwise state the concrete tooling limitation now.",
    );
  }
  return blocks.join("\n\n");
}

function stripWholeJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i);
  return fenced ? fenced[1]!.trim() : trimmed;
}

function isPreferredDeepSeekToolEnvelope(value: unknown): boolean {
  const normalized = normalizeDeepSeekDsmlObjectKeys(value);
  return isRecord(normalized)
    && DEEPSEEK_TOOL_CALL_KEY in normalized
    && Object.keys(normalized).length === 1;
}

function parseDeepSeekProsePrefixedFencedToolPayload(text: string): unknown | undefined {
  const trimmed = text.trim();
  const fencePattern = /```(?:json)?[^\S\r\n]*\r?\n([\s\S]*?)\r?\n```/gi;
  const matches = [...trimmed.matchAll(fencePattern)];
  if (matches.length === 0) return undefined;

  const first = matches[0]!;
  const prefix = trimmed.slice(0, first.index ?? 0).trim();
  // A prose-prefixed fenced envelope is a compatibility recovery for the same
  // short "I'll check/build/run ..." pre-action narration handled elsewhere.
  // Do not turn ordinary explanations containing JSON examples into tool calls.
  if (prefix && !deepSeekResponseNeedsToolRecovery(prefix)) return undefined;

  const payloads: unknown[] = [];
  let cursor = first.index ?? 0;
  for (const match of matches) {
    const index = match.index ?? 0;
    if (index < cursor || trimmed.slice(cursor, index).trim()) return undefined;
    const payload = parseDeepSeekRenderedJson(match[1] ?? "");
    if (payload === undefined || !isPreferredDeepSeekToolEnvelope(payload)) return undefined;
    payloads.push(payload);
    cursor = index + match[0].length;
  }
  if (trimmed.slice(cursor).trim()) return undefined;

  // DeepSeek sometimes renders an entire planned sequence as separate JSON
  // fences even though later calls depend on earlier results. Only the first
  // envelope belongs to the current round; Codex returns its real result before
  // DeepSeek is allowed to decide what should happen next.
  return payloads[0];
}

function parseDeepSeekProsePrefixedJsonToolPayload(text: string): unknown | undefined {
  const trimmed = text.trim();
  const starts = new Set<number>();
  if (trimmed.startsWith("{")) starts.add(0);
  for (const match of trimmed.matchAll(/[\r\n][ \t]*\{/g)) {
    const braceOffset = match[0].lastIndexOf("{");
    starts.add((match.index ?? 0) + braceOffset);
  }

  // A common DeepSeek renderer failure is a short planning sentence followed
  // by an otherwise perfect raw Codex JSON envelope. Recover that terminal
  // envelope without accepting arbitrary JSON examples embedded in prose.
  for (const start of [...starts].sort((a, b) => b - a)) {
    const payload = parseDeepSeekRenderedJson(trimmed.slice(start));
    if (!isPreferredDeepSeekToolEnvelope(payload)) continue;
    const prefix = trimmed.slice(0, start).trim();
    if (!prefix || deepSeekResponseNeedsToolRecovery(prefix)) return payload;
  }
  return undefined;
}

export function parseDeepSeekToolRequests(
  text: string,
  parsed: CodexParsedRequest,
): DeepSeekToolRequest[] | undefined {
  const tools = deepSeekEffectiveTools(parsed);
  if (tools.length === 0) return undefined;

  let payload = parseDeepSeekRenderedJson(text);
  if (payload === undefined) payload = parseDeepSeekProsePrefixedFencedToolPayload(text);
  if (payload === undefined) payload = parseDeepSeekProsePrefixedJsonToolPayload(text);
  if (payload === undefined) {
    const directToolCalls = parseDeepSeekDirectToolCallsPayload(text);
    if (directToolCalls) {
      payload = { [DEEPSEEK_TOOL_CALL_KEY]: directToolCalls };
    } else {
      const dsmlMarkupRequests = parseDeepSeekDsmlMarkupToolRequests(text, tools);
      if (dsmlMarkupRequests) {
        if (parsed.options.parallelToolCalls === false && dsmlMarkupRequests.length > 1) {
          throw new Error("DeepSeek requested parallel tools even though this Codex turn disabled parallel tool calls");
        }
        if (dsmlMarkupRequests.length > DEEPSEEK_MAX_PARALLEL_TOOL_CALLS) {
          throw new Error(`DeepSeek requested more than ${DEEPSEEK_MAX_PARALLEL_TOOL_CALLS} tools in one batch`);
        }
        return normalizeDeepSeekHarnessToolRequests(dsmlMarkupRequests, tools);
      }
      const namedDsmlMarkupRequests = parseDeepSeekNamedDsmlMarkupToolRequests(text, tools);
      if (namedDsmlMarkupRequests) {
        if (parsed.options.parallelToolCalls === false && namedDsmlMarkupRequests.length > 1) {
          throw new Error("DeepSeek requested parallel tools even though this Codex turn disabled parallel tool calls");
        }
        if (namedDsmlMarkupRequests.length > DEEPSEEK_MAX_PARALLEL_TOOL_CALLS) {
          throw new Error(`DeepSeek requested more than ${DEEPSEEK_MAX_PARALLEL_TOOL_CALLS} tools in one batch`);
        }
        return normalizeDeepSeekHarnessToolRequests(namedDsmlMarkupRequests, tools);
      }
      const dsmlCalls = parseDeepSeekDsmlToolPayload(text);
      if (dsmlCalls) {
        payload = { [DEEPSEEK_TOOL_CALL_KEY]: dsmlCalls };
      } else {
        const requestToolCalls = parseDeepSeekRequestToolPayload(text);
        if (requestToolCalls) {
          payload = { [DEEPSEEK_TOOL_CALL_KEY]: requestToolCalls };
        } else {
          const markupRequests = parseDeepSeekMarkupToolRequests(text, tools);
          if (!markupRequests) return undefined;
          if (parsed.options.parallelToolCalls === false && markupRequests.length > 1) {
            throw new Error("DeepSeek requested parallel tools even though this Codex turn disabled parallel tool calls");
          }
          if (markupRequests.length > DEEPSEEK_MAX_PARALLEL_TOOL_CALLS) {
            throw new Error(`DeepSeek requested more than ${DEEPSEEK_MAX_PARALLEL_TOOL_CALLS} tools in one batch`);
          }
          return normalizeDeepSeekHarnessToolRequests(markupRequests, tools);
        }
        if (parsed.options.parallelToolCalls === false && requestToolCalls!.length > 1) {
          throw new Error("DeepSeek requested parallel tools even though this Codex turn disabled parallel tool calls");
        }
        if (requestToolCalls!.length > DEEPSEEK_MAX_PARALLEL_TOOL_CALLS) {
          throw new Error(`DeepSeek requested more than ${DEEPSEEK_MAX_PARALLEL_TOOL_CALLS} tools in one batch`);
        }
      }
    }
  }
  payload = normalizeDeepSeekDsmlObjectKeys(payload);
  if (!isRecord(payload) || !(DEEPSEEK_TOOL_CALL_KEY in payload)) return undefined;
  if (Object.keys(payload).length !== 1) {
    throw new Error(`DeepSeek ${DEEPSEEK_TOOL_CALL_KEY} envelope must not contain extra fields`);
  }

  const rawCallsValue = payload[DEEPSEEK_TOOL_CALL_KEY];
  const rawCalls = Array.isArray(rawCallsValue)
    ? rawCallsValue
    : isRecord(rawCallsValue) ? [rawCallsValue] : undefined;
  if (!rawCalls || rawCalls.length === 0) {
    throw new Error(`DeepSeek emitted ${DEEPSEEK_TOOL_CALL_KEY} without any tool calls`);
  }
  if (parsed.options.parallelToolCalls === false && rawCalls.length > 1) {
    throw new Error("DeepSeek requested parallel tools even though this Codex turn disabled parallel tool calls");
  }
  if (rawCalls.length > DEEPSEEK_MAX_PARALLEL_TOOL_CALLS) {
    throw new Error(`DeepSeek requested more than ${DEEPSEEK_MAX_PARALLEL_TOOL_CALLS} tools in one batch`);
  }

  return normalizeDeepSeekHarnessToolRequests(rawCalls.map((raw, index) => {
    // DeepSeek occasionally emits the preferred codex_tool_calls envelope but
    // flattens a tool's arguments beside `name`, matching its request_tool
    // renderer dialect. Canonicalize both shapes at this shared boundary so a
    // valid advertised call is not rejected solely because the renderer moved
    // the arguments out of their container.
    const normalizedRaw = requestToolPayloadToCall(raw);
    if (!isRecord(normalizedRaw) || typeof normalizedRaw.name !== "string" || !normalizedRaw.name) {
      throw new Error(`DeepSeek tool request ${index + 1} is missing an exact tool name`);
    }
    const resolved = resolveDeepSeekToolRequest(tools, normalizedRaw.name);
    if (!resolved) {
      throw new Error(`DeepSeek requested a tool that the active Codex round did not advertise: ${normalizedRaw.name}`);
    }
    let argumentsValue = normalizedRaw.arguments;
    if (typeof argumentsValue === "string") {
      argumentsValue = parseDeepSeekRenderedJson(argumentsValue);
    }
    if (!isRecord(argumentsValue)) {
      throw new Error(`DeepSeek tool request ${normalizedRaw.name} must provide a JSON object in arguments`);
    }
    return { name: resolved.wireName, arguments: argumentsValue };
  }), tools);
}

export class DeepSeekToolProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DeepSeekToolProtocolError";
  }
}

export interface DeepSeekToolParseOutcome {
  requests?: DeepSeekToolRequest[];
  protocolError?: DeepSeekToolProtocolError;
}

/**
 * Raw DOM serialization is normally authoritative, but renderer migrations can
 * damage it while the Markdown representation remains parseable (or vice
 * versa). Try both unique representations before asking DeepSeek to correct a
 * model-authored protocol error. Unexpected implementation errors still escape.
 */
export function parseDeepSeekToolResponseCandidates(
  texts: readonly string[],
  parsed: CodexParsedRequest,
): DeepSeekToolParseOutcome {
  const seen = new Set<string>();
  let protocolError: DeepSeekToolProtocolError | undefined;

  for (const text of texts) {
    if (!text || seen.has(text)) continue;
    seen.add(text);
    try {
      const requests = parseDeepSeekToolRequests(text, parsed);
      if (requests) return { requests };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/^DeepSeek\b/.test(message)) throw error;
      protocolError ??= new DeepSeekToolProtocolError(message, error instanceof Error ? { cause: error } : undefined);
    }
  }

  if (!protocolError) {
    const malformed = [...seen].some(text => deepSeekResponseRecoveryReason(text) === "tool_protocol");
    if (malformed) {
      protocolError = new DeepSeekToolProtocolError(
        "DeepSeek emitted a terminal tool request whose transport envelope was malformed",
      );
    }
  }
  return { ...(protocolError ? { protocolError } : {}) };
}
