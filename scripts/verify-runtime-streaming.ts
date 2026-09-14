import { join, resolve } from "node:path";

/** Gate packaging on behavior of the actual payload, not just its version/hash. */
export async function verifyRuntimeStreaming(root: string, runtimeRoot: string): Promise<void> {
  const smoke = join(root, "dist", "smoke-runtime-streaming.mjs");
  const build = await Bun.build({
    entrypoints: [join(root, "scripts", "smoke-runtime-streaming.ts")],
    target: "node", packages: "external", outdir: join(root, "dist"), naming: "smoke-runtime-streaming.mjs",
  });
  if (!build.success) throw new Error(build.logs.map(log => log.message).join("\n"));
  const child = Bun.spawn([join(runtimeRoot, "runtime", "node.exe"), smoke, join(runtimeRoot, "app", "cli.js")], {
    cwd: root, stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`Packaged runtime streaming regression:\n${stdout}${stderr}`);
  process.stdout.write(stdout);
}

if (import.meta.main) {
  await verifyRuntimeStreaming(resolve(import.meta.dir, ".."), resolve(process.argv[2] ?? "dist/runtime"));
}
