import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { loadConfig, providerConfig } from "../src/config";
import { createDeepSeekWebAdapter } from "../src/adapters/deepseek-web";
import { closeDeepSeekBrowserWorkers, DeepSeekBrowserWorker } from "../src/adapters/deepseek-web/browser-worker";
import { deepSeekLoginVerificationMarkerPath } from "../src/deepseek-browser-login";
import type { AdapterEvent, CodexParsedRequest } from "../src/types";

// Explicit live smoke. Uses only synthetic messages, a private copy of the
// DeepSeek session, and a harmless local probe tool. Never opens ChatGPT.
assert(!process.versions.bun, "Compile and run under the installed Node runtime");
const provider = providerConfig(loadConfig());
assert(provider.deepseekWeb?.enabled);
const root = mkdtempSync(join(tmpdir(), "deepseek-live-smoke-"));
try {
  const saved = provider.deepseekWeb.storageStatePath!;
  const isolated = join(root, "state.json");
  copyFileSync(saved, isolated);
  copyFileSync(deepSeekLoginVerificationMarkerPath(saved), deepSeekLoginVerificationMarkerPath(isolated));
  provider.deepseekWeb = { ...provider.deepseekWeb, storageStatePath: isolated };
  const adapter = createDeepSeekWebAdapter(provider);
  const incoming = { headers: new Headers(), abortSignal: AbortSignal.timeout(180_000) };
  for (const mode of ["instant", "expert"]) {
    const request: CodexParsedRequest = {
      modelId: `deepseek-web/${mode}`, stream: true, options: { toolChoice: "required" }, _clientThreadId: randomUUID(),
      context: {
        systemPrompt: ["This is a harness integration test. Call the requested probe tool, then report its exact returned token."],
        tools: [{ name: "harness_probe", description: "Return a local test token", parameters: { type: "object", properties: {}, additionalProperties: false } }],
        messages: [{ role: "user", content: "Call harness_probe once. After its result arrives, reply with only the returned token.", timestamp: Date.now() }],
      },
    };
    const events: AdapterEvent[] = [];
    await adapter.validateTurn?.(request, incoming);
    await adapter.runTurn(request, incoming, event => events.push(event));
    const calls = events.filter((event): event is Extract<AdapterEvent, { type: "tool_call_start" }> => event.type === "tool_call_start");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.name, "harness_probe");
    assert(events.some(event => event.type === "done" && event.stopReason === "tool_use"));
    // Keep the sentinel Markdown-neutral. Turndown correctly escapes literal
    // underscores in rendered prose (PROBE_... -> PROBE\_...), which is
    // semantically identical Markdown but would make an exact string assertion
    // test serialization rather than same-chat tool-result fidelity.
    const token = `PROBE${randomUUID().replaceAll("-", "")}`;
    request.context.messages.push(
      { role: "assistant", content: [{ type: "toolCall", id: calls[0]!.id, name: "harness_probe", arguments: {} }], timestamp: Date.now() },
      { role: "toolResult", toolCallId: calls[0]!.id, toolName: "harness_probe", content: token, isError: false, timestamp: Date.now() },
    );
    request.options.toolChoice = "auto";
    events.length = 0;
    await adapter.runTurn(request, incoming, event => events.push(event));
    const text = events.flatMap(event => event.type === "text_delta" ? [event.text] : []).join("");
    assert(text.includes(token), "Final answer must contain the actual local tool result");
    assert(!events.some(event => event.type === "tool_call_start"), "Must finish after the tool result");
    console.log(`PASS: DeepSeek ${mode} live tool request and same-chat result continuation`);
  }
} catch (error) {
  const page = (DeepSeekBrowserWorker.forProvider(provider) as any).sessionPage;
  if (page && !page.isClosed()) {
    console.error("Latest rendered response:", await page.locator(".ds-markdown").last().evaluate((node: HTMLElement) => ({
      innerText: node.innerText,
      textContent: node.textContent,
      innerHTML: node.innerHTML,
    })).catch(() => undefined));
  }
  throw error;
} finally {
  await closeDeepSeekBrowserWorkers();
  rmSync(root, { recursive: true, force: true });
}
