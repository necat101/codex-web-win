import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { installedBridge } from "../tests/helpers/installed-bridge";
import type { AdapterEvent } from "../src/types";

// Run with the bundle's Node, not Bun: this checks the production HTTP/stream
// implementation and production heartbeat cadence, including the four-second
// false timeout in the original 0.2.19 installer. Never starts a browser.
if (process.versions.bun) throw new Error("Run this check with the packaged Node runtime");
const bundle = process.argv[2];
if (!bundle) throw new Error("Expected app/cli.js path");
const bridge = installedBridge(bundle);
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function* quietTool(): AsyncIterable<AdapterEvent> {
  yield { type: "heartbeat" };
  yield { type: "text_delta", text: "Before tool wait", phase: "commentary" };
  await delay(6_200);
  yield { type: "tool_call_start", id: "call_smoke", name: "exec_command" };
  yield { type: "tool_call_delta", arguments: '{"cmd":"echo ready"}' };
  yield { type: "tool_call_end" };
  yield { type: "done", stopReason: "tool_use", endTurn: false };
}
const server = createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.flushHeaders();
  void pipeline(Readable.fromWeb(bridge(quietTool(), "chatgpt-web/high") as never), response)
    .catch(error => response.destroy(error));
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
try {
  const address = server.address();
  assert(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}`, { signal: AbortSignal.timeout(12_000) });
  const reader = response.body!.getReader();
  let text = "", previous = Date.now(), largestGap = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    largestGap = Math.max(largestGap, Date.now() - previous);
    previous = Date.now();
    text += new TextDecoder().decode(chunk.value);
  }
  assert(!text.includes("response.incomplete"), "Quiet tool wait was terminated by the installed bridge");
  assert(!text.includes("response.failed"), "Installed bridge failed");
  assert.equal(text.match(/event: response.completed/g)?.length, 1, "Tool round must complete exactly once");
  assert(text.includes('"call_id":"call_smoke"'));
  assert(text.includes('"end_turn":false'));
  assert((text.match(/event: response.heartbeat/g)?.length ?? 0) >= 2, "Heartbeats must reach HTTP clients");
  assert(largestGap < 5_500, `No streaming liveness for ${largestGap}ms`);
  console.log(`PASS: packaged Node HTTP tool round survived 6.2s of silence (maximum frame gap ${largestGap}ms)`);
} finally {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
