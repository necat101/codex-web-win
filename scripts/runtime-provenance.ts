import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Include paths and bytes so same-version builds can be distinguished. */
export function sourceSha256(root: string): string {
  const files = ["package.json", "bun.lock"];
  const visit = (directory: string) => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  visit("src");
  visit("scripts");
  const hash = createHash("sha256");
  for (const file of files.sort()) hash.update(file).update("\0").update(fileSha256(join(root, file))).update("\n");
  return hash.digest("hex");
}

export function assertRuntimeProvenance(root: string, runtime: string): void {
  const manifest = JSON.parse(readFileSync(join(runtime, "manifest.json"), "utf8"));
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  if (manifest.appVersion !== version || manifest.sourceSha256 !== sourceSha256(root)) {
    throw new Error("Runtime does not match this checkout. Run bun run build:windows before packaging the installer.");
  }
  if (manifest.entrypointSha256 !== fileSha256(join(runtime, "app", "cli.js"))) {
    throw new Error("Runtime cli.js differs from its build fingerprint. Rebuild before packaging the installer.");
  }
}
