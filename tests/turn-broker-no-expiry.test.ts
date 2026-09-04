import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";
import {
  callTurnBroker,
  closeTurnBrokers,
  TurnBroker,
  type BrokerToolResult,
} from "../src/adapters/chatgpt-web/turn-broker";

const environment: ChatGptTurnEnvironment = {
  cwd: process.cwd(),
  roots: [process.cwd()],
  writableRoots: [process.cwd()],
  sandboxPolicy: { type: "dangerFullAccess" },
  tools: [{
    name: "fixture_tool",
    description: "Fixture tool",
    parameters: { type: "object" },
  }],
};

afterEach(async () => {
  await closeTurnBrokers();
});

describe("ChatGPT turn broker capability lifetime", () => {
  test("survives arbitrary elapsed time and ends only on explicit revocation", async () => {
    const socketPath = join(tmpdir(), `codex-turn-broker-no-expiry-${process.pid}-${crypto.randomUUID()}.sock`);
    const broker = TurnBroker.forSocket(socketPath);
    const token = await broker.register(environment, "no-expiry-regression");
    const originalNow = Date.now;

    try {
      Date.now = () => originalNow() + (1_000 * 365 * 24 * 60 * 60_000);
      const claimed = await callTurnBroker<{
        bindingId: string;
        environment: ChatGptTurnEnvironment;
      }>(socketPath, { method: "claim", token });

      expect(claimed.environment).toEqual(environment);
      expect("expiresAt" in claimed.environment).toBe(false);

      const invocation = callTurnBroker<BrokerToolResult>(socketPath, {
        method: "invoke",
        bindingId: claimed.bindingId,
        wireName: "fixture_tool",
        arguments: { after: "one-thousand-years" },
      }, 0);
      const [request] = await broker.nextToolBatch(token);
      expect(request?.arguments).toEqual({ after: "one-thousand-years" });
      broker.completeTool(token, request!.callId, {
        content: [{ type: "text", text: "still active" }],
      });
      await expect(invocation).resolves.toEqual({
        content: [{ type: "text", text: "still active" }],
      });

      const cancelledInvocation = callTurnBroker<BrokerToolResult>(socketPath, {
        method: "invoke",
        bindingId: claimed.bindingId,
        wireName: "fixture_tool",
        arguments: { cancellation: "explicit" },
      }, 0);
      await broker.nextToolBatch(token);
      broker.revoke(token);
      await expect(cancelledInvocation).rejects.toThrow("Codex turn binding was revoked");
      await expect(callTurnBroker(socketPath, {
        method: "resolve",
        bindingId: claimed.bindingId,
      })).rejects.toThrow("binding id is invalid or revoked");
    } finally {
      Date.now = originalNow;
    }
  });

  test("aborts an unbounded queued invocation and removes it before delivery", async () => {
    const socketPath = join(tmpdir(), `codex-turn-broker-cancel-queued-${process.pid}-${crypto.randomUUID()}.sock`);
    const broker = TurnBroker.forSocket(socketPath);
    const token = await broker.register(environment, "cancel-queued-regression");
    const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    const abort = new AbortController();
    const invocation = callTurnBroker<BrokerToolResult>(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      wireName: "fixture_tool",
      arguments: { must_not_run: true },
    }, 0, abort.signal);

    expect(await broker.waitForPendingToolCountChange(token, 0, 1_000)).toBe(1);
    abort.abort();

    await expect(invocation).rejects.toMatchObject({ name: "AbortError" });
    expect(await broker.waitForPendingToolCountChange(token, 1, 1_000)).toBe(0);
    expect(broker.pendingToolCount(token)).toBe(0);

    const batchAbort = new AbortController();
    const noDelivery = broker.nextToolBatch(token, batchAbort.signal);
    batchAbort.abort();
    await expect(noDelivery).rejects.toMatchObject({ name: "AbortError" });
  });

  test("cancels a delivered pending invocation without leaving pending tool state", async () => {
    const socketPath = join(tmpdir(), `codex-turn-broker-cancel-pending-${process.pid}-${crypto.randomUUID()}.sock`);
    const broker = TurnBroker.forSocket(socketPath);
    const token = await broker.register(environment, "cancel-pending-regression");
    const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    const abort = new AbortController();
    const invocation = callTurnBroker<BrokerToolResult>(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      wireName: "fixture_tool",
      arguments: { cancelled_after_delivery: true },
    }, 0, abort.signal);
    const [request] = await broker.nextToolBatch(token);
    expect(request).toBeDefined();
    expect(broker.pendingToolCount(token)).toBe(1);

    abort.abort();

    await expect(invocation).rejects.toMatchObject({ name: "AbortError" });
    expect(await broker.waitForPendingToolCountChange(token, 1, 1_000)).toBe(0);
    expect(() => broker.completeTool(token, request!.callId, { content: [] }))
      .toThrow(`tool call is not pending: ${request!.callId}`);
  });
});
