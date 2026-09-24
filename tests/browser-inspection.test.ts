import { describe, expect, test } from "bun:test";
import { ChatGptBrowserWorker, ChatGptTurnDomHealthTracker } from "../src/adapters/chatgpt-web/browser-worker";

const healthy = {
  responsePresent: true, running: true, deliveryTimeoutPresent: false,
  toolConfirmationPresent: false, completionSignature: "", visibleText: "",
  visibleTextLength: 0, completionActionPresent: false, traceBlocks: [],
};
function worker(): any { return Object.create(ChatGptBrowserWorker.prototype); }

describe("browser response inspection recovery", () => {
  test("recovers a transient evaluation failure with a minimal read of the same page", async () => {
    const probes: any[] = [];
    const page = {
      isClosed: () => false,
      evaluate: async (_fn: unknown, args: any) => {
        probes.push(args);
        if (probes.length === 1) throw new Error("Execution context was destroyed during navigation");
        return healthy;
      },
    };
    const snapshot = await worker().responseDomSnapshot(page, 3, true, true, 2);
    expect(snapshot.probeSucceeded).toBe(true);
    expect(snapshot.running).toBe(true);
    expect(probes).toHaveLength(2);
    expect(probes[1]).toMatchObject({ responseIndex: 3, pendingToolCount: 2, basicProbe: true,
      scanRecoverySignals: false, scanTraceBlocks: false });
  });

  test("bounds retries and retains an actionable, content-free failure category", async () => {
    let calls = 0;
    const page = { isClosed: () => false, evaluate: async () => {
      calls++; throw new Error("page.evaluate: TypeError: private page text should not be logged");
    } };
    const snapshot = await worker().responseDomSnapshot(page, 0, true, true);
    expect(calls).toBe(2);
    expect(snapshot.probeSucceeded).toBe(false);
    expect(snapshot.probeError).toBe("browser inspection script TypeError");
    expect(JSON.stringify(snapshot)).not.toContain("private page text");
  });

  test.each([
    [true, "Target page, context or browser has been closed", "connection closed"],
    [false, "page.evaluate: Target crashed", "page crashed"],
  ])("reports a dead page without five minutes of retries", async (closed, message, expected) => {
    let calls = 0;
    const page = { isClosed: () => closed, evaluate: async () => { calls++; throw new Error(String(message)); } };
    await expect(worker().responseDomSnapshot(page, 0, true, true)).rejects.toThrow(String(expected));
    expect(calls).toBe(1);
  });

  test("tool work interrupts the continuous-failure clock even for short tool waits", () => {
    const tracker = new ChatGptTurnDomHealthTracker(20_000, 10_000, true, 20_000, 30_000);
    const failed = { responsePresent: false, running: false, currentText: "",
      completionActionPresent: false, probeSucceeded: false, probeError: "browser evaluation failed" };
    expect(tracker.update(failed, 0)).toBeUndefined();
    expect(tracker.update(failed, 19_000)).toBeUndefined();
    tracker.pauseForTools();
    expect(tracker.update(failed, 21_000)).toBeUndefined();
    expect(tracker.update(failed, 40_999)).toBeUndefined();
    expect(tracker.update(failed, 41_000)).toContain("browser evaluation failed");
  });
});
