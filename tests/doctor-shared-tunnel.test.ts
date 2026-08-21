import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recentSharedTunnelRouteMissCount } from "../src/doctor";
import { parseTunnelStatus } from "../src/tunnel";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("shared tunnel diagnostics", () => {
  test("preserves the tunnel-client log path from runtime status", () => {
    const status = parseTunnelStatus(JSON.stringify({
      process_running: true,
      healthy: true,
      ready: true,
      runtime_state: "ready",
      local: { log: { path: "C:\\state\\tunnel-client\\codex.log" }, issues: [] },
    }));

    expect(status.logPath).toBe("C:\\state\\tunnel-client\\codex.log");
  });

  test("counts ownership misses only within the bounded recent log tail", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-shared-tunnel-"));
    roots.push(root);
    const log = join(root, "tunnel.log");
    const marker = "[chatgpt-web-mcp] shared-tunnel route miss scope=abc123\n";
    writeFileSync(log, `old ${marker}${"x".repeat(256)}\nrecent ${marker}${marker}`);

    expect(recentSharedTunnelRouteMissCount(log)).toBe(3);
    expect(recentSharedTunnelRouteMissCount(log, marker.length * 2)).toBe(2);
  });
});
