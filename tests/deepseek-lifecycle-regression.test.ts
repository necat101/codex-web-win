import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeepSeekBrowserWorker, DeepSeekCompletionTracker } from "../src/adapters/deepseek-web/browser-worker";
import { compileDeepSeekWebFollowUpPrompt, compileDeepSeekWebContinuationPrompt } from "../src/adapters/deepseek-web/prompt";
import type { CodexParsedRequest } from "../src/types";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test.each(["tool", "user"])("archives oversized %s continuation without losing full context", kind => {
  const root = mkdtempSync(join(tmpdir(), "deepseek-delta-"));
  roots.push(root);
  const parsed: CodexParsedRequest = {
    modelId: "deepseek-web/expert", stream: true, options: {},
    context: {
      systemPrompt: ["Preserve instructions"],
      tools: [{ name: "exec_command", description: "Run command", parameters: { type: "object" } }],
      messages: [
        { role: "assistant", content: [{ type: "text", text: "Earlier answer" }], timestamp: 1 },
        kind === "tool"
          ? { role: "toolResult", toolCallId: "deepseek_abcdef123456_0", toolName: "exec_command", content: "START_SENTINEL " + "data ".repeat(15000) + " END_SENTINEL", isError: false, timestamp: 2 }
          : { role: "user", content: "START_SENTINEL " + "data ".repeat(15000) + " END_SENTINEL", timestamp: 2 },
      ],
    },
  };
  const options = { contextKey: "test-thread", contextDirectory: root };
  const compiled = kind === "tool"
    ? compileDeepSeekWebFollowUpPrompt(parsed, "abcdef123456", options)
    : compileDeepSeekWebContinuationPrompt(parsed, options);
  expect(compiled!.text.length).toBeLessThanOrEqual(48000);
  expect(compiled!.contextArchive).toBeDefined();
  const archive = readFileSync(compiled!.contextArchive!.path, "utf8");
  expect(archive).toContain("START_SENTINEL");
  expect(archive).toContain("END_SENTINEL");
  expect(archive).toContain("Preserve instructions");
});

// Exercise the real worker state machine with a deterministic browser boundary.
function fixture() {
  const worker = Object.create(DeepSeekBrowserWorker.prototype) as any;
  const context = { close: async () => {}, storageState: async () => ({ cookies: [], origins: [] }) };
  const composer = { waitFor: async () => {}, isEditable: async () => true };
  const page = {
    url: () => "https://chat.deepseek.com/", isClosed: () => false,
    goto: async () => ({ status: () => 200 }),
    locator: () => ({ filter: () => ({ first: () => composer }) }),
    waitForTimeout: async () => {},
  };
  Object.assign(worker, {
    config: { turnTimeoutMs: 1000, storageStatePath: "unused" },
    cancelledContexts: new WeakSet(),
    assertStoredLogin: () => {},
    ensureSession: async () => ({ browser: { isConnected: () => true }, context, page }),
    assertNotBlocked: async () => {}, selectMode: async () => {}, assertFreshChat: async () => {},
    insertPrompt: async () => {}, submitPrompt: async () => {},
    responseSnapshot: async () => ({ probeSucceeded: true, responsePresent: true, running: false,
      retryActionPresent: false, completionActionPresent: true, composerReady: true,
      finalHtml: "<p>done</p>", finalText: "done", finalTextLength: 4, activitySignature: "done" }),
  });
  const controller = new AbortController();
  const turn = { traceId: "abcdef123456", mode: "instant", prompt: "test", abortSignal: controller.signal, onTextDelta: () => {} };
  return { worker, context, controller, turn };
}

test.each(["startup", "insertion"])("cancellation during %s never submits a prompt", async stage => {
  const { worker, controller, turn } = fixture();
  const method = stage === "startup" ? "ensureSession" : "insertPrompt";
  const original = worker[method].bind(worker);
  worker[method] = async (...args: unknown[]) => { const value = await original(...args); controller.abort(); return value; };
  const submit = spyOn(worker, "submitPrompt");
  await expect(worker.runExclusive(turn)).rejects.toMatchObject({ name: "AbortError" });
  expect(submit).not.toHaveBeenCalled();
});

test("login persistence failure cannot erase a successfully completed answer", async () => {
  const { worker, turn } = fixture();
  // A directory cannot be replaced with the storage-state JSON file.
  const root = mkdtempSync(join(tmpdir(), "deepseek-state-"));
  roots.push(root);
  worker.config.storageStatePath = root;
  const complete = spyOn(DeepSeekCompletionTracker.prototype, "update").mockReturnValue(true);
  try { await expect(worker.runExclusive(turn)).resolves.toMatchObject({ markdown: "done" }); }
  finally { complete.mockRestore(); }
});

function modePage(controls: Array<{ kind: "toggle" | "radio"; label: string; pressed: boolean }>) {
  const locatorFor = (control: (typeof controls)[number]) => ({
    isVisible: async () => true,
    getAttribute: async (name: string) => {
      if (name === "aria-pressed" && control.kind === "toggle") return String(control.pressed);
      if (name === "aria-checked" && control.kind === "radio") return String(control.pressed);
      return null;
    },
    innerText: async () => control.label,
    click: async () => {
      if (control.kind === "toggle") control.pressed = !control.pressed;
      else {
        for (const candidate of controls) {
          if (candidate.kind === "radio") candidate.pressed = candidate === control;
        }
      }
    },
  });
  return {
    locator: (selector: string) => {
      const kind = selector.includes("aria-pressed") ? "toggle" : "radio";
      const matches = controls.filter(control => control.kind === kind);
      return { count: async () => matches.length, nth: (index: number) => locatorFor(matches[index]!) };
    },
    waitForTimeout: async () => {},
  };
}

test.each([
  ["instant", false],
  ["expert", true],
] as const)("maps %s onto the current DeepThink toggle and disables persisted Search", async (mode, expected) => {
  const worker = Object.create(DeepSeekBrowserWorker.prototype) as any;
  const controls = [
    { kind: "toggle", label: "DeepThink", pressed: !expected },
    { kind: "toggle", label: "Search", pressed: true },
  ] satisfies Array<{ kind: "toggle" | "radio"; label: string; pressed: boolean }>;
  await worker.selectMode(modePage(controls), mode);
  expect(controls[0]!.pressed).toBe(expected);
  expect(controls[1]!.pressed).toBe(false);
});

test("keeps the older Instant/Expert radio UI as a compatibility fallback", async () => {
  const worker = Object.create(DeepSeekBrowserWorker.prototype) as any;
  const controls = [
    { kind: "radio", label: "Instant", pressed: true },
    { kind: "radio", label: "Expert Mode", pressed: false },
  ] satisfies Array<{ kind: "toggle" | "radio"; label: string; pressed: boolean }>;
  await worker.selectMode(modePage(controls), "expert");
  expect(controls[0]!.pressed).toBe(false);
  expect(controls[1]!.pressed).toBe(true);
});
