import { describe, expect, test } from "bun:test";
import { negotiateTunnelSession, type TunnelRuntimeStatus } from "../src/tunnel";

const readyStatus: TunnelRuntimeStatus = {
  ok: true,
  processRunning: true,
  healthy: true,
  ready: true,
  state: "ready",
  detail: "process_running=true healthy=true ready=true",
};

describe("tunnel session negotiation", () => {
  test("starts before probing and does not preemptively stop a reusable runtime", async () => {
    const calls: string[] = [];
    const session = await negotiateTunnelSession({
      start: () => {
        calls.push("start");
      },
      status: async () => {
        calls.push("status");
        return readyStatus;
      },
      stop: () => {
        calls.push("stop");
      },
    });

    expect(calls).toEqual(["start", "status"]);
    await session.stop();
    expect(calls).toEqual(["start", "status", "stop"]);
  });

  test("cleans up exactly once when startup never becomes healthy", async () => {
    const calls: string[] = [];
    const failedStatus: TunnelRuntimeStatus = {
      ok: false,
      processRunning: true,
      healthy: false,
      ready: false,
      state: "starting",
      detail: "process_running=true; healthy=false; ready=false; state=starting",
    };

    await expect(negotiateTunnelSession({
      start: () => {
        calls.push("start");
      },
      status: async () => {
        calls.push("status");
        return failedStatus;
      },
      stop: () => {
        calls.push("stop");
      },
    })).rejects.toThrow("Tunnel runtime did not become healthy and ready");

    expect(calls).toEqual(["start", "status", "stop"]);
  });

  test("coalesces concurrent stop calls for a healthy session", async () => {
    let stopCalls = 0;
    let releaseStop!: () => void;
    const stopGate = new Promise<void>(resolve => {
      releaseStop = resolve;
    });
    const session = await negotiateTunnelSession({
      start: () => {},
      status: async () => readyStatus,
      stop: async () => {
        stopCalls += 1;
        await stopGate;
      },
    });

    const first = session.stop();
    const second = session.stop();
    expect(stopCalls).toBe(0);
    await Promise.resolve();
    expect(stopCalls).toBe(1);
    releaseStop();
    await Promise.all([first, second]);
    expect(stopCalls).toBe(1);
  });
});
