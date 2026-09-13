import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { defaultConfig } from "../src/config";
import {
  ensurePinnedTunnelClient,
  negotiateTunnelSession,
  parseTunnelInstallManifest,
  tunnelClientBuildId,
  tunnelClientEnvironment,
  tunnelClientVersion,
  tunnelRuntimePolicyVersion,
  type PinnedTunnelClientOperations,
  type TunnelClientInstallOptions,
  type TunnelRuntimeStatus,
} from "../src/tunnel";
import { TUNNEL_MCP_CONNECTION_MAX_TTL, tunnelServiceDefinition } from "../src/tunnel-service";

const readyStatus: TunnelRuntimeStatus = {
  ok: true,
  processRunning: true,
  healthy: true,
  ready: true,
  state: "ready",
  detail: "process_running=true healthy=true ready=true",
};

function fullConfig(binaryPath: string) {
  const config = defaultConfig("full");
  config.tunnel = {
    binaryPath,
    tunnelId: `tunnel_${"a".repeat(32)}`,
    runtimeKeyFile: join("fixture", "runtime.key"),
    profileDir: join("fixture", "profiles"),
    profileName: "fixture",
    alias: "fixture",
  };
  return config;
}

describe("pinned tunnel-client lifecycle", () => {
  test("treats malformed install manifests as replaceable stale state", () => {
    expect(parseTunnelInstallManifest("{not valid JSON")).toBeUndefined();
    expect(parseTunnelInstallManifest("null")).toBeUndefined();
    expect(parseTunnelInstallManifest("[]")).toBeUndefined();
    expect(parseTunnelInstallManifest(JSON.stringify({
      version: 1,
      tunnelClientVersion: "0.0.12",
    }))).toBeDefined();
  });

  test("pins the shared-stdio deadline fix", () => {
    expect(tunnelClientVersion()).toBe("0.0.12");
    expect(tunnelClientBuildId()).toBe("0.0.12-codexweb-no-expiry.1");
    expect(tunnelRuntimePolicyVersion()).toBe(2);
  });

  test("disables the tunnel MCP connection expiry", () => {
    expect(TUNNEL_MCP_CONNECTION_MAX_TTL).toBe("0s");
    expect(tunnelClientEnvironment({ MCP_CONNECTION_MAX_TTL: "10m", PATH: "fixture" })).toEqual({
      MCP_CONNECTION_MAX_TTL: "0s",
      PATH: "fixture",
    });
    const definition = tunnelServiceDefinition(fullConfig(join("fixture", "tunnel-client")));
    expect(definition).toContain("<key>MCP_CONNECTION_MAX_TTL</key>");
    expect(definition).toContain("<string>0s</string>");
  });

  test("keeps a verified current binary and reusable runtime in place", async () => {
    const binaryPath = join("fixture", "bin", process.platform === "win32" ? "tunnel-client.exe" : "tunnel-client");
    const calls: string[] = [];
    const operations: PinnedTunnelClientOperations = {
      install: async (options?: TunnelClientInstallOptions) => {
        calls.push(options?.beforeReplace ? "validate" : "validate-without-hook");
        return binaryPath;
      },
      binaryExists: () => true,
      stop: () => {
        calls.push("stop");
      },
      persist: () => {
        calls.push("persist");
      },
      runtimePolicyCurrent: () => true,
      markRuntimePolicyCurrent: () => {
        calls.push("mark-policy");
      },
    };

    expect(await ensurePinnedTunnelClient(fullConfig(binaryPath), operations)).toBe(false);
    expect(calls).toEqual(["validate"]);
  });

  test("stops the old runtime only after the replacement payload is verified", async () => {
    const binaryPath = join("fixture", "bin", process.platform === "win32" ? "tunnel-client.exe" : "tunnel-client");
    const calls: string[] = [];
    const operations: PinnedTunnelClientOperations = {
      install: async (options?: TunnelClientInstallOptions) => {
        calls.push("payload-verified");
        await options?.beforeReplace?.();
        calls.push("binary-replaced");
        return binaryPath;
      },
      binaryExists: () => true,
      stop: () => {
        calls.push("old-runtime-stopped");
      },
      persist: () => {
        calls.push("persist");
      },
      runtimePolicyCurrent: () => true,
      markRuntimePolicyCurrent: () => {
        calls.push("mark-policy");
      },
    };

    expect(await ensurePinnedTunnelClient(fullConfig(binaryPath), operations)).toBe(true);
    expect(calls).toEqual(["payload-verified", "old-runtime-stopped", "binary-replaced"]);
  });

  test("installs a missing binary without issuing a meaningless stop", async () => {
    const binaryPath = join("fixture", "bin", process.platform === "win32" ? "tunnel-client.exe" : "tunnel-client");
    const calls: string[] = [];
    const operations: PinnedTunnelClientOperations = {
      install: async (options?: TunnelClientInstallOptions) => {
        await options?.beforeReplace?.();
        calls.push("installed");
        return binaryPath;
      },
      binaryExists: () => false,
      stop: () => {
        calls.push("stop");
      },
      persist: () => {
        calls.push("persist");
      },
      runtimePolicyCurrent: () => false,
      markRuntimePolicyCurrent: () => {
        calls.push("mark-policy");
      },
    };

    expect(await ensurePinnedTunnelClient(fullConfig(binaryPath), operations)).toBe(true);
    expect(calls).toEqual(["installed", "mark-policy"]);
  });

  test("migrates a legacy managed path and stops its runtime before reuse", async () => {
    const binaryPath = join("fixture", "bin", process.platform === "win32" ? "tunnel-client.exe" : "tunnel-client");
    const installedPath = join("managed", "bin", process.platform === "win32" ? "tunnel-client.exe" : "tunnel-client");
    const config = fullConfig(binaryPath);
    const calls: string[] = [];
    const operations: PinnedTunnelClientOperations = {
      install: async () => installedPath,
      binaryExists: () => true,
      stop: () => {
        calls.push("legacy-runtime-stopped");
      },
      persist: persisted => {
        calls.push(`persisted:${persisted.tunnel?.binaryPath}`);
      },
      runtimePolicyCurrent: () => true,
      markRuntimePolicyCurrent: () => {
        calls.push("mark-policy");
      },
    };

    expect(await ensurePinnedTunnelClient(config, operations)).toBe(true);
    expect(config.tunnel?.binaryPath).toBe(installedPath);
    expect(calls).toEqual(["legacy-runtime-stopped", `persisted:${installedPath}`]);
  });

  test("stops the managed replacement target and a distinct live stale configured runtime exactly once", async () => {
    const stalePath = join("fixture", "retired", process.platform === "win32" ? "tunnel-client.exe" : "tunnel-client");
    const managedPath = join("fixture", "managed", process.platform === "win32" ? "tunnel-client.exe" : "tunnel-client");
    const config = fullConfig(stalePath);
    const calls: string[] = [];
    const operations: PinnedTunnelClientOperations = {
      install: async options => {
        calls.push("payload-verified");
        await options?.beforeReplace?.(managedPath);
        calls.push("managed-binary-replaced");
        return managedPath;
      },
      binaryExists: path => path === stalePath || path === managedPath,
      stop: stopped => {
        calls.push(`stopped:${stopped.tunnel?.binaryPath}`);
      },
      persist: persisted => {
        calls.push(`persisted:${persisted.tunnel?.binaryPath}`);
      },
      runtimePolicyCurrent: () => true,
      markRuntimePolicyCurrent: () => {
        calls.push("mark-policy");
      },
    };

    expect(await ensurePinnedTunnelClient(config, operations)).toBe(true);
    expect(config.tunnel?.binaryPath).toBe(managedPath);
    expect(calls).toEqual([
      "payload-verified",
      `stopped:${managedPath}`,
      "managed-binary-replaced",
      `stopped:${stalePath}`,
      `persisted:${managedPath}`,
    ]);
  });

  test("does not persist a stale-path migration when retiring its distinct runtime fails", async () => {
    const stalePath = join("fixture", "retired", process.platform === "win32" ? "tunnel-client.exe" : "tunnel-client");
    const managedPath = join("fixture", "managed", process.platform === "win32" ? "tunnel-client.exe" : "tunnel-client");
    const config = fullConfig(stalePath);
    const calls: string[] = [];
    const operations: PinnedTunnelClientOperations = {
      install: async options => {
        calls.push("payload-verified");
        await options?.beforeReplace?.(managedPath);
        calls.push("managed-binary-replaced");
        return managedPath;
      },
      binaryExists: path => path === stalePath || path === managedPath,
      stop: stopped => {
        const path = stopped.tunnel!.binaryPath;
        calls.push(`stopped:${path}`);
        if (path === stalePath) throw new Error("stale runtime stop failed");
      },
      persist: () => {
        calls.push("persisted");
      },
      runtimePolicyCurrent: () => true,
      markRuntimePolicyCurrent: () => {
        calls.push("policy-marked");
      },
    };

    await expect(ensurePinnedTunnelClient(config, operations)).rejects.toThrow("stale runtime stop failed");
    expect(config.tunnel?.binaryPath).toBe(stalePath);
    expect(calls).toEqual([
      "payload-verified",
      `stopped:${managedPath}`,
      "managed-binary-replaced",
      `stopped:${stalePath}`,
    ]);
  });

  test("restarts an already-installed runtime exactly once for a new runtime policy", async () => {
    const binaryPath = join("fixture", "bin", process.platform === "win32" ? "tunnel-client.exe" : "tunnel-client");
    const calls: string[] = [];
    let policyCurrent = false;
    const operations: PinnedTunnelClientOperations = {
      install: async () => {
        calls.push("validate");
        return binaryPath;
      },
      binaryExists: () => true,
      stop: () => {
        calls.push("runtime-stopped");
      },
      persist: () => {
        calls.push("persist");
      },
      runtimePolicyCurrent: () => policyCurrent,
      markRuntimePolicyCurrent: () => {
        calls.push("policy-marked");
        policyCurrent = true;
      },
    };

    expect(await ensurePinnedTunnelClient(fullConfig(binaryPath), operations)).toBe(true);
    expect(await ensurePinnedTunnelClient(fullConfig(binaryPath), operations)).toBe(false);
    expect(calls).toEqual([
      "validate",
      "runtime-stopped",
      "policy-marked",
      "validate",
    ]);
  });

  test("does not mark a runtime policy current when the one-time stop fails", async () => {
    const binaryPath = join("fixture", "bin", process.platform === "win32" ? "tunnel-client.exe" : "tunnel-client");
    const calls: string[] = [];
    const operations: PinnedTunnelClientOperations = {
      install: async () => binaryPath,
      binaryExists: () => true,
      stop: () => {
        calls.push("runtime-stop-failed");
        throw new Error("stop failed");
      },
      persist: () => {
        calls.push("persist");
      },
      runtimePolicyCurrent: () => false,
      markRuntimePolicyCurrent: () => {
        calls.push("policy-marked");
      },
    };

    await expect(ensurePinnedTunnelClient(fullConfig(binaryPath), operations)).rejects.toThrow("stop failed");
    expect(calls).toEqual(["runtime-stop-failed"]);
  });
});

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
