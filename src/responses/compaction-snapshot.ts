// V15.1 local compaction archive.
// Compaction is deterministic local bookkeeping, not a second ChatGPT browser turn.
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getConfigDir } from "../config";
import { isLocalCompactionPromptItem } from "./compaction";

export const BRIDGE_COMPACTION_READ_WIRE = "__bridge_read_compaction";
export const LOCAL_COMPACTION_MARKER = "[CODEX_BRIDGE_LOCAL_COMPACTION";
const SNAPSHOT_ID_RE = /^[a-f0-9]{32}$/;
const RECENT_TAIL_CHARS = 32_000;
const DEFAULT_READ_CHARS = 40_000;
const MAX_READ_CHARS = 100_000;
const MAX_ARCHIVED_STRING_CHARS = 256_000;
const MAX_HANDOFF_STRING_CHARS = 6_000;
const MAX_HANDOFF_INPUT_ITEMS = 24;
const MAX_ACTIVE_REQUEST_CHARS = 8_000;
const MAX_REQUEST_ANCHORS = 3;
const MAX_REQUEST_ANCHOR_CHARS = 4_000;
const MAX_ASSISTANT_STATE_CHARS = 6_000;
const MAX_BOUNDARY_CONTEXT_ITEMS = 2;
const MAX_BOUNDARY_CONTEXT_CHARS = 3_000;

export interface LocalCompactionSnapshot {
  snapshotId: string;
  manifest: string;
  archivedChars: number;
  recentChars: number;
}

export interface LocalCompactionReadArgs {
  snapshotId: string;
  query?: string;
  offset?: number;
  maxChars?: number;
}

function compactionDirectory(): string {
  return path.join(getConfigDir(), "compactions");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeString(value: string, key?: string): string {
  if (value.startsWith("data:") && value.includes(";base64,")) {
    return `[binary data URL omitted from text archive; chars=${value.length}]`;
  }
  if (key && /(?:image|attachment|file)_?(?:url|data|bytes)?/i.test(key) && value.length > 250_000) {
    return `[large ${key} payload omitted from text archive; chars=${value.length}]`;
  }
  if (value.length > MAX_ARCHIVED_STRING_CHARS) {
    const marker = `\n...[oversized text payload compacted locally; original_chars=${value.length}]...\n`;
    const retained = MAX_ARCHIVED_STRING_CHARS - marker.length;
    const head = Math.floor(retained / 2);
    const tail = retained - head;
    return value.slice(0, head) + marker + value.slice(-tail);
  }
  return value;
}

function sanitizeForSnapshot(value: unknown, key?: string, depth = 0): unknown {
  if (depth > 100) return "[snapshot depth limit]";
  if (typeof value === "string") return sanitizeString(value, key);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    return value
      .filter(item => !(isRecord(item) && item.type === "compaction_trigger"))
      .map(item => sanitizeForSnapshot(item, undefined, depth + 1));
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      if (childKey === "tools" || childKey === "tool_choice" || childKey === "parallel_tool_calls") continue;
      out[childKey] = sanitizeForSnapshot(childValue, childKey, depth + 1);
    }
    return out;
  }
  if (value === undefined) return undefined;
  return String(value);
}

function sanitizeForHandoff(value: unknown, key?: string, depth = 0): unknown {
  if (depth > 50) return "[handoff depth limit]";
  if (typeof value === "string") {
    const sanitized = sanitizeString(value, key);
    if (sanitized.length <= MAX_HANDOFF_STRING_CHARS) return sanitized;
    const marker = `\n...[handoff field shortened; original_chars=${sanitized.length}]...\n`;
    const retained = MAX_HANDOFF_STRING_CHARS - marker.length;
    const head = Math.floor(retained / 2);
    const tail = retained - head;
    return sanitized.slice(0, head) + marker + sanitized.slice(-tail);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.map(item => sanitizeForHandoff(item, undefined, depth + 1));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      if (childKey === "tools" || childKey === "tool_choice" || childKey === "parallel_tool_calls") continue;
      out[childKey] = sanitizeForHandoff(childValue, childKey, depth + 1);
    }
    return out;
  }
  if (value === undefined) return undefined;
  return String(value);
}

function userMessageTextParts(value: unknown): string[] {
  const item = isRecord(value) ? value : undefined;
  if (!item || item.type !== "message" || item.role !== "user" || !Array.isArray(item.content)) return [];
  return item.content.flatMap(part => {
    const text = isRecord(part) ? part.text : undefined;
    return typeof text === "string" ? [text] : [];
  });
}

function assistantMessageTextParts(value: unknown): string[] {
  const item = isRecord(value) ? value : undefined;
  if (!item || item.type !== "message" || item.role !== "assistant") return [];
  if (typeof item.content === "string") return item.content ? [item.content] : [];
  if (!Array.isArray(item.content)) return [];
  return item.content.flatMap(part => {
    if (!isRecord(part)) return [];
    // Preserve only public assistant prose. Reasoning/thinking payloads are
    // deliberately excluded from browser-to-browser continuation state.
    if (part.type !== "output_text" && part.type !== "text") return [];
    return typeof part.text === "string" ? [part.text] : [];
  });
}

function isCodexContextUserItem(value: unknown): boolean {
  const item = isRecord(value) ? value : undefined;
  if (!item || item.type !== "message" || item.role !== "user") return false;
  const passthrough = isRecord(item.internal_chat_message_metadata_passthrough)
    ? item.internal_chat_message_metadata_passthrough
    : undefined;
  const kinds = Array.isArray(passthrough?.content_item_kinds) ? passthrough.content_item_kinds : [];
  if (kinds.some(kind => kind === "environments.environment_context")) return true;
  const texts = userMessageTextParts(item).map(text => text.trim()).filter(Boolean);
  return texts.length > 0 && texts.every(text => (
    /^<environment_context>[\s\S]*<\/environment_context>$/i.test(text)
    || /^<skill>[\s\S]*<\/skill>$/i.test(text)
  ));
}

function latestActiveUserItemIndex(sourceInput: unknown[]): number | null {
  for (let index = sourceInput.length - 1; index >= 0; index--) {
    const candidate = sourceInput[index];
    if (!isRecord(candidate) || candidate.type !== "message" || candidate.role !== "user") continue;
    const item: Record<string, unknown> = candidate;
    const metadata = isRecord(item.metadata) ? item.metadata : undefined;
    if (metadata?.client_authored === false || isCodexContextUserItem(item)) continue;
    return index;
  }
  return null;
}

function isRealUserRequestItem(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || value.type !== "message" || value.role !== "user") return false;
  const metadata = isRecord(value.metadata) ? value.metadata : undefined;
  return metadata?.client_authored !== false && !isCodexContextUserItem(value);
}

function requestAnchorText(value: unknown, maxChars: number, label: string): string {
  const texts = userMessageTextParts(value);
  const joined = texts.join("\n\n");
  const raw = joined || JSON.stringify(sanitizeForHandoff(value));
  if (raw.length <= maxChars) return raw;
  const marker = `\n...[${label} shortened; original_chars=${raw.length}]...\n`;
  const retained = Math.max(0, maxChars - marker.length);
  const head = Math.floor(retained / 2);
  const tail = retained - head;
  return raw.slice(0, head) + marker + raw.slice(-tail);
}

function omittedRequestAnchors(sourceInput: unknown[], retainedItems: number): Array<{ index: number; text: string }> {
  const cutoff = Math.max(0, sourceInput.length - retainedItems);
  const anchors: Array<{ index: number; text: string }> = [];
  for (let index = 0; index < cutoff; index++) {
    const item = sourceInput[index];
    if (!isRealUserRequestItem(item)) continue;
    anchors.push({ index, text: requestAnchorText(item, MAX_REQUEST_ANCHOR_CHARS, "request anchor") });
  }
  if (anchors.length <= MAX_REQUEST_ANCHORS) return anchors;
  // The first real request is the task's semantic root. Preserve it even after
  // many later status nudges or steering messages, then spend the remaining
  // small manifest budget on the newest omitted user instructions.
  return [anchors[0]!, ...anchors.slice(-(MAX_REQUEST_ANCHORS - 1))];
}

function activeRequestAnchor(sourceInput: unknown[], retainedItems: number): Record<string, unknown> | undefined {
  const index = latestActiveUserItemIndex(sourceInput);
  if (index === null || index >= Math.max(0, sourceInput.length - retainedItems)) return undefined;
  return { index, text: requestAnchorText(sourceInput[index], MAX_ACTIVE_REQUEST_CHARS, "active request") };
}

function latestOmittedAssistantState(sourceInput: unknown[], retainedItems: number): Record<string, unknown> | undefined {
  const cutoff = Math.max(0, sourceInput.length - retainedItems);
  for (let index = cutoff - 1; index >= 0; index--) {
    const texts = assistantMessageTextParts(sourceInput[index]).map(text => text.trim()).filter(Boolean);
    if (texts.length === 0) continue;
    const raw = texts.join("\n\n");
    if (raw.length <= MAX_ASSISTANT_STATE_CHARS) return { index, text: raw };
    const marker = `\n...[assistant state shortened; original_chars=${raw.length}]...\n`;
    const retained = Math.max(0, MAX_ASSISTANT_STATE_CHARS - marker.length);
    const head = Math.floor(retained / 2);
    const tail = retained - head;
    return { index, text: raw.slice(0, head) + marker + raw.slice(-tail) };
  }
  return undefined;
}

function boundaryContextExcerpt(value: unknown): string {
  const serialized = JSON.stringify(sanitizeForHandoff(value));
  if (serialized.length <= MAX_BOUNDARY_CONTEXT_CHARS) return serialized;
  const marker = `\n...[boundary context shortened; original_chars=${serialized.length}]...\n`;
  const retained = Math.max(0, MAX_BOUNDARY_CONTEXT_CHARS - marker.length);
  const head = Math.floor(retained / 2);
  const tail = retained - head;
  return serialized.slice(0, head) + marker + serialized.slice(-tail);
}

function omittedBoundaryContext(sourceInput: unknown[], retainedItems: number): Array<Record<string, unknown>> {
  const cutoff = Math.max(0, sourceInput.length - retainedItems);
  const boundary: Array<Record<string, unknown>> = [];
  for (let index = cutoff - 1; index >= 0 && boundary.length < MAX_BOUNDARY_CONTEXT_ITEMS; index--) {
    const item = sourceInput[index];
    if (!isRecord(item)) continue;
    // Real user-authored items are already represented by request_anchors and
    // active_request. Injected user context is intentionally not promoted into
    // the browser-to-browser continuation state.
    if (item.type === "message" && item.role === "user") continue;
    const type = typeof item.type === "string" ? item.type : "unknown";
    if (type !== "message"
      && type !== "function_call"
      && type !== "custom_tool_call"
      && type !== "function_call_output"
      && type !== "custom_tool_call_output") continue;
    boundary.unshift({
      index,
      type,
      ...(typeof item.role === "string" ? { role: item.role } : {}),
      ...(typeof item.call_id === "string" ? { call_id: item.call_id } : {}),
      ...(typeof item.name === "string" ? { name: item.name } : {}),
      excerpt: boundaryContextExcerpt(item),
    });
  }
  return boundary;
}

function recentContinuationMetadata(sourceInput: unknown[], retainedItems: number): Record<string, unknown> {
  let latestUserItemIndex: number | null = null;
  let latestAssistantItemIndex: number | null = null;
  let latestToolResultItemIndex: number | null = null;
  for (let index = 0; index < sourceInput.length; index++) {
    const item = isRecord(sourceInput[index]) ? sourceInput[index] as Record<string, unknown> : undefined;
    if (!item) continue;
    if (item.type === "message" && item.role === "user") latestUserItemIndex = index;
    if (item.type === "message" && item.role === "assistant") latestAssistantItemIndex = index;
    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") latestToolResultItemIndex = index;
  }
  return {
    order: "oldest_to_newest",
    recent_input_start_index: Math.max(0, sourceInput.length - retainedItems),
    latest_user_item_index: latestUserItemIndex,
    active_user_item_index: latestActiveUserItemIndex(sourceInput),
    latest_assistant_item_index: latestAssistantItemIndex,
    latest_tool_result_item_index: latestToolResultItemIndex,
    resume_rule: "Continue the same task. request_anchors are older real user-authored instructions or steering evicted from recent_input; when many were omitted, the first task-defining request is preserved alongside the newest steering. Apply anchors oldest-to-newest. If active_request is present, it is the latest real user goal anchor because that item was also evicted. assistant_state is the latest omitted public assistant progress and should be treated as already-completed or active work, not a new instruction. boundary_context contains the last omitted assistant/tool state immediately before recent_input. Use recent_input for the newest progress. A fresh browser window is a transport handoff, not a new task; do not restart completed work or ask the user to restate preserved context.",
  };
}

function structuredHandoffPayload(payload: Record<string, unknown>, sourceInput: unknown[], recentInput: unknown[]): Record<string, unknown> {
  const anchor = activeRequestAnchor(sourceInput, recentInput.length);
  const requestAnchors = omittedRequestAnchors(sourceInput, recentInput.length);
  const assistantState = latestOmittedAssistantState(sourceInput, recentInput.length);
  const boundaryContext = omittedBoundaryContext(sourceInput, recentInput.length);
  return {
    model: sanitizeForHandoff(payload.model, "model"),
    previous_response_id: sanitizeForHandoff(payload.previous_response_id, "previous_response_id"),
    input_count: sourceInput.length,
    omitted_input_items: Math.max(0, sourceInput.length - recentInput.length),
    continuation: recentContinuationMetadata(sourceInput, recentInput.length),
    ...(requestAnchors.length > 0 ? { request_anchors: requestAnchors } : {}),
    ...(anchor ? { active_request: anchor } : {}),
    ...(assistantState ? { assistant_state: assistantState } : {}),
    ...(boundaryContext.length > 0 ? { boundary_context: boundaryContext } : {}),
    recent_input: recentInput,
  };
}

function structuredRecentHistory(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.input)) {
    const serialized = JSON.stringify(sanitizeForHandoff(payload), null, 2);
    return serialized.length <= RECENT_TAIL_CHARS
      ? serialized
      : JSON.stringify({
          note: "recent handoff shortened to fit manifest budget",
          excerpt: serialized.slice(-RECENT_TAIL_CHARS + 200),
        }, null, 2);
  }

  const sourceInput = payload.input.filter(item => !isLocalCompactionPromptItem(item));
  const selected: unknown[] = [];
  for (let index = sourceInput.length - 1; index >= 0 && selected.length < MAX_HANDOFF_INPUT_ITEMS; index--) {
    const candidate = [sanitizeForHandoff(sourceInput[index]), ...selected];
    const probe = JSON.stringify(structuredHandoffPayload(payload, sourceInput, candidate), null, 2);
    if (probe.length > RECENT_TAIL_CHARS && selected.length > 0) break;
    selected.unshift(sanitizeForHandoff(sourceInput[index]));
  }

  const handoff = JSON.stringify(structuredHandoffPayload(payload, sourceInput, selected), null, 2);
  if (handoff.length <= RECENT_TAIL_CHARS) return handoff;

  // A single pathological item can still exceed the total manifest budget even
  // after per-string shortening (for example a result containing thousands of
  // small fields). Keep valid JSON and retain both ends of that newest item
  // rather than slicing the manifest itself in the middle of JSON syntax.
  const newest = JSON.stringify(selected.at(-1) ?? null, null, 2);
  const marker = `\n...[newest handoff item shortened; original_chars=${newest.length}]...\n`;
  const retained = Math.max(1_000, RECENT_TAIL_CHARS - marker.length - 1_500);
  const head = Math.floor(retained / 2);
  const tail = retained - head;
  const fallback = {
    model: sanitizeForHandoff(payload.model, "model"),
    previous_response_id: sanitizeForHandoff(payload.previous_response_id, "previous_response_id"),
    input_count: sourceInput.length,
    omitted_input_items: Math.max(0, sourceInput.length - 1),
    continuation: recentContinuationMetadata(sourceInput, 1),
    ...(omittedRequestAnchors(sourceInput, 1).length > 0 ? { request_anchors: omittedRequestAnchors(sourceInput, 1) } : {}),
    ...(activeRequestAnchor(sourceInput, 1) ? { active_request: activeRequestAnchor(sourceInput, 1) } : {}),
    ...(latestOmittedAssistantState(sourceInput, 1) ? { assistant_state: latestOmittedAssistantState(sourceInput, 1) } : {}),
    ...(omittedBoundaryContext(sourceInput, 1).length > 0 ? { boundary_context: omittedBoundaryContext(sourceInput, 1) } : {}),
    recent_input_excerpt: newest.slice(0, head) + marker + newest.slice(-tail),
  };
  const serializedFallback = JSON.stringify(fallback, null, 2);
  if (serializedFallback.length <= RECENT_TAIL_CHARS) return serializedFallback;
  const overflow = serializedFallback.length - RECENT_TAIL_CHARS;
  const excerpt = fallback.recent_input_excerpt;
  fallback.recent_input_excerpt = excerpt.slice(0, Math.max(1_000, excerpt.length - overflow - 128));
  return JSON.stringify(fallback, null, 2);
}

function snapshotPayload(rawRequest: unknown): unknown {
  if (!isRecord(rawRequest)) return sanitizeForSnapshot(rawRequest);
  return sanitizeForSnapshot({
    model: rawRequest.model,
    instructions: rawRequest.instructions,
    input: rawRequest.input,
    previous_response_id: rawRequest.previous_response_id,
    metadata: rawRequest.metadata,
  });
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

export async function createLocalCompactionSnapshot(
  rawRequest: unknown,
  metadata: { kind: "responses-v2" | "responses-local" | "responses-compact-v1"; model?: string },
): Promise<LocalCompactionSnapshot> {
  const snapshotId = randomBytes(16).toString("hex");
  const createdAt = new Date().toISOString();
  const payload = snapshotPayload(rawRequest);
  const historyJson = JSON.stringify(payload, null, 2);
  const recent = structuredRecentHistory(payload);

  const archiveText = [
    "CODEX BRIDGE LOCAL COMPACTION SNAPSHOT",
    "=======================================",
    `snapshot_id: ${snapshotId}`,
    `created_at: ${createdAt}`,
    `kind: ${metadata.kind}`,
    `model: ${metadata.model ?? "unknown"}`,
    "",
    "This is a local read-only historical archive produced by codex-chatgpt-web V15.1.",
    "It lets the normal ChatGPT/Codex turn recover older details without launching a second",
    "browser-based compaction request.",
    "",
    "<history_json>",
    historyJson,
    "</history_json>",
    "",
  ].join("\n");

  const directory = compactionDirectory();
  await mkdir(directory, { recursive: true });
  await chmod(directory, 0o700).catch(() => {});
  const file = path.join(directory, `${snapshotId}.txt`);
  const temporaryFile = `${file}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await writeFile(temporaryFile, archiveText, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporaryFile, file);
  } finally {
    await rm(temporaryFile, { force: true }).catch(() => {});
  }

  const manifest = [
    `${LOCAL_COMPACTION_MARKER} snapshot_id=${snapshotId}]`,
    "The bridge archived earlier expanded task history locally instead of launching another ChatGPT compaction turn.",
    "Continue from the structured recent history below; it preserves whole recent input items rather than an arbitrary raw-text tail.",
    "request_anchors preserves up to three older real user-authored instructions that recent_input had to evict; when more exist it keeps the first task-defining request plus the newest steering. Apply them oldest-to-newest before the newer progress.",
    "When active_request is present in the structured handoff, it is the preserved user-goal anchor that fell outside recent_input; combine that goal with the newer progress in recent_input.",
    "boundary_context preserves the final omitted assistant/tool state immediately before recent_input, so a fresh browser window can bridge the handoff without guessing what happened just before the retained suffix.",
    "If this checkpoint is consumed in a fresh ChatGPT browser window or conversation, it is still the same Codex task handoff. Follow continuation.resume_rule and the item indices below instead of treating the new window as a restart.",
    "If an older fact, decision, command result, path, error, or prior instruction is needed after codex_bind_turn, prefer codex_read_compaction with this snapshot_id plus optional query/offset/max_chars.",
    `Compatibility fallback: codex_tool_call wire_name="${BRIDGE_COMPACTION_READ_WIRE}" with the same arguments.`,
    "Sequential paging uses offset plus max_chars. Both history reads are local and read-only.",
    "",
    "<recent_history_tail>",
    recent,
    "</recent_history_tail>",
  ].join("\n");

  return { snapshotId, manifest, archivedChars: archiveText.length, recentChars: recent.length };
}

export async function readLocalCompactionSnapshot(args: LocalCompactionReadArgs): Promise<{
  snapshot_id: string;
  matched: boolean;
  match_index: number | null;
  offset: number;
  next_offset: number | null;
  total_chars: number;
  text: string;
}> {
  const snapshotId = args.snapshotId.trim().toLowerCase();
  if (!SNAPSHOT_ID_RE.test(snapshotId)) throw new Error("Invalid local compaction snapshot_id");

  const file = path.join(compactionDirectory(), `${snapshotId}.txt`);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
    if (code === "ENOENT") throw new Error(`Local compaction snapshot not found: ${snapshotId}`);
    throw error;
  }

  const maxChars = boundedInteger(args.maxChars, DEFAULT_READ_CHARS, 1_000, MAX_READ_CHARS);
  const requestedOffset = boundedInteger(args.offset, 0, 0, text.length);
  const query = args.query?.trim().slice(0, 2_000) ?? "";

  let matched = false;
  let matchIndex: number | null = null;
  let start = requestedOffset;

  if (query) {
    const haystack = text.toLowerCase();
    const needle = query.toLowerCase();
    let found = haystack.indexOf(needle, requestedOffset);
    if (found < 0 && requestedOffset > 0) found = haystack.indexOf(needle);
    if (found >= 0) {
      matched = true;
      matchIndex = found;
      start = Math.max(0, found - Math.floor(maxChars / 4));
    }
  }

  const end = Math.min(text.length, start + maxChars);
  return {
    snapshot_id: snapshotId,
    matched,
    match_index: matchIndex,
    offset: start,
    next_offset: end < text.length ? end : null,
    total_chars: text.length,
    text: text.slice(start, end),
  };
}
