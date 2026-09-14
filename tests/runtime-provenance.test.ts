import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertRuntimeProvenance, fileSha256, sourceSha256 } from "../scripts/runtime-provenance";

test("installer rejects stale same-version sources and modified payloads", () => {
  const root = mkdtempSync(join(tmpdir(), "runtime-provenance-"));
  try {
    for (const directory of ["src", "scripts", "runtime/app"]) mkdirSync(join(root, directory), { recursive: true });
    writeFileSync(join(root, "package.json"), '{"version":"0.2.10"}');
    writeFileSync(join(root, "bun.lock"), "lock");
    writeFileSync(join(root, "src/main.ts"), "original");
    const runtime = join(root, "runtime");
    const cli = join(runtime, "app/cli.js");
    writeFileSync(cli, "payload");
    writeFileSync(join(runtime, "manifest.json"), JSON.stringify({
      appVersion: "0.2.10", sourceSha256: sourceSha256(root), entrypointSha256: fileSha256(cli),
    }));
    expect(() => assertRuntimeProvenance(root, runtime)).not.toThrow();
    writeFileSync(cli, "changed payload");
    expect(() => assertRuntimeProvenance(root, runtime)).toThrow("cli.js differs");
    writeFileSync(cli, "payload");
    writeFileSync(join(root, "src/main.ts"), "new fix, same version");
    expect(() => assertRuntimeProvenance(root, runtime)).toThrow("does not match this checkout");
    writeFileSync(join(root, "src/main.ts"), "original");
    writeFileSync(join(root, "src/new.ts"), "new module");
    expect(() => assertRuntimeProvenance(root, runtime)).toThrow("does not match this checkout");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
