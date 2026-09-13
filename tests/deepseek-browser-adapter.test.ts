import { afterEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  classifiedDeepSeekError,
  createDeepSeekWebAdapter,
  deepSeekConversationKey,
  deepSeekRequestTurnIdentity,
  deepSeekToolRecoveryTraceId,
  deepSeekTraceId,
  emitDeepSeekToolRequests,
} from "../src/adapters/deepseek-web";
import {
  closeDeepSeekBrowserWorkers,
  deepSeekContinuationResponseChanged,
  DeepSeekBrowserTurnFailure,
  DeepSeekCompletionTracker,
  DeepSeekTurnDomHealthTracker,
  type DeepSeekResponseSnapshot,
} from "../src/adapters/deepseek-web/browser-worker";
import {
  compileDeepSeekWebContinuationPrompt,
  compileDeepSeekWebFollowUpPrompt,
  compileDeepSeekWebPrompt,
  deepSeekPromptContainsImages,
  deepSeekToolContinuationTraceId,
} from "../src/adapters/deepseek-web/prompt";
import {
  deepSeekEffectiveTools,
  deepSeekResponseRecoveryReason,
  deepSeekResponseNeedsToolRecovery,
  deepSeekToolCallRequired,
  deepSeekToolRecoveryPrompt,
  DeepSeekToolProtocolError,
  normalizeDeepSeekApplyPatchBlankLines,
  parseDeepSeekToolRequests,
  parseDeepSeekToolResponseCandidates,
  wrapDeepSeekWindowsPowerShellCommand,
} from "../src/adapters/deepseek-web/tool-protocol";
import { deepSeekLoginVerificationMarkerPath } from "../src/deepseek-browser-login";
import { deepSeekSecurityChallengeSignal, deepSeekSignInUrl } from "../src/deepseek-session";
import type { CodexParsedRequest, CodexProviderConfig } from "../src/types";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await closeDeepSeekBrowserWorkers();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function parsedRequest(): CodexParsedRequest {
  return {
    modelId: "deepseek-web/expert",
    stream: true,
    options: {},
    context: {
      systemPrompt: ["Keep the requested output concise."],
      messages: [
        { role: "developer", content: "Preserve repository facts.", timestamp: 1 },
        { role: "user", content: "First question", timestamp: 2 },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private reasoning must not cross providers" },
            { type: "text", text: "Earlier answer" },
          ],
          timestamp: 3,
        },
        { role: "user", content: "Continue from there", timestamp: 4 },
      ],
    },
  };
}

function snapshot(overrides: Partial<DeepSeekResponseSnapshot> = {}): DeepSeekResponseSnapshot {
  return {
    probeSucceeded: true,
    responsePresent: true,
    running: false,
    retryActionPresent: false,
    completionActionPresent: true,
    composerReady: true,
    finalHtml: "<p>done</p>",
    finalText: "done",
    finalTextLength: 4,
    activitySignature: "done",
    ...overrides,
  };
}

function provider(storageStatePath: string): CodexProviderConfig {
  return {
    adapter: "chatgpt-web",
    baseUrl: "https://chatgpt.com",
    deepseekWeb: {
      enabled: true,
      storageStatePath,
      chromeExecutablePath: process.execPath,
      headed: true,
    },
  };
}

describe("DeepSeek Web prompt and browser contract", () => {
  test("serializes complete history for a fresh chat without copying hidden reasoning", () => {
    const compiled = compileDeepSeekWebPrompt(parsedRequest());
    expect(compiled.text).toContain('role="system"');
    expect(compiled.text).toContain('role="developer"');
    expect(compiled.text).toContain("First question");
    expect(compiled.text).toContain("Earlier answer");
    expect(compiled.text).toContain("Continue from there");
    expect(compiled.text).toContain("keep responses concise and result-first");
    expect(compiled.text).not.toContain("private reasoning must not cross providers");
    expect(compiled.sourceChars).toBe(compiled.text.length);
  });

  test("serializes only the new suffix when continuing an existing DeepSeek chat", () => {
    const compiled = compileDeepSeekWebContinuationPrompt(parsedRequest());
    expect(compiled).toBeDefined();
    expect(compiled!.text).toContain("Continue from there");
    expect(compiled!.text).toContain("keep the response concise and result-first");
    expect(compiled!.text).not.toContain("First question");
    expect(compiled!.text).not.toContain("Earlier answer");
    expect(compiled!.text).not.toContain("Preserve repository facts.");
    expect(compiled!.sourceChars).toBe(compiled!.text.length);
  });

  test("spools oversized fresh-chat history into one rolling local context file", () => {
    const root = mkdtempSync(join(tmpdir(), "deepseek-context-spool-"));
    temporaryRoots.push(root);
    const parsed = parsedRequest();
    parsed.context.tools = [{
      name: "exec_command",
      description: "Run a command in the current workspace",
      parameters: {
        type: "object",
        properties: { cmd: { type: "string" } },
        required: ["cmd"],
      },
    }];
    parsed.context.messages.splice(1, 0, {
      role: "user",
      content: `OLD_CONTEXT_SENTINEL ${"historical payload ".repeat(1800)}`,
      timestamp: 1.5,
    });
    parsed.context.messages.push({ role: "user", content: "LATEST_CONTEXT_SENTINEL", timestamp: 5 });

    const compiled = compileDeepSeekWebPrompt(parsed, {
      contextKey: "thread-rolling-context",
      contextDirectory: root,
      pasteBudgetChars: 12_000,
      inlineContextChars: 2_500,
    });

    expect(compiled.contextArchive).toBeDefined();
    expect(compiled.text).toContain("rolling local text file");
    expect(compiled.text).toContain("Do not dump or cat the entire archive");
    expect(compiled.text).toContain("LATEST_CONTEXT_SENTINEL");
    expect(compiled.text).not.toContain("OLD_CONTEXT_SENTINEL");
    expect(compiled.text.length).toBeLessThan(12_000);

    const firstPath = compiled.contextArchive!.path;
    const firstArchive = readFileSync(firstPath, "utf8");
    expect(firstArchive).toContain("<priority_instructions>");
    expect(firstArchive).toContain("Preserve repository facts.");
    expect(firstArchive).toContain("OLD_CONTEXT_SENTINEL");
    expect(firstArchive).toContain("LATEST_CONTEXT_SENTINEL");

    parsed.context.messages.push({ role: "user", content: "ROLLING_UPDATE_SENTINEL", timestamp: 6 });
    const updated = compileDeepSeekWebPrompt(parsed, {
      contextKey: "thread-rolling-context",
      contextDirectory: root,
      pasteBudgetChars: 12_000,
      inlineContextChars: 2_500,
    });
    expect(updated.contextArchive!.path).toBe(firstPath);
    expect(readFileSync(firstPath, "utf8")).toContain("ROLLING_UPDATE_SENTINEL");
  });

  test("keeps full oversized history inline when no command tool can recover a local archive", () => {
    const parsed = parsedRequest();
    parsed.context.messages.splice(1, 0, {
      role: "user",
      content: `NO_READER_SENTINEL ${"payload ".repeat(3000)}`,
      timestamp: 1.5,
    });

    const compiled = compileDeepSeekWebPrompt(parsed, {
      contextKey: "thread-without-reader",
      pasteBudgetChars: 10_000,
    });
    expect(compiled.contextArchive).toBeUndefined();
    expect(compiled.text).toContain("NO_READER_SENTINEL");
  });

  test("teaches DeepSeek to act through Codex tools instead of asking discoverable questions", () => {
    const parsed = parsedRequest();
    parsed.context.tools = [{
      name: "exec_command",
      description: "Run a command in the current workspace",
      parameters: {
        type: "object",
        properties: { cmd: { type: "string" } },
        required: ["cmd"],
      },
    }];
    const compiled = compileDeepSeekWebPrompt(parsed);
    expect(compiled.text).toContain("Codex harness tools are available indirectly");
    expect(compiled.text).toContain("never overrides safety policy, user authorization, sandboxing");
    expect(compiled.text).toContain("prefer using the tools to inspect and act instead of asking the user");
    expect(compiled.text).toContain("do not narrate your analysis, plan, or intended next step");
    expect(compiled.text).toContain("Do not replace a tool request with progress prose");
    expect(compiled.text).toContain("Never end a response by saying you will check, inspect, run, create, edit, build, test, or continue work next");
    expect(compiled.text).toContain("Never pre-write later tool calls that depend on the result of an earlier call");
    expect(compiled.text).toContain("a blank added line is a line containing only +");
    expect(compiled.text).toContain('"name":"exec_command"');
    expect(compiled.text).toContain('"codex_tool_calls"');
    expect(compiled.text).not.toContain("You do not have direct access to the user's filesystem or Codex tools in this route");
  });

  test("recovers short DeepSeek pre-action narration instead of treating it as completion", () => {
    const parsed = parsedRequest();
    parsed.context.tools = [{
      name: "exec_command",
      description: "Run a command in the current workspace",
      parameters: { type: "object", properties: { cmd: { type: "string" } } },
    }];

    const stalled = "I'll continue building the calculator GUI test. Let me check what's already in the workspace first.";
    expect(deepSeekResponseNeedsToolRecovery(stalled)).toBe(true);
    expect(deepSeekResponseNeedsToolRecovery(
      "I'll build you a self-contained HTML flag clicker with an animated CCP flag rendered in CSS.",
    )).toBe(true);
    expect(deepSeekResponseNeedsToolRecovery("I need to inspect the current DeepSeek prompt before I can patch it.")).toBe(true);
    expect(deepSeekResponseNeedsToolRecovery("We should check the adapter tests first, then decide what to change.")).toBe(true);
    expect(deepSeekResponseNeedsToolRecovery("Need to inspect the repository state first.")).toBe(true);
    expect(deepSeekResponseNeedsToolRecovery(`${"Planning notes. ".repeat(150)}Next, I need to run the focused tests.`)).toBe(true);
    expect(deepSeekResponseNeedsToolRecovery("The calculator GUI test is complete and all button cases pass.")).toBe(false);
    expect(deepSeekResponseNeedsToolRecovery("I'll explain how the calculator test works, including its event model and assertions.")).toBe(false);
    expect(deepSeekResponseNeedsToolRecovery("A useful debugging workflow is to inspect the prompt, run the tests, and then patch the adapter.")).toBe(false);
    expect(deepSeekResponseNeedsToolRecovery("Run the focused tests after making the change.")).toBe(false);

    const recovery = deepSeekToolRecoveryPrompt(parsed);
    expect(recovery).toContain("instead of a Codex tool request");
    expect(recovery).toContain("with no analysis, plan, or preamble");
    expect(recovery).toContain('"codex_tool_calls"');

    const toolLess = parsedRequest();
    toolLess.context.tools = [];
    const toolLessRecovery = deepSeekToolRecoveryPrompt(toolLess);
    expect(toolLessRecovery).toContain("No Codex tool is active for this turn");
    expect(toolLessRecovery).toContain("Provide the complete useful result directly in the response");

    const recoveryTraceId = deepSeekToolRecoveryTraceId("abcdef123456", stalled);
    expect(recoveryTraceId).toMatch(/^[0-9a-f]{12}$/);
    expect(recoveryTraceId).toBe(deepSeekToolRecoveryTraceId("abcdef123456", stalled));
    expect(recoveryTraceId).not.toBe("abcdef123456");
  });

  test("recovers diverse planning and mistaken capability refusals without overriding policy failures", () => {
    const recoverable = [
      "I can't access your filesystem or run commands here. Please paste the file.",
      "I cannot access your local filesystem.",
      "I don't have access to tools in this environment.",
      "I’m unable to run commands or edit files here.",
      "Please run this command yourself.",
      "I can only provide instructions, not make the change directly.",
    ];
    for (const text of recoverable) {
      expect(deepSeekResponseRecoveryReason(text)).toBe("capability_refusal");
    }

    const planning = [
      "Let me use apply_patch to fix it.",
      "I'll clean it up immediately.",
      "I'll verify the build now.",
      "I'll review the file first.",
      "I'll investigate the failure.",
      "I'm checking the repository now.",
      "I'll continue now.",
      `I'll fix the truncated header now. ${"payload ".repeat(700)}`,
    ];
    for (const text of planning) {
      expect(deepSeekResponseRecoveryReason(text)).toBe("narration");
    }

    const legitimateFinals = [
      'The phrase "tools are unavailable" is an example, not a claim about this task.',
      "This environment cannot access your filesystem; that is why the sandbox boundary exists.",
      "I can't modify local files because the safety policy prohibits this request.",
      "The command failed with permission denied, so I can't modify the file.",
      "The tool result reported access denied; ask an administrator for authorization.",
    ];
    for (const text of legitimateFinals) {
      expect(deepSeekResponseRecoveryReason(text)).toBeUndefined();
    }
  });

  test("marks required DeepSeek tool choices as an enforced correction condition", () => {
    const parsed = parsedRequest();
    expect(deepSeekToolCallRequired(parsed)).toBe(false);
    parsed.options.toolChoice = "required";
    expect(deepSeekToolCallRequired(parsed)).toBe(true);
    expect(deepSeekToolRecoveryPrompt(parsed, "required_tool"))
      .toContain("requires a valid tool call");
    expect(deepSeekToolRecoveryPrompt(parsed, "capability_refusal"))
      .toContain("advertised indirect tools");
  });

  test("parses only exact advertised DeepSeek tool envelopes", () => {
    const parsed = parsedRequest();
    parsed.context.tools = [{
      name: "exec_command",
      description: "Run a command",
      parameters: { type: "object" },
    }];
    expect(parseDeepSeekToolRequests(
      '{"codex_tool_calls":[{"name":"exec_command","arguments":{"cmd":"rg --files"}}]}',
      parsed,
    )).toEqual([{ name: "exec_command", arguments: { cmd: "rg --files" } }]);
    expect(parseDeepSeekToolRequests("Normal final answer", parsed)).toBeUndefined();
    expect(() => parseDeepSeekToolRequests(
      '{"codex_tool_calls":[{"name":"not_advertised","arguments":{}}]}',
      parsed,
    )).toThrow("did not advertise");
  });

  test("canonicalizes flattened arguments inside the preferred DeepSeek tool envelope", () => {
    const parsed = parsedRequest();
    parsed.context.tools = [{
      namespace: "functions",
      name: "exec_command",
      description: "Run a command",
      parameters: { type: "object" },
    }];
    const output = String.raw`{"codex\_tool\_calls":[{"name":"functions\_\_exec\_command","cmd":"Get-Location | Select-Object -ExpandProperty Path","workdir":"C:\Users\User\Documents\ChatGPT\EAC bypass","yield\_time\_ms":10000,"max\_output\_tokens":3000}]}`;

    expect(parseDeepSeekToolRequests(output, parsed)).toEqual([{
      name: "functions__exec_command",
      arguments: {
        cmd: "Get-Location | Select-Object -ExpandProperty Path",
        workdir: String.raw`C:\Users\User\Documents\ChatGPT\EAC bypass`,
        yield_time_ms: 10000,
        max_output_tokens: 3000,
      },
    }]);
  });

  test("recovers a raw tool envelope after DeepSeek pre-action narration", () => {
    const parsed = parsedRequest();
    parsed.context.tools = [{
      name: "exec_command",
      description: "Run a command",
      parameters: { type: "object" },
    }];

    expect(parseDeepSeekToolRequests([
      "I need to inspect the workspace first.",
      '{"codex_tool_calls":[{"name":"exec_command","arguments":{"cmd":"rg --files"}}]}',
    ].join("\n"), parsed)).toEqual([{
      name: "exec_command",
      arguments: { cmd: "rg --files" },
    }]);

    expect(parseDeepSeekToolRequests([
      "Here is an example payload:",
      '{"codex_tool_calls":[{"name":"exec_command","arguments":{"cmd":"rg --files"}}]}',
    ].join("\n"), parsed)).toBeUndefined();
  });

  test("repairs physically blank lines only inside apply_patch Add File bodies", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: readable.html",
      "+<!doctype html>",
      "",
      "+<style>",
      "+* { box-sizing: border-box; }",
      "+</style>",
      "*** Update File: existing.txt",
      "@@",
      " context before",
      "",
      " context after",
      "*** End Patch",
    ].join("\n");

    expect(normalizeDeepSeekApplyPatchBlankLines(patch)).toBe([
      "*** Begin Patch",
      "*** Add File: readable.html",
      "+<!doctype html>",
      "+",
      "+<style>",
      "+* { box-sizing: border-box; }",
      "+</style>",
      "*** Update File: existing.txt",
      "@@",
      " context before",
      "",
      " context after",
      "*** End Patch",
    ].join("\n"));
  });

  test("normalizes DeepSeek apply_patch requests before returning them to Codex", () => {
    const parsed = parsedRequest();
    parsed.context.tools = [{
      name: "apply_patch",
      description: "Apply a patch",
      parameters: { type: "object", properties: { input: { type: "string" } } },
      freeform: true,
    }];
    const patch = [
      "*** Begin Patch",
      "*** Add File: readable.html",
      "+<main>",
      "",
      "+  readable content",
      "+</main>",
      "*** End Patch",
    ].join("\n");
    const output = JSON.stringify({
      codex_tool_calls: [{ name: "apply_patch", arguments: { input: patch } }],
    });

    expect(parseDeepSeekToolRequests(output, parsed)).toEqual([{
      name: "apply_patch",
      arguments: {
        input: patch.replace("+<main>\n\n+  readable", "+<main>\n+\n+  readable"),
      },
    }]);
  });

  test("recovers renderer-escaped apply_patch calls from the preferred DeepSeek envelope", () => {
    const parsed = parsedRequest();
    parsed.context.tools = [{
      namespace: "functions",
      name: "apply_patch",
      description: "Apply a patch",
      parameters: { type: "object", properties: { input: { type: "string" } } },
      freeform: true,
    }];
    const output = String.raw`{"codex\_tool\_calls":{"name":"functions\_\_apply\_patch","arguments":{"input":"\*\*\* Begin Patch\\n\*\*\* Add File: x.html\\n+<html lang="en">\\n+const xs = \[1, 2\];\\n** End Patch\\n"}}`;

    expect(parseDeepSeekToolRequests(output, parsed)).toEqual([{
      name: "functions__apply_patch",
      arguments: {
        input: [
          "*** Begin Patch",
          "*** Add File: x.html",
          '+<html lang="en">',
          "+const xs = [1, 2];",
          "*** End Patch",
          "",
        ].join("\n"),
      },
    }]);
  });

  test("normalizes renderer-escaped apply_patch input after alternate DeepSeek tool routes", () => {
    const parsed = parsedRequest();
    parsed.context.tools = [{
      namespace: "functions",
      name: "apply_patch",
      description: "Apply a patch",
      parameters: { type: "object", properties: { input: { type: "string" } } },
      freeform: true,
    }];
    const expected = [{
      name: "functions__apply_patch",
      arguments: {
        input: [
          "*** Begin Patch",
          "*** Add File: x.txt",
          "+hello",
          "*** End Patch",
          "",
        ].join("\n"),
      },
    }];
    const outputs = [
      String.raw`<request_tool>{"name":"functions\_\_apply\_patch","input":"\*\*\* Begin Patch\\n\*\*\* Add File: x.txt\\n+hello\\n** End Patch\\n"}</request_tool>`,
      [
        "<tool_calls>",
        '<invoke name="functions__apply_patch">',
        String.raw`<parameter name="input">\*\*\* Begin Patch\n\*\*\* Add File: x.txt\n+hello\n** End Patch\n</parameter>`,
        "</invoke>",
        "</tool_calls>",
      ].join("\n"),
      [
        String.raw`\\\<｜｜DSML｜｜ tool\\\_calls\"> &#x20;`,
        String.raw`{"name":"functions\\_\\_apply\\_patch","arguments":{"input":"\*\*\* Begin Patch\\n\*\*\* Add File: x.txt\\n+hello\\n** End Patch\\n"}}`,
        String.raw`\\\</｜｜DSML｜｜>`,
      ].join("\n"),
    ];

    for (const [index, output] of outputs.entries()) {
      try {
        expect(parseDeepSeekToolRequests(output, parsed)).toEqual(expected);
      } catch (error) {
        throw new Error(`alternate DeepSeek route ${index + 1} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  });

  test("accepts a DSML tool_calls wrapper around plain invoke markup", () => {
    const parsed = parsedRequest();
    parsed.context.tools = [{
      namespace: "functions",
      name: "apply_patch",
      description: "Apply a patch",
      parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"] },
      freeform: true,
    }];
    const output = [
      String.raw`<｜｜DSML｜｜ tool\_calls>`,
      '<invoke name="functions__apply_patch">',
      '<parameter name="input">*** Begin Patch',
      '*** Add File: src/bin/meme_gen.rs',
      '+fn main() {}',
      '*** End Patch </parameter>',
      '</invoke>',
      '</｜｜DSML｜｜>',
    ].join("\n");

    expect(parseDeepSeekToolRequests(output, parsed)).toEqual([{
      name: "functions__apply_patch",
      arguments: {
        input: [
          "*** Begin Patch",
          "*** Add File: src/bin/meme_gen.rs",
          "+fn main() {}",
          "*** End Patch",
        ].join("\n"),
      },
    }]);
  });

  test("accepts DeepSeek's name-only DSML hierarchy for freeform apply_patch", () => {
    const parsed = parsedRequest();
    parsed.context.tools = [{
      namespace: "functions",
      name: "apply_patch",
      description: "Apply a patch",
      parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"] },
      freeform: true,
    }];
    const output = [
      "I see the problem now. Let me request it correctly.",
      String.raw`<｜｜DSML｜｜ tool\_calls>`,
      String.raw`<｜｜DSML｜｜ name=\"functions\_\_apply\_patch\">`,
      String.raw`<｜｜DSML｜｜ name=\"input\">\*\*\* Begin Patch`,
      String.raw`\*\*\* Add File: src/Core/OffsetValidator.hpp`,
      "+#pragma once",
      "+#include \\<cstdint>",
      String.raw`\*\*\* End Patch\</｜｜DSML｜｜>`,
      String.raw`\</｜｜DSML｜｜>`,
      String.raw`\</｜｜DSML｜｜>`,
    ].join("\n");

    expect(parseDeepSeekToolRequests(output, parsed)).toEqual([{
      name: "functions__apply_patch",
      arguments: {
        input: [
          "*** Begin Patch",
          "*** Add File: src/Core/OffsetValidator.hpp",
          "+#pragma once",
          "+#include <cstdint>",
          "*** End Patch",
        ].join("\n"),
      },
    }]);
  });

  test("encodes multiline Windows PowerShell so parser failures produce diagnostics", () => {
    const source = "$html = @'\nunterminated";
    const wrapped = wrapDeepSeekWindowsPowerShellCommand(source, "win32");
    expect(wrapped).toStartWith("powershell.exe -NoProfile -NonInteractive -EncodedCommand ");

    const encodedWrapper = wrapped.split(" ").at(-1)!;
    const wrapper = Buffer.from(encodedWrapper, "base64").toString("utf16le");
    const encodedSource = wrapper.match(/FromBase64String\('([^']+)'\)/)?.[1];
    expect(encodedSource).toBeDefined();
    expect(Buffer.from(encodedSource!, "base64").toString("utf8")).toBe(source);
    expect(wrapper).toContain("[ScriptBlock]::Create($source + [Environment]::NewLine + $statusTrailer)");
    expect(wrapper).toContain("[Console]::Error.WriteLine($_.Exception.Message)");
    expect(wrapDeepSeekWindowsPowerShellCommand("Write-Output ping", "win32")).toBe("Write-Output ping");
    expect(wrapDeepSeekWindowsPowerShellCommand(source, "linux")).toBe(source);
  });

  test("encodes single-line PowerShell interpolation so the outer harness cannot mangle it", () => {
    const source = '1 | ForEach-Object { "value=$($_ + 1)" }';
    const wrapped = wrapDeepSeekWindowsPowerShellCommand(source, "win32");
    expect(wrapped).toStartWith("powershell.exe -NoProfile -NonInteractive -EncodedCommand ");

    const encodedWrapper = wrapped.split(" ").at(-1)!;
    const wrapper = Buffer.from(encodedWrapper, "base64").toString("utf16le");
    const encodedSource = wrapper.match(/FromBase64String\('([^']+)'\)/)?.[1];
    expect(encodedSource).toBeDefined();
    expect(Buffer.from(encodedSource!, "base64").toString("utf8")).toBe(source);

    if (process.platform !== "win32") return;
    const result = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", wrapped], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("value=2");
  });

  test("does not rewrite commands for an explicitly selected non-PowerShell shell", () => {
    const parsed = parsedRequest();
    parsed.context.tools = [{
      namespace: "functions",
      name: "exec_command",
      description: "Run a command",
      parameters: {
        type: "object",
        properties: {
          cmd: { type: "string" },
          shell: { type: "string" },
        },
      },
    }];
    const command = 'printf "%s\\n" "$HOME"';
    expect(parseDeepSeekToolRequests(JSON.stringify({
      codex_tool_calls: [{
        name: "functions__exec_command",
        arguments: { cmd: command, shell: "bash" },
      }],
    }), parsed)).toEqual([{
      name: "functions__exec_command",
      arguments: { cmd: command, shell: "bash" },
    }]);
  });

  test("preserves a failing final command status through the PowerShell compatibility wrapper", () => {
    if (process.platform !== "win32") return;
    const wrapped = wrapDeepSeekWindowsPowerShellCommand("cmd.exe /d /c exit 7\n", "win32");
    const result = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", wrapped], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).not.toBe(0);

    const explicitExit = wrapDeepSeekWindowsPowerShellCommand("exit 9\n", "win32");
    const explicitExitResult = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", explicitExit], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(explicitExitResult.exitCode).not.toBe(0);
  });

  test("surfaces a malformed PowerShell here-string instead of returning silent exit 1", () => {
    if (process.platform !== "win32") return;
    const wrapped = wrapDeepSeekWindowsPowerShellCommand("$html = @'\nunterminated", "win32");
    const result = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", wrapped], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = `${result.stdout.toString()}\n${result.stderr.toString()}`;

    expect(result.exitCode).toBe(1);
    expect(output).toContain("missing the terminator");
  });

  test("recovers prose-prefixed fenced DeepSeek tool dumps one round at a time", () => {
    const parsed = parsedRequest();
    parsed.context.tools = [
      {
        namespace: "functions",
        name: "exec_command",
        description: "Run a command",
        parameters: {
          type: "object",
          properties: {
            cmd: { type: "string" },
            workdir: { type: "string" },
            yield_time_ms: { type: "integer" },
          },
        },
      },
      {
        namespace: "functions",
        name: "apply_patch",
        description: "Apply a patch",
        parameters: { type: "object", properties: { input: { type: "string" } } },
      },
    ];
    const output = [
      "I'll build the calculator GUI test. First I'll check the local Python environment.",
      "```json",
      String.raw`{"codex\_tool\_calls":{"name":"functions\_\_exec\_command","arguments":{"cmd":"python --version","workdir":"C:\\workspace","yield\_time\_ms":10000}}}`,
      "```",
      "```json",
      String.raw`{"codex\_tool\_calls":{"name":"functions\_\_apply\_patch","arguments":{"input":"*** Begin Patch\\n*** End Patch"}}}`,
      "```",
    ].join("\n");

    expect(parseDeepSeekToolRequests(output, parsed)).toEqual([{
      name: "functions__exec_command",
      arguments: {
        cmd: "python --version",
        workdir: String.raw`C:\workspace`,
        yield_time_ms: 10000,
      },
    }]);
  });

  test("does not execute prose examples that merely contain fenced tool envelopes", () => {
    const parsed = parsedRequest();
    parsed.context.tools = [{
      name: "exec_command",
      description: "Run a command",
      parameters: { type: "object" },
    }];
    const output = [
      "Here is an example of the bridge JSON format:",
      "```json",
      '{"codex_tool_calls":{"name":"exec_command","arguments":{"cmd":"rg --files"}}}',
      "```",
    ].join("\n");

    expect(parseDeepSeekToolRequests(output, parsed)).toBeUndefined();
  });

  test("accepts DeepSeek's markdown-escaped Codex-style tool markup as a compatibility fallback", () => {
    const parsed = parsedRequest();
    parsed.context.tools = [{
      name: "exec_command",
      description: "Run a command",
      parameters: {
        type: "object",
        properties: {
          cmd: { type: "string" },
          workdir: { type: "string" },
          yield_time_ms: { type: "integer" },
          max_output_tokens: { type: "integer" },
        },
        required: ["cmd"],
      },
    }];
    const output = [
      "\\<tool\\_calls>",
      "\\<invoke name=\"exec\\_command\">",
      "\\<parameter name=\"cmd\">rustc --version; cargo --version\\</parameter>",
      "\\<parameter name=\"workdir\">C:\\_workspace\\</parameter>",
      "\\<parameter name=\"yield\\_time\\_ms\">10000\\</parameter>",
      "\\<parameter name=\"max\\_output\\_tokens\">5000\\</parameter>",
      "\\</invoke>",
      "\\</tool\\_calls>",
    ].join("\n");

    expect(parseDeepSeekToolRequests(output, parsed)).toEqual([{
      name: "exec_command",
      arguments: {
        cmd: "rustc --version; cargo --version",
        workdir: "C:\\_workspace",
        yield_time_ms: 10000,
        max_output_tokens: 5000,
      },
    }]);
  });

  test("accepts the multiply escaped terminal tool block DeepSeek currently renders after prose", () => {
    const parsed = parsedRequest();
    parsed.context.tools = [{
      namespace: "functions",
      name: "exec_command",
      description: "Run a command",
      parameters: {
        type: "object",
        properties: {
          cmd: { type: "string" },
          workdir: { type: "string" },
          yield_time_ms: { type: "integer" },
          max_output_tokens: { type: "integer" },
        },
      },
    }];
    const output = [
      "I'll build a small Rust calculator app for you.",
      String.raw`\\\\\<aside>I'll set up a Cargo project first.\\\\\</aside>`,
      String.raw`\\\\\<tool\\\\\_calls>`,
      String.raw`\\\\\<invoke name="functions\\\\\_\\\\\_exec\\\\\_command">`,
      String.raw`\\\\\<parameter name="cmd">cargo --version\\\\\</parameter>`,
      String.raw`\\\\\<parameter name="workdir">C:\Users\User\Documents\Calc\\\\\</parameter>`,
      String.raw`\\\\\<parameter name="yield\\\\\_time\\\\\_ms">10000\\\\\</parameter>`,
      String.raw`\\\\\<parameter name="max\\\\\_output\\\\\_tokens">2000\\\\\</parameter>`,
      String.raw`\\\\\</invoke>`,
      String.raw`\\\\\</tool\\\\\_calls>`,
    ].join("\n");

    expect(parseDeepSeekToolRequests(output, parsed)).toEqual([{
      name: "functions__exec_command",
      arguments: {
        cmd: "cargo --version",
        workdir: String.raw`C:\Users\User\Documents\Calc`,
        yield_time_ms: 10000,
        max_output_tokens: 2000,
      },
    }]);
  });

  test("accepts DeepSeek renderer string=false parameter annotations on numeric exec fields", () => {
    const parsed = parsedRequest();
    parsed.context.tools = [{
      namespace: "functions",
      name: "exec_command",
      description: "Run a command",
      parameters: {
        type: "object",
        properties: {
          cmd: { type: "string" },
          workdir: { type: "string" },
          yield_time_ms: { type: "integer" },
          max_output_tokens: { type: "integer" },
        },
        required: ["cmd"],
      },
    }];
    const output = [
      "I'll build a Three.js flag clicker and write the HTML file first.",
      String.raw`\<tool\_calls>`,
      String.raw`\<invoke name="functions\_\_exec\_command">`,
      String.raw`\<parameter name="cmd">powershell -NoProfile -Command "Get-ChildItem -Force | Select-Object Name,Length,Mode"\</parameter>`,
      String.raw`\<parameter name="workdir">C:\Users\User\Documents\ChatGPT\Flag Clicker\</parameter>`,
      String.raw`\<parameter name="yield\_time\_ms" string="false">10000\</parameter>`,
      String.raw`\<parameter name="max\_output\_tokens" string="false">2000\</parameter>`,
      String.raw`\</invoke>`,
      String.raw`\</tool\_calls>`,
    ].join("\n");

    expect(parseDeepSeekToolRequests(output, parsed)).toEqual([{
      name: "functions__exec_command",
      arguments: {
        cmd: 'powershell -NoProfile -Command "Get-ChildItem -Force | Select-Object Name,Length,Mode"',
        workdir: String.raw`C:\Users\User\Documents\ChatGPT\Flag Clicker`,
        yield_time_ms: 10000,
        max_output_tokens: 2000,
      },
    }]);
  });

  test("accepts DeepSeek's escaped argument-tag tool markup used by GUI calculator turns", () => {
    const parsed = parsedRequest();
    parsed.context.tools = [{
      namespace: "functions",
      name: "exec_command",
      description: "Run a command",
      parameters: {
        type: "object",
        properties: {
          cmd: { type: "string" },
          workdir: { type: "string" },
        },
        required: ["cmd"],
      },
    }];
    const output = [
      "I'll create a polished GUI calculator app and a matching test suite. Let me check the workspace first so I don't overwrite anything you already have.",
      String.raw`\<tool\_calls>`,
      String.raw`\<invoke name="functions\_\_exec\_command">`,
      String.raw`\<argument name="cmd">Get-ChildItem -Force | Select-Object Mode,Length,Name\</argument>`,
      String.raw`\<argument name="workdir">C:\Users\User\Documents\ChatGPT\Calculator\</argument>`,
      String.raw`\</invoke>`,
      String.raw`\</tool\_calls>`,
    ].join("\n");

    expect(parseDeepSeekToolRequests(output, parsed)).toEqual([{
      name: "functions__exec_command",
      arguments: {
        cmd: "Get-ChildItem -Force | Select-Object Mode,Length,Name",
        workdir: String.raw`C:\Users\User\Documents\ChatGPT\Calculator`,
      },
    }]);
  });

  test("repairs the hybrid unterminated DSML envelope from the reported stuck turns", () => {
    const parsed = parsedRequest();
    parsed.context.tools = [
      {
        namespace: "functions",
        name: "exec_command",
        description: "Run a command",
        parameters: { type: "object", properties: { cmd: { type: "string" } } },
      },
      {
        namespace: "functions",
        name: "apply_patch",
        description: "Apply a patch",
        parameters: { type: "object", properties: { input: { type: "string" } } },
        freeform: true,
      },
    ];

    for (const closer of ["</｜｜DSML｜｜", "</｜｜DSML｜｜>"]) {
      const execOutput = [
        "I'll fix the truncated header now.",
        "<tool_calls>",
        String.raw`<invoke name="exec\_command">`,
        '<parameter name="cmd">Get-Content src\\Core\\OffsetValidator.hpp</parameter>',
        "</invoke>",
        closer,
      ].join("\n");
      expect(parseDeepSeekToolRequests(execOutput, parsed)).toEqual([{
        name: "functions__exec_command",
        arguments: { cmd: "Get-Content src\\Core\\OffsetValidator.hpp" },
      }]);
    }

    const patchInput = [
      "*** Begin Patch",
      "*** Update File: src/Core/OffsetValidator.hpp",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n");
    const patchOutput = [
      "I'll clean it up immediately.",
      "<tool_calls>",
      String.raw`<invoke name="apply\_patch">`,
      `<parameter name="input">${patchInput}`,
      "</invoke>",
      "</｜｜DSML｜｜",
    ].join("\n");
    expect(parseDeepSeekToolRequests(patchOutput, parsed)).toEqual([{
      name: "functions__apply_patch",
      arguments: { input: patchInput },
    }]);

    const ambiguousDamage = [
      "<tool_calls>",
      '<invoke name="exec_command">',
      '<parameter name="cmd">bun --version',
      '<parameter name="workdir">C:\\workspace',
      "</invoke>",
      "</｜｜DSML｜｜",
    ].join("\n");
    expect(() => parseDeepSeekToolRequests(ambiguousDamage, parsed))
      .toThrow("unsupported parameter markup");
  });

  test("repairs a terminal invoke with a missing tool_calls close but never a prose example", () => {
    const parsed = parsedRequest();
    parsed.context.tools = [{
      name: "exec_command",
      description: "Run a command",
      parameters: { type: "object", properties: { cmd: { type: "string" } } },
    }];
    const truncated = [
      "<tool_calls>",
      '<invoke name="exec_command">',
      '<parameter name="cmd">bun --version</parameter>',
      "</invoke>",
    ].join("\n");
    expect(parseDeepSeekToolRequests(truncated, parsed)).toEqual([{
      name: "exec_command",
      arguments: { cmd: "bun --version" },
    }]);

    const example = [
      "Here is a transport-format example:",
      truncated,
      "</｜｜DSML｜｜",
      "Do not execute this example.",
    ].join("\n");
    expect(parseDeepSeekToolRequests(example, parsed)).toBeUndefined();
    expect(deepSeekResponseRecoveryReason(example)).toBeUndefined();
    expect(deepSeekResponseRecoveryReason("ordinary prose\n</｜｜DSML｜｜")).toBeUndefined();
  });

  test("tries raw and Markdown tool representations before requesting protocol correction", () => {
    const parsed = parsedRequest();
    parsed.context.tools = [{
      namespace: "functions",
      name: "exec_command",
      description: "Run a command",
      parameters: { type: "object" },
    }];
    const malformedRaw = '<tool_calls>{"name":</tool_calls>';
    const validMarkdown = '{"codex_tool_calls":[{"name":"functions__exec_command","arguments":{"cmd":"rg --files"}}]}';

    expect(parseDeepSeekToolResponseCandidates([malformedRaw, validMarkdown], parsed)).toEqual({
      requests: [{ name: "functions__exec_command", arguments: { cmd: "rg --files" } }],
    });

    const failed = parseDeepSeekToolResponseCandidates([
      malformedRaw,
      '<request_tool>{"name":</request_tool>',
    ], parsed);
    expect(failed.requests).toBeUndefined();
    expect(failed.protocolError).toBeInstanceOf(DeepSeekToolProtocolError);
    expect(failed.protocolError?.message).toContain("valid JSON");
  });

  test("accepts conventional qualified separators only when they resolve to an advertised tool", () => {
    const parsed = parsedRequest();
    parsed.context.tools = [{
      namespace: "functions",
      name: "exec_command",
      description: "Run a command",
      parameters: { type: "object" },
    }];
    for (const name of ["functions.exec_command", "functions/exec_command", "functions::exec_command"]) {
      expect(parseDeepSeekToolRequests(
        JSON.stringify({ codex_tool_calls: [{ name, arguments: { cmd: "rg" } }] }),
        parsed,
      )).toEqual([{ name: "functions__exec_command", arguments: { cmd: "rg" } }]);
    }
    expect(() => parseDeepSeekToolRequests(
      '{"codex_tool_calls":[{"name":"other.exec_command","arguments":{}}]}',
      parsed,
    )).toThrow("did not advertise");
  });

  test("accepts DeepSeek's direct JSON tool_calls wrapper when its opening array bracket is dropped", () => {
    const parsed = parsedRequest();
    parsed.context.tools = [{
      namespace: "functions",
      name: "apply_patch",
      description: "Apply a patch",
      parameters: {
        type: "object",
        properties: { input: { type: "string" } },
        required: ["input"],
      },
      freeform: true,
    }];
    const output = [
      "I'll create the file now.",
      "<tool_calls>",
      "{",
      String.raw`"name":"functions\_\_apply\_patch",`,
      String.raw`"input":"*** Begin Patch\n*** Add File: demo.txt\n+hello\n*** End Patch"`,
      "}",
      "]",
    ].join("\n");

    expect(parseDeepSeekToolRequests(output, parsed)).toEqual([{
      name: "functions__apply_patch",
      arguments: {
        input: [
          "*** Begin Patch",
          "*** Add File: demo.txt",
          "+hello",
          "*** End Patch",
        ].join("\n"),
      },
    }]);
  });

  test("resolves an unqualified DeepSeek tool name to one advertised namespaced tool", () => {
    const parsed = parsedRequest();
    parsed.context.tools = [{
      namespace: "functions",
      name: "exec_command",
      description: "Run a command",
      parameters: {
        type: "object",
        properties: { cmd: { type: "string" } },
      },
    }];

    const output = [
      "I'll build a small Rust binary that pulls words from a bundled list and prints a random one.",
      '<tool_calls>',
      '<invoke name="exec_command">',
      '<parameter name="cmd">rustc --version; cargo --version</parameter>',
      '</invoke>',
      '</tool_calls>',
    ].join("\n");

    expect(parseDeepSeekToolRequests(output, parsed)).toEqual([{
      name: "functions__exec_command",
      arguments: { cmd: "rustc --version; cargo --version" },
    }]);

    expect(parseDeepSeekToolRequests(
      '{"codex_tool_calls":[{"name":"exec_command","arguments":{"cmd":"cargo --version"}}]}',
      parsed,
    )).toEqual([{
      name: "functions__exec_command",
      arguments: { cmd: "cargo --version" },
    }]);
  });

  test("rejects an unqualified DeepSeek tool name when multiple namespaces advertise it", () => {
    const parsed = parsedRequest();
    parsed.context.tools = [
      {
        namespace: "functions",
        name: "exec_command",
        description: "Run a command",
        parameters: { type: "object" },
      },
      {
        namespace: "other",
        name: "exec_command",
        description: "Another command tool",
        parameters: { type: "object" },
      },
    ];

    expect(() => parseDeepSeekToolRequests(
      '<tool_calls><invoke name="exec_command"><parameter name="cmd">cargo --version</parameter></invoke></tool_calls>',
      parsed,
    )).toThrow("did not advertise: exec_command");
  });

  test("accepts DeepSeek's terminal DSML tool-call wrapper", () => {
    const parsed = parsedRequest();
    parsed.context.tools = [{
      namespace: "functions",
      name: "exec_command",
      description: "Run a command",
      parameters: {
        type: "object",
        properties: {
          cmd: { type: "string" },
          workdir: { type: "string" },
        },
      },
    }];
    const output = [
      "I'll build a small Rust calculator app for you.",
      String.raw`\\\<｜｜DSML｜｜ tool\\\_calls\"> &#x20;`,
      String.raw`{"name":"functions\\_\\_exec\\_command","arguments":{"cmd":"rustc --version && cargo --version","workdir":"C:\\Users\\User\\Documents\\Calc"}}`,
      String.raw`\\\</｜｜DSML｜｜>`,
    ].join("\n");

    expect(parseDeepSeekToolRequests(output, parsed)).toEqual([{
      name: "functions__exec_command",
      arguments: {
        cmd: "rustc --version && cargo --version",
        workdir: String.raw`C:\Users\User\Documents\Calc`,
      },
    }]);
  });

  test("accepts DeepSeek's DSML invoke and string-parameter dialect", () => {
    const parsed = parsedRequest();
    parsed.context.tools = [{
      namespace: "functions",
      name: "exec_command",
      description: "Run a command",
      parameters: {
        type: "object",
        properties: {
          cmd: { type: "string" },
          workdir: { type: "string" },
        },
      },
    }];
    const output = [
      "I'll build a basic random word generator in Rust. Let me set up a small Cargo project and implement it.",
      '<｜｜DSML｜｜tool_calls>',
      '<｜｜DSML｜｜invoke name="functions__exec_command">',
      '<｜｜DSML｜｜parameter name="cmd" string="true">cargo init random-word --name random_word 2>&1; Get-ChildItem .</｜｜DSML｜｜parameter>',
      '<｜｜DSML｜｜argument name="workdir" string="true">C:\\Users\\User\\Documents\\ChatGPT\\EAC bypass</｜｜DSML｜｜argument>',
      '</｜｜DSML｜｜invoke>',
      '</｜｜DSML｜｜tool_calls>',
    ].join("\n");

    expect(parseDeepSeekToolRequests(output, parsed)).toEqual([{
      name: "functions__exec_command",
      arguments: {
        cmd: "cargo init random-word --name random_word 2>&1; Get-ChildItem .",
        workdir: "C:\\Users\\User\\Documents\\ChatGPT\\EAC bypass",
      },
    }]);
  });

  test("accepts DSML whose renderer escapes JSON quotes without re-escaping Windows paths", () => {
    const parsed = parsedRequest();
    parsed.context.tools = [{
      namespace: "functions",
      name: "exec_command",
      description: "Run a command",
      parameters: {
        type: "object",
        properties: {
          cmd: { type: "string" },
          workdir: { type: "string" },
        },
      },
    }];
    const output = [
      "I'll build a small Rust calculator app for you.",
      String.raw`\\<｜｜DSML｜｜ tool\\_calls\"> &#x20;`,
      String.raw`{\"name\":\"functions\\_\\_exec\\_command\",\"arguments\":{\"cmd\":\"rustc --version && cargo --version\",\"workdir\":\"C:\\Users\\User\\Documents\\ChatGPT\\Calc\"}}`,
      String.raw`\\</｜｜DSML｜｜>`,
    ].join("\n");

    expect(parseDeepSeekToolRequests(output, parsed)).toEqual([{
      name: "functions__exec_command",
      arguments: {
        cmd: "rustc --version && cargo --version",
        workdir: String.raw`C:\Users\User\Documents\ChatGPT\Calc`,
      },
    }]);
  });

  test("accepts DeepSeek's terminal request_tool dialect with flattened rendered arguments", () => {
    const parsed = parsedRequest();
    parsed.context.tools = [{
      namespace: "functions",
      name: "exec_command",
      description: "Run a command",
      parameters: {
        type: "object",
        properties: {
          cmd: { type: "string" },
          login: { type: "boolean" },
          max_output_tokens: { type: "integer" },
          sandbox_permissions: { type: "string" },
          shell: { type: "string" },
          tty: { type: "boolean" },
          workdir: { type: "string" },
          yield_time_ms: { type: "integer" },
        },
      },
    }];
    const output = [
      "I'll build a small calculator GUI with a nice modern look, plus a PySide6 test suite that drives the real UI.",
      "First, let me check what's available in the environment.",
      String.raw`\\\<request\\\_tool>`,
      String.raw`{\"name\":\"functions\_\_exec\_command\",\"cmd\":\"python --version; pip show PySide6 PySide6-Essentials pytest pytest-qt\",\"login\":true,\"max\_output\_tokens\":2000,\"sandbox\_permissions\":\"use_default\",\"shell\":\"powershell\",\"tty\":false,\"workdir\":\"C:\Users\User\Documents\ChatGPT\EAC bypass\",\"yield\_time\_ms\":10000}`,
      String.raw`\\\</request\\\_tool>`,
    ].join("\n");

    expect(parseDeepSeekToolRequests(output, parsed)).toEqual([{
      name: "functions__exec_command",
      arguments: {
        cmd: "python --version; pip show PySide6 PySide6-Essentials pytest pytest-qt",
        login: true,
        max_output_tokens: 2000,
        sandbox_permissions: "use_default",
        shell: "powershell",
        tty: false,
        workdir: String.raw`C:\Users\User\Documents\ChatGPT\EAC bypass`,
        yield_time_ms: 10000,
      },
    }]);
  });

  test("preserves literal Windows backslashes while normalizing request_tool identifiers", () => {
    const parsed = parsedRequest();
    parsed.context.tools = [{
      namespace: "functions",
      name: "exec_command",
      description: "Run a command",
      parameters: { type: "object" },
    }];
    const output = String.raw`<request_tool>{"name":"functions\_\_exec\_command","workdir":"C:\Users\User\_workspace","max\_output\_tokens":2000}</request_tool>`;

    expect(parseDeepSeekToolRequests(output, parsed)).toEqual([{
      name: "functions__exec_command",
      arguments: {
        workdir: String.raw`C:\Users\User\_workspace`,
        max_output_tokens: 2000,
      },
    }]);
  });

  test("accepts nested request_tool argument containers and consecutive terminal calls", () => {
    const parsed = parsedRequest();
    parsed.context.tools = [{
      namespace: "functions",
      name: "exec_command",
      description: "Run a command",
      parameters: { type: "object" },
    }];
    const output = [
      "Running two independent checks.",
      '<request_tool>{"name":"functions__exec_command","arguments":{"cmd":"python --version"}}</request_tool>',
      '<request_tool>{"name":"exec_command","args":{"cmd":"bun --version"}}</request_tool>',
    ].join("\n");

    expect(parseDeepSeekToolRequests(output, parsed)).toEqual([
      { name: "functions__exec_command", arguments: { cmd: "python --version" } },
      { name: "functions__exec_command", arguments: { cmd: "bun --version" } },
    ]);
  });

  test("accepts request_tool renderer line decoration, JSON5-ish payloads, arrays, and stringified arguments", () => {
    const parsed = parsedRequest();
    parsed.context.tools = [{
      namespace: "functions",
      name: "exec_command",
      description: "Run a command",
      parameters: { type: "object" },
    }];
    const decorated = [
      String.raw`\\<request\\_tool>\\`,
      String.raw`[{name:'functions\_\_exec\_command',arguments:'{"cmd":"python --version","workdir":"C:\\Users\\User\\_workspace"}',},]\\`,
      String.raw`\\</request\\_tool>`,
    ].join("\n");

    expect(parseDeepSeekToolRequests(decorated, parsed)).toEqual([{
      name: "functions__exec_command",
      arguments: {
        cmd: "python --version",
        workdir: String.raw`C:\Users\User\_workspace`,
      },
    }]);
  });

  test("accepts bounded renderer quote and tag escape-depth variants", () => {
    const parsed = parsedRequest();
    parsed.context.tools = [{
      namespace: "functions",
      name: "exec_command",
      description: "Run a command",
      parameters: { type: "object" },
    }];
    const canonical = JSON.stringify({
      name: "functions__exec_command",
      cmd: "python --version",
      workdir: String.raw`C:\Users\User\workspace`,
      max_output_tokens: 2000,
    });

    for (let depth = 0; depth <= 4; depth += 1) {
      let body = canonical.replace(/_/g, "\\_");
      for (let quoteDepth = 0; quoteDepth < depth; quoteDepth += 1) {
        body = body.replace(/"/g, '\\"');
      }
      const slashes = "\\".repeat(depth + 1);
      const open = `${slashes}<request${slashes}_tool>`;
      const close = `${slashes}</request${slashes}_tool>`;
      expect(parseDeepSeekToolRequests(`${open}\n${body}\n${close}`, parsed)).toEqual([{
        name: "functions__exec_command",
        arguments: {
          cmd: "python --version",
          workdir: String.raw`C:\Users\User\workspace`,
          max_output_tokens: 2000,
        },
      }]);
    }
  });

  test("does not execute a request_tool example followed by ordinary assistant prose", () => {
    const parsed = parsedRequest();
    parsed.context.tools = [{
      name: "exec_command",
      description: "Run a command",
      parameters: { type: "object" },
    }];
    expect(parseDeepSeekToolRequests(
      '<request_tool>{"name":"exec_command","cmd":"rg --files"}</request_tool>\nThis is only an example.',
      parsed,
    )).toBeUndefined();
  });

  test("rejects malformed or ambiguous terminal request_tool payloads instead of leaking them as prose", () => {
    const parsed = parsedRequest();
    parsed.context.tools = [{
      name: "exec_command",
      description: "Run a command",
      parameters: { type: "object" },
    }];
    expect(() => parseDeepSeekToolRequests(
      '<request_tool>{"name":"exec_command","cmd":}</request_tool>',
      parsed,
    )).toThrow("request_tool payload must contain valid JSON");
    expect(() => parseDeepSeekToolRequests(
      '<request_tool>{"name":"exec_command","arguments":{"cmd":"a"},"cmd":"b"}</request_tool>',
      parsed,
    )).toThrow("mixes nested and flattened arguments");
  });

  test("accepts renderer-escaped preferred JSON envelopes without weakening advertised-tool validation", () => {
    const parsed = parsedRequest();
    parsed.context.tools = [{
      namespace: "functions",
      name: "exec_command",
      description: "Run a command",
      parameters: { type: "object" },
    }];
    const output = String.raw`{\"codex\_tool\_calls\":[{\"name\":\"functions\_\_exec\_command\",\"arguments\":{\"cmd\":\"cargo --version\"}}]}`;
    expect(parseDeepSeekToolRequests(output, parsed)).toEqual([{
      name: "functions__exec_command",
      arguments: { cmd: "cargo --version" },
    }]);

    const unadvertised = String.raw`<request_tool>{"name":"other\_tool","cmd":"whoami"}</request_tool>`;
    expect(() => parseDeepSeekToolRequests(unadvertised, parsed)).toThrow("did not advertise: other_tool");
  });

  test("accepts DeepSeek's escaped-parenthesis rendering of the preferred tool-call array", () => {
    const parsed = parsedRequest();
    parsed.context.tools = [{
      namespace: "functions",
      name: "exec_command",
      description: "Run a command",
      parameters: { type: "object" },
    }];
    const output = String.raw`{\"codex\_tool\_calls\":\\({\"name\":\"functions\\\_\\\_exec\\\_command\",\"arguments\":{\"cmd\":\"powershell -NoProfile -Command \\\"Get-ChildItem -Force | Select-Object Name,Length,LastWriteTime | Format-Table -AutoSize\\\"\",\"workdir\":\"C:\\Users\\User\\Documents\\ChatGPT\\EAC bypass\",\"yield\_time\_ms\":10000,\"max\_output\_tokens\":4000}}\\)}`;

    expect(parseDeepSeekToolRequests(output, parsed)).toEqual([{
      name: "functions__exec_command",
      arguments: {
        cmd: 'powershell -NoProfile -Command "Get-ChildItem -Force | Select-Object Name,Length,LastWriteTime | Format-Table -AutoSize"',
        workdir: String.raw`C:\Users\User\Documents\ChatGPT\EAC bypass`,
        yield_time_ms: 10000,
        max_output_tokens: 4000,
      },
    }]);
  });

  test("accepts the escaped-parenthesis command shape emitted by DeepSeek for quoted PowerShell paths", () => {
    const parsed = parsedRequest();
    parsed.context.tools = [{
      namespace: "functions",
      name: "exec_command",
      description: "Run a command",
      parameters: { type: "object" },
    }];
    const output = String.raw`{\"codex\\_tool\\_calls\":\\\\({\"name\":\"functions\\\\\\_\\\\\\_exec\\\\\\_command\",\"arguments\":{\"cmd\":\"New-Item -ItemType Directory -Force -Path \"C:\\Users\\User\\Documents\\ChatGPT\\EAC bypass\\ccp-flag-clicker\" | Out-Null; Write-Output \"dir ready\"\",\"workdir\":\"C:\\Users\\User\\Documents\\ChatGPT\\EAC bypass\"}}\\\\)}`;

    expect(parseDeepSeekToolRequests(output, parsed)).toEqual([{
      name: "functions__exec_command",
      arguments: {
        cmd: 'New-Item -ItemType Directory -Force -Path "C:\\Users\\User\\Documents\\ChatGPT\\EAC bypass\\ccp-flag-clicker" | Out-Null; Write-Output "dir ready"',
        workdir: String.raw`C:\Users\User\Documents\ChatGPT\EAC bypass`,
      },
    }]);
  });

  test("accepts a single preferred tool object and stringified preferred arguments", () => {
    const parsed = parsedRequest();
    parsed.context.tools = [{
      namespace: "functions",
      name: "exec_command",
      description: "Run a command",
      parameters: { type: "object" },
    }];
    expect(parseDeepSeekToolRequests(
      '{"codex_tool_calls":{"name":"functions__exec_command","arguments":"{\\"cmd\\":\\"bun --version\\"}"}}',
      parsed,
    )).toEqual([{
      name: "functions__exec_command",
      arguments: { cmd: "bun --version" },
    }]);
  });

  test("fails closed on unterminated request_tool markup", () => {
    const parsed = parsedRequest();
    parsed.context.tools = [{
      name: "exec_command",
      description: "Run a command",
      parameters: { type: "object" },
    }];
    expect(() => parseDeepSeekToolRequests(
      '<request_tool>{"name":"exec_command","cmd":"rg --files"}',
      parsed,
    )).toThrow("malformed request_tool markup");
  });

  test("does not execute tool-like markup when it is followed by ordinary assistant prose", () => {
    const parsed = parsedRequest();
    parsed.context.tools = [{
      name: "exec_command",
      description: "Run a command",
      parameters: { type: "object" },
    }];
    expect(parseDeepSeekToolRequests(
      "<tool_calls><invoke name=\"exec_command\"><parameter name=\"cmd\">rg --files</parameter></invoke></tool_calls>\nThis is only an example.",
      parsed,
    )).toBeUndefined();
  });

  test("turns native Codex tool results into a same-chat DeepSeek follow-up", () => {
    const parsed = parsedRequest();
    parsed.context.tools = [{
      name: "exec_command",
      description: "Run a command",
      parameters: { type: "object", properties: { cmd: { type: "string" } } },
    }];
    parsed.context.messages.push({
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "deepseek_abcdef123456_0",
        name: "exec_command",
        arguments: { cmd: "cargo --version" },
      }],
      timestamp: 5,
    });
    parsed.context.messages.push({
      role: "toolResult",
      toolCallId: "deepseek_abcdef123456_0",
      toolName: "exec_command",
      content: "cargo 1.90.0",
      isError: false,
      timestamp: 6,
    });

    expect(deepSeekToolContinuationTraceId(parsed)).toBe("abcdef123456");
    const followUp = compileDeepSeekWebFollowUpPrompt(parsed, "abcdef123456");
    expect(followUp?.text).toContain("Codex executed the tool call(s) you requested");
    expect(followUp?.text).toContain("cargo 1.90.0");
    expect(followUp?.text).not.toContain('status="success"');
    expect(followUp?.text).not.toContain("First question");
    expect(followUp?.text).not.toContain("Earlier answer");
  });

  test("continues after an image-producing tool without claiming a default success status", () => {
    const parsed = parsedRequest();
    parsed.context.tools = [{
      name: "view_image",
      description: "Inspect an image",
      parameters: { type: "object" },
    }];
    parsed.context.messages.push({
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "deepseek_abcdef123456_0",
        name: "view_image",
        arguments: { path: "sample.png" },
      }],
      timestamp: 5,
    });
    parsed.context.messages.push({
      role: "toolResult",
      toolCallId: "deepseek_abcdef123456_0",
      toolName: "view_image",
      content: [
        { type: "text", text: "Image loaded." },
        { type: "image", imageUrl: "data:image/png;base64,AA==" },
      ],
      isError: false,
      timestamp: 6,
    });

    expect(deepSeekPromptContainsImages(parsed)).toBe(false);
    const followUp = compileDeepSeekWebFollowUpPrompt(parsed, "abcdef123456");
    expect(followUp?.text).toContain("Image loaded.");
    expect(followUp?.text).toContain("[image omitted: DeepSeek Web routes are text-only]");
    expect(followUp?.text).not.toContain('status="success"');
  });

  test("honors Codex tool choice and parallel-call restrictions", () => {
    const parsed = parsedRequest();
    parsed.context.tools = [
      { name: "first", description: "first", parameters: { type: "object" } },
      { name: "second", description: "second", parameters: { type: "object" } },
    ];
    parsed.options.toolChoice = { allowedTools: ["second"], mode: "required" };
    parsed.options.parallelToolCalls = false;
    expect(deepSeekEffectiveTools(parsed).map(tool => tool.name)).toEqual(["second"]);
    expect(() => parseDeepSeekToolRequests(
      '{"codex_tool_calls":[{"name":"second","arguments":{}},{"name":"second","arguments":{}}]}',
      parsed,
    )).toThrow("disabled parallel tool calls");
    expect(() => parseDeepSeekToolRequests(
      '<request_tool>{"name":"second"}</request_tool>\n<request_tool>{"name":"second"}</request_tool>',
      parsed,
    )).toThrow("disabled parallel tool calls");
  });

  test("translates DeepSeek tool requests into native Codex adapter events", () => {
    const events: import("../src/types").AdapterEvent[] = [];
    emitDeepSeekToolRequests(
      [{ name: "exec_command", arguments: { cmd: "rg --files" } }],
      "trace123",
      { inputTokens: 10, outputTokens: 4, totalTokens: 14, estimated: true },
      event => events.push(event),
    );
    expect(events).toEqual([
      { type: "tool_call_start", id: "deepseek_trace123_0", name: "exec_command" },
      { type: "tool_call_delta", arguments: '{"cmd":"rg --files"}' },
      { type: "tool_call_end" },
      {
        type: "done",
        stopReason: "tool_use",
        endTurn: false,
        usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14, estimated: true },
      },
    ]);
  });

  test("detects image history before committing a browser response", () => {
    const parsed = parsedRequest();
    parsed.context.messages.push({
      role: "user",
      content: [{ type: "image", imageUrl: "data:image/png;base64,AA==" }],
      timestamp: 5,
    });
    expect(deepSeekPromptContainsImages(parsed)).toBe(true);
  });

  test("requires continuously observed composite completion evidence", () => {
    const explicit = new DeepSeekCompletionTracker(100, 1_000);
    expect(explicit.update(snapshot(), 0)).toBe(false);
    expect(explicit.update(snapshot(), 99)).toBe(false);
    expect(explicit.update(snapshot(), 100)).toBe(true);

    const fallback = new DeepSeekCompletionTracker(100, 1_000, 300);
    const noActions = snapshot({ completionActionPresent: false });
    expect(fallback.update(noActions, 0)).toBe(false);
    expect(fallback.update(noActions, 299)).toBe(false);
    expect(fallback.update(noActions, 300)).toBe(true);

    const stillRunning = new DeepSeekCompletionTracker(100, 1_000, 300);
    const running = snapshot({ running: true, completionActionPresent: false });
    expect(stillRunning.update(running, 0)).toBe(false);
    expect(stillRunning.update(running, 300)).toBe(false);

    const busyRetry = new DeepSeekCompletionTracker(100, 1_000, 300);
    const retryVisible = snapshot({ retryActionPresent: true, completionActionPresent: false });
    expect(busyRetry.update(retryVisible, 0)).toBe(false);
    expect(busyRetry.update(retryVisible, 500)).toBe(false);

    const observationGap = new DeepSeekCompletionTracker(100, 250);
    expect(observationGap.update(snapshot(), 0)).toBe(false);
    expect(observationGap.update(snapshot(), 250)).toBe(false);
  });

  test("does not treat a transient running state as a fresh continuation response", () => {
    const baseline = snapshot({
      finalHtml: "<p>previous answer</p>",
      finalText: "previous answer",
      finalTextLength: 15,
      activitySignature: "previous:idle:actions",
    });
    const runningWithoutNewResponse = snapshot({
      running: true,
      completionActionPresent: false,
      finalHtml: baseline.finalHtml,
      finalText: baseline.finalText,
      finalTextLength: baseline.finalTextLength,
      activitySignature: "previous:running:no-actions",
    });
    const idleAgainWithoutNewResponse = snapshot({
      finalHtml: baseline.finalHtml,
      finalText: baseline.finalText,
      finalTextLength: baseline.finalTextLength,
      activitySignature: "previous:idle:actions",
    });
    const freshResponse = snapshot({
      finalHtml: "<p>I'll write the game file now.</p>",
      finalText: "I'll write the game file now.",
      finalTextLength: 29,
      activitySignature: "fresh:idle:actions",
    });

    expect(deepSeekContinuationResponseChanged(baseline, runningWithoutNewResponse)).toBe(false);
    expect(deepSeekContinuationResponseChanged(baseline, idleAgainWithoutNewResponse)).toBe(false);
    expect(deepSeekContinuationResponseChanged(baseline, freshResponse)).toBe(true);
  });

  test("treats a new assistant bubble as fresh even when its text is identical", () => {
    const baseline = snapshot({
      responseIdentity: "message:3:assistant:2",
      finalHtml: "<p>Retrying the tool call.</p>",
      finalText: "Retrying the tool call.",
      finalRawText: "Retrying the tool call.",
    });
    const repeated = snapshot({
      responseIdentity: "message:5:assistant:3",
      finalHtml: baseline.finalHtml,
      finalText: baseline.finalText,
      finalRawText: baseline.finalRawText,
    });

    expect(deepSeekContinuationResponseChanged(baseline, repeated)).toBe(true);
  });

  test("treats renderer-preserved tool markup as fresh continuation content", () => {
    const baseline = snapshot({
      finalHtml: "",
      finalText: "",
      finalRawText: '<request_tool>{"name":"first"}</request_tool>',
      finalTextLength: 48,
    });
    const current = snapshot({
      finalHtml: "",
      finalText: "",
      finalRawText: '<request_tool>{"name":"second"}</request_tool>',
      finalTextLength: 49,
    });

    expect(deepSeekContinuationResponseChanged(baseline, current)).toBe(true);
  });

  test("fails a continuously missing response DOM without aging across observation gaps", () => {
    const missing = snapshot({
      responsePresent: false,
      running: false,
      completionActionPresent: false,
      finalHtml: "",
      finalTextLength: 0,
      activitySignature: "missing",
    });
    const tracker = new DeepSeekTurnDomHealthTracker(100, 100, 100, 250, 500);
    expect(tracker.update(missing, 0)).toBeUndefined();
    expect(tracker.update(missing, 99)).toBeUndefined();
    expect(tracker.update(missing, 100)).toContain("did not create a response DOM");

    const gapReset = new DeepSeekTurnDomHealthTracker(100, 100, 100, 250, 500);
    expect(gapReset.update(missing, 0)).toBeUndefined();
    expect(gapReset.update(missing, 250)).toBeUndefined();
    expect(gapReset.update(missing, 349)).toBeUndefined();
    expect(gapReset.update(missing, 350)).toContain("did not create a response DOM");
  });

  test("marks every post-submit browser failure non-retryable", () => {
    const failure = classifiedDeepSeekError(new DeepSeekBrowserTurnFailure(
      "DeepSeek Web failed after submission was attempted; automatic retry is disabled to avoid duplicate prompts: browser page closed unexpectedly",
      true,
    ));
    expect(failure.code).toBe("invalid_prompt");
    expect(failure.retryable).toBe(false);
    expect(failure.status).toBe(400);
    expect(failure.errorType).toBe("invalid_request_error");

    const stalled = classifiedDeepSeekError(new DeepSeekBrowserTurnFailure(
      "DeepSeek Web failed after submission was attempted; automatic retry is disabled to avoid duplicate prompts: no observable progress",
      true,
    ));
    expect(stalled.code).toBe("invalid_prompt");
    expect(stalled.retryable).toBe(false);
    expect(stalled.status).toBe(400);

    const cancelledAfterSubmit = classifiedDeepSeekError(new DeepSeekBrowserTurnFailure(
      "DeepSeek Web failed after submission was attempted; automatic retry is disabled to avoid duplicate prompts: the Codex request was cancelled after DeepSeek may have accepted the prompt",
      true,
    ));
    expect(cancelledAfterSubmit.code).toBe("invalid_prompt");
    expect(cancelledAfterSubmit.retryable).toBe(false);
    expect(cancelledAfterSubmit.status).toBe(400);
  });

  test("makes pre-submit UI contract drift non-retryable for streamed Codex turns", () => {
    const failure = classifiedDeepSeekError(new Error(
      "DeepSeek Web UI contract drift: visible Expert mode radio was not found",
    ));
    expect(failure.code).toBe("invalid_prompt");
    expect(failure.retryable).toBe(false);
    expect(failure.status).toBe(400);
  });

  test("never automatically replays runtime login, security, or transport failures", () => {
    const cases = [
      ["DeepSeek Web login expired during the turn", 401, "authentication_error"],
      ["DeepSeek Web entered a security challenge: AWS WAF", 403, "permission_error"],
      ["DeepSeek Web produced no observable progress for 120 minutes", 504, "upstream_timeout"],
      ["DeepSeek Web browser launch failed unexpectedly", 502, "upstream_error"],
    ] as const;

    for (const [message, status, errorType] of cases) {
      const failure = classifiedDeepSeekError(new Error(message));
      expect(failure.code).toBe("invalid_prompt");
      expect(failure.retryable).toBe(false);
      expect(failure.status).toBe(status);
      expect(failure.errorType).toBe(errorType);
    }
  });

  test("scopes duplicate suppression to the canonical Codex turn id", () => {
    const first = parsedRequest();
    first._rawBody = {
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread-one", turn_id: "turn-one" }),
      },
    };
    const retry = structuredClone(first);
    const later = structuredClone(first);
    (later._rawBody as { client_metadata: { [key: string]: string } }).client_metadata["x-codex-turn-metadata"] =
      JSON.stringify({ thread_id: "thread-one", turn_id: "turn-two" });

    expect(deepSeekRequestTurnIdentity(first)).toBe("turn-one");
    expect(deepSeekConversationKey(first, "deepseek-chat"))
      .toBe(deepSeekConversationKey(later, "deepseek-chat"));
    expect(deepSeekTraceId(first, first.modelId, "same prompt"))
      .toBe(deepSeekTraceId(retry, retry.modelId, "same prompt"));
    expect(deepSeekTraceId(first, first.modelId, "same prompt"))
      .not.toBe(deepSeekTraceId(later, later.modelId, "same prompt"));
  });

  test("recognizes only the official DeepSeek sign-in route as signed out", () => {
    expect(deepSeekSignInUrl("https://chat.deepseek.com/sign_in")).toBe(true);
    expect(deepSeekSignInUrl("https://chat.deepseek.com/sign_in/verify")).toBe(true);
    expect(deepSeekSignInUrl("https://chat.deepseek.com/a/chat/s/abc")).toBe(false);
    expect(deepSeekSignInUrl("https://example.com/sign_in")).toBe(false);
  });

  test("does not classify ordinary security vocabulary as an access-control block", () => {
    expect(deepSeekSecurityChallengeSignal(
      "Explain why a forbidden operation is different from a CAPTCHA implementation.",
    )).toBeUndefined();
    expect(deepSeekSecurityChallengeSignal("Security verification required")).toBe("Security verification");
    expect(deepSeekSecurityChallengeSignal("AWS WAF blocked this request")).toBe("AWS WAF");
  });

  test("fails missing login and unsupported images during preflight", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-deepseek-adapter-"));
    temporaryRoots.push(root);
    const statePath = join(root, "state.json");
    const adapter = createDeepSeekWebAdapter(provider(statePath));
    expect(() => adapter.validateTurn?.(parsedRequest(), { headers: new Headers() }))
      .toThrow("missing or unverified");

    writeFileSync(statePath, "{}\n");
    writeFileSync(deepSeekLoginVerificationMarkerPath(statePath), "{}\n");
    const withImage = parsedRequest();
    withImage.context.messages.push({
      role: "user",
      content: [{ type: "image", imageUrl: "data:image/png;base64,AA==" }],
      timestamp: 5,
    });
    expect(() => adapter.validateTurn?.(withImage, { headers: new Headers() }))
      .toThrow("text-only");
  });
});
