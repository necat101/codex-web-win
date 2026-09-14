import { describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE as sourceBridge } from "../src/bridge";
import { installedBridge } from "./helpers/installed-bridge";
import type { AdapterEvent } from "../src/types";

const decoder = new TextDecoder();
const bridgeToResponsesSSE = process.env.HARNESS_BUNDLE_TEST_PATH
  ? installedBridge(process.env.HARNESS_BUNDLE_TEST_PATH)
  : sourceBridge;

async function* heartbeatThenText(): AsyncIterable<AdapterEvent> {
  yield { type: "heartbeat" };
  yield { type: "text_delta", text: "still alive" };
  yield { type: "done" };
}

async function* quietThenText(delayMs: number): AsyncIterable<AdapterEvent> {
  await new Promise(resolve => setTimeout(resolve, delayMs));
  yield { type: "text_delta", text: "tool finished" };
  yield { type: "done" };
}

async function* silentLongEnoughToTripWatchdog(delayMs: number): AsyncIterable<AdapterEvent> {
  await new Promise(resolve => setTimeout(resolve, delayMs));
  yield { type: "text_delta", text: "too late" };
}

describe("Responses bridge adapter heartbeat forwarding", () => {
  test.each([
    { hideThinkingSummary: true },
    { compaction: true },
  ])("keeps the client alive while upstream output is hidden: %j", async options => {
    async function* hiddenOutput(): AsyncIterable<AdapterEvent> {
      for (let i = 0; i < 30; i++) {
        await Bun.sleep(2);
        yield { type: "thinking_delta", thinking: "working" };
      }
      yield { type: "done" };
    }
    const stream = bridgeToResponsesSSE(hiddenOutput(), "chatgpt-web/high",
      undefined, undefined, undefined, undefined, 10, options);
    const reader = stream.getReader();
    await reader.read();
    try {
      expect(decoder.decode((await reader.read()).value)).toContain("event: response.heartbeat");
    } finally {
      await reader.cancel();
    }
  });

  test("does not persist a late completion after cancellation", async () => {
    let finish!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    const pending = new Promise<void>(resolve => { finish = resolve; });
    let completions = 0;
    async function* lateCompletion(): AsyncIterable<AdapterEvent> {
      started();
      await pending;
      yield { type: "done" };
    }
    const stream = bridgeToResponsesSSE(lateCompletion(), "chatgpt-web/high",
      undefined, undefined, undefined, undefined, 10,
      { onCompletedResponse: () => { completions++; } });
    const reader = stream.getReader();
    await reader.read();
    await waiting;
    await reader.cancel();
    finish();
    await Bun.sleep(20);
    expect(completions).toBe(0);
  });

  test("forwards an adapter heartbeat as an SSE frame before later output", async () => {
    const stream = bridgeToResponsesSSE(
      heartbeatThenText(),
      "chatgpt-web/high",
      undefined,
      undefined,
      undefined,
      undefined,
      60_000,
      { stallTimeoutSec: 120 },
    );
    const reader = stream.getReader();

    const created = await reader.read();
    expect(created.done).toBe(false);
    expect(decoder.decode(created.value)).toContain("event: response.created");

    const heartbeat = await reader.read();
    expect(heartbeat.done).toBe(false);
    expect(decoder.decode(heartbeat.value)).toBe(
      'event: response.heartbeat\ndata: {"type":"response.heartbeat"}\n\n',
    );

    await reader.cancel();
  });

  test("keeps a quiet default stream alive while upstream tool work is pending", async () => {
    const stream = bridgeToResponsesSSE(
      quietThenText(80),
      "chatgpt-web/high",
      undefined,
      undefined,
      undefined,
      undefined,
      10,
    );
    const reader = stream.getReader();

    expect(decoder.decode((await reader.read()).value)).toContain("event: response.created");

    let combined = "";
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      combined += decoder.decode(next.value);
    }

    expect(combined).toContain("event: response.heartbeat");
    expect(combined).toContain("tool finished");
    expect(combined.match(/event: response.completed/g)).toHaveLength(1);
    expect(combined).not.toContain("upstream_stall_timeout");
    await reader.cancel();
  });

  test("keeps emitting heartbeats while downstream pull stepping is gated", async () => {
    async function* quiet(): AsyncIterable<AdapterEvent> {
      await Bun.sleep(80);
      yield { type: "text_delta", text: "resumed" };
      yield { type: "done" };
    }

    const stream = bridgeToResponsesSSE(quiet(), "chatgpt-web/high",
      undefined, undefined, undefined, undefined, 10);
    const reader = stream.getReader();

    expect(decoder.decode((await reader.read()).value)).toContain("event: response.created");
    await Bun.sleep(35);
    const heartbeat = await reader.read();
    expect(heartbeat.done).toBe(false);
    expect(decoder.decode(heartbeat.value)).toContain("event: response.heartbeat");
    await reader.cancel();
  });

  test("completes a quiet tool-only round without requiring chat dialogue", async () => {
    async function* toolOnly(): AsyncIterable<AdapterEvent> {
      yield { type: "heartbeat" };
      await Bun.sleep(100);
      yield { type: "tool_call_start", id: "call_quiet", name: "exec_command" };
      yield { type: "tool_call_delta", arguments: '{"cmd":"echo ready"}' };
      yield { type: "tool_call_end" };
      yield { type: "done", stopReason: "tool_use", endTurn: false };
    }
    const stream = bridgeToResponsesSSE(toolOnly(), "chatgpt-web/high",
      undefined, undefined, undefined, undefined, 10);
    const combined = await new Response(stream).text();
    expect(combined).toContain("event: response.heartbeat");
    expect(combined).toContain('"call_id":"call_quiet"');
    expect(combined).toContain('"end_turn":false');
    expect(combined.match(/event: response.completed/g)).toHaveLength(1);
    expect(combined).not.toContain("response.output_text.delta");
    expect(combined).not.toContain("response.incomplete");
  });

  test("an explicitly configured watchdog still terminates a genuinely silent stream", async () => {
    const stream = bridgeToResponsesSSE(
      silentLongEnoughToTripWatchdog(1_250),
      "chatgpt-web/high",
      undefined,
      undefined,
      undefined,
      undefined,
      25,
      { stallTimeoutSec: 1 },
    );
    const reader = stream.getReader();

    expect(decoder.decode((await reader.read()).value)).toContain("event: response.created");

    let combined = "";
    while (!combined.includes("upstream_stall_timeout")) {
      const next = await reader.read();
      expect(next.done).toBe(false);
      combined += decoder.decode(next.value);
    }

    expect(combined).toContain("event: response.incomplete");
    expect(combined).toContain("upstream_stall_timeout");
    expect(combined).not.toContain("too late");
    await reader.cancel();
  });
});
