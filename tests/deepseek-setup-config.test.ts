import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  defaultConfig,
  loadConfig,
  saveConfig,
} from "../src/config";
import {
  applyDeepSeekSetupOptions,
  meaningfulRuntimeChange,
  setupRequestsRuntimeChange,
} from "../src/setup";

const roots: string[] = [];
const originalHome = process.env.CODEX_CHATGPT_WEB_HOME;

function isolatedHome(): string {
  const root = mkdtempSync(join(tmpdir(), "codex-deepseek-config-"));
  roots.push(root);
  process.env.CODEX_CHATGPT_WEB_HOME = root;
  return root;
}

function durableRuntimeCommand(): string[] {
  return process.platform === "win32"
    ? [join(process.env.SystemRoot ?? "C:\\Windows", "System32", "where.exe")]
    : ["/bin/sh"];
}

afterEach(() => {
  if (originalHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
  else process.env.CODEX_CHATGPT_WEB_HOME = originalHome;
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("DeepSeek Web setup configuration", () => {
  test("is opt-in disabled with browser state independent from ChatGPT", () => {
    isolatedHome();
    const config = defaultConfig("browser-only");

    expect(config.deepSeekWeb).toEqual({
      enabled: false,
      storageStatePath: join(process.env.CODEX_CHATGPT_WEB_HOME!, "browser", "deepseek-storage-state.json"),
    });
    expect(config.deepSeekWeb!.storageStatePath).not.toBe(config.storageStatePath);
  });

  test("loads older version-2 configs without enabling DeepSeek", () => {
    isolatedHome();
    const legacy = defaultConfig("browser-only");
    legacy.runtimeCommand = durableRuntimeCommand();
    delete legacy.deepSeekWeb;
    saveConfig(legacy);

    const loaded = loadConfig();
    expect(loaded.version).toBe(2);
    expect(loaded.deepSeekWeb?.enabled).toBe(false);
    expect(loaded.deepSeekWeb?.storageStatePath.endsWith("deepseek-storage-state.json")).toBe(true);
  });

  test("normalizes the independent ChatGPT and DeepSeek storage-state paths", () => {
    const home = isolatedHome();
    const config = defaultConfig("browser-only");
    config.runtimeCommand = durableRuntimeCommand();
    config.storageStatePath = join(home, "browser", "chatgpt", "..", "chatgpt-state.json");
    config.deepSeekWeb!.storageStatePath = join(home, "browser", "deepseek", "..", "deepseek-state.json");
    saveConfig(config);

    const loaded = loadConfig();
    expect(loaded.storageStatePath).toBe(resolve(home, "browser", "chatgpt-state.json"));
    expect(loaded.deepSeekWeb?.storageStatePath).toBe(resolve(home, "browser", "deepseek-state.json"));
  });

  test("rejects aliased ChatGPT and DeepSeek storage-state paths", () => {
    const home = isolatedHome();
    const config = defaultConfig("browser-only");
    config.runtimeCommand = durableRuntimeCommand();
    config.storageStatePath = join(home, "browser", "nested", "..", "shared-state.json");
    config.deepSeekWeb!.storageStatePath = join(home, "browser", "shared-state.json");
    saveConfig(config);

    expect(() => loadConfig()).toThrow(
      "ChatGPT and DeepSeek Web must use separate browser storage-state paths",
    );
  });

  test("rejects a persisted enabled block without its acknowledgement", () => {
    isolatedHome();
    const config = defaultConfig("browser-only");
    config.runtimeCommand = durableRuntimeCommand();
    config.deepSeekWeb = {
      enabled: true,
      storageStatePath: config.deepSeekWeb!.storageStatePath,
    };
    saveConfig(config);

    expect(() => loadConfig()).toThrow("enabled without an explicit acknowledgement");
  });

  test("requires an explicit acknowledgement before enabling", () => {
    isolatedHome();
    const config = defaultConfig("browser-only");

    expect(() => applyDeepSeekSetupOptions(config, { deepSeekEnabled: true }))
      .toThrow("explicit acknowledgement");

    applyDeepSeekSetupOptions(config, {
      deepSeekEnabled: true,
      acknowledgedDeepSeek: true,
    }, "2026-08-23T12:00:00.000Z");
    expect(config.deepSeekWeb).toMatchObject({
      enabled: true,
      acknowledgedAt: "2026-08-23T12:00:00.000Z",
    });
  });

  test("disabling retains the independent login path and acknowledgement", () => {
    isolatedHome();
    const config = defaultConfig("browser-only");
    applyDeepSeekSetupOptions(config, {
      deepSeekEnabled: true,
      acknowledgedDeepSeek: true,
    }, "2026-08-23T12:00:00.000Z");
    const enabled = structuredClone(config);
    const storageStatePath = config.deepSeekWeb!.storageStatePath;

    applyDeepSeekSetupOptions(config, { deepSeekEnabled: false });

    expect(config.deepSeekWeb).toEqual({
      enabled: false,
      storageStatePath,
      acknowledgedAt: "2026-08-23T12:00:00.000Z",
    });
    expect(meaningfulRuntimeChange(enabled, config)).toBe(true);
  });

  test("treats an explicit DeepSeek login refresh as a runtime change", () => {
    isolatedHome();
    const existing = defaultConfig("browser-only");
    applyDeepSeekSetupOptions(existing, {
      deepSeekEnabled: true,
      acknowledgedDeepSeek: true,
    });
    const unchanged = structuredClone(existing);

    expect(meaningfulRuntimeChange(existing, unchanged)).toBe(false);
    expect(setupRequestsRuntimeChange(existing, unchanged, { forceDeepSeekLogin: true })).toBe(true);
  });

  test("does not restart a runtime merely to refresh acknowledgement metadata", () => {
    isolatedHome();
    const before = defaultConfig("browser-only");
    const after = structuredClone(before);
    after.deepSeekWeb!.acknowledgedAt = "2026-08-23T12:00:00.000Z";

    expect(meaningfulRuntimeChange(before, after)).toBe(false);
  });
});
