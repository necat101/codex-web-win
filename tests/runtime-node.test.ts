import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findExecutable } from "../src/process";
import { defaultConfig } from "../src/config";
import { smokeNativeMcp } from "../scripts/smoke-native-mcp";

const scratch = mkdtempSync(join(tmpdir(), "codex-node-regression-"));
const bundle = join(scratch, "cli.mjs");
const node = findExecutable("node");

beforeAll(async () => {
  if (!node) throw new Error("Node must be on PATH to verify Windows runtime compatibility");
  const build = await Bun.build({ entrypoints: [resolve("src/cli.ts")], target: "node", packages: "bundle", minify: true,
    external: ["playwright-core"], outdir: scratch, naming: "cli.mjs" });
  expect(build.success).toBe(true);
  // Playwright carries package-relative assets and is intentionally external.
  const { symlinkSync, realpathSync } = await import("node:fs");
  symlinkSync(realpathSync("node_modules"), join(scratch, "node_modules"), process.platform === "win32" ? "junction" : "dir");
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("packaged Node runtime", () => {
  test("doctor returns a structured report with a valid config even without media tools", async () => {
    const appHome = join(scratch, "state");
    mkdirSync(appHome);
    const config = { ...defaultConfig(), mode: "browser-only", releaseVersion: "0.2.19" };
    writeFileSync(join(appHome, "config.json"), JSON.stringify(config));
    const child = Bun.spawn([node!, bundle, "doctor", "--json"], {
      env: { ...process.env, CODEX_CHATGPT_WEB_HOME: appHome, CODEX_HOME: join(scratch, "codex"), PATH: "", Path: "" },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    await child.exited;
    expect(stderr).not.toContain("Bun is not defined");
    expect(JSON.parse(stdout).checks).toContainEqual(expect.objectContaining({ id: "media-tools", status: "warning" }));
  }, 15_000);

  test("binds the native environment and returns several consecutive tool results", async () => {
    await smokeNativeMcp(node!, [bundle]);
  }, 15_000);
});
