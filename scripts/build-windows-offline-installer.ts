import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { assertRuntimeProvenance } from "./runtime-provenance";
import { verifyRuntimeStreaming } from "./verify-runtime-streaming";

if (process.platform !== "win32") {
  throw new Error("The offline Windows installer must be built on Windows");
}
if (process.arch !== "x64" && process.arch !== "arm64") {
  throw new Error(`Unsupported Windows installer architecture: ${process.arch}`);
}

const root = resolve(import.meta.dir, "..");
const runtimeRoot = resolve(process.argv[2] ?? join(root, "dist", "runtime"));
const output = resolve(
  process.argv[3] ?? join(root, "dist", `codex-chatgpt-web-windows-${process.arch}-setup.exe`),
);
const manifestPath = join(runtimeRoot, "manifest.json");
if (!existsSync(manifestPath)) {
  throw new Error(`Runtime manifest is missing: ${manifestPath}`);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
assertRuntimeProvenance(root, runtimeRoot);
await verifyRuntimeStreaming(root, runtimeRoot);
const tunnelClientTarget = process.arch === "arm64" ? "windows-arm64" : "windows-amd64";
const tunnelClientPath = "vendor/tunnel-client/tunnel-client.exe";
if (manifest.platform !== "win32"
  || manifest.arch !== process.arch
  || manifest.launcher !== "bin/codex-chatgpt-web.exe"
  || manifest.gui !== "bin/codex-chatgpt-web-gui.exe"
  || manifest.uninstaller !== "bin/codex-chatgpt-web-uninstall.ps1"
  || manifest.tunnelClientBuild !== "0.0.12-codexweb-no-expiry.1"
  || manifest.tunnelClientTarget !== tunnelClientTarget
  || manifest.tunnelClientPath !== tunnelClientPath
  || typeof manifest.tunnelClientSha256 !== "string"
  || !/^[0-9a-f]{64}$/.test(manifest.tunnelClientSha256)) {
  throw new Error(`Runtime is not a complete Windows GUI bundle: ${JSON.stringify(manifest)}`);
}
const appVersion = manifest.appVersion;
if (typeof appVersion !== "string"
  || appVersion.length === 0
  || appVersion.trim() !== appVersion
  || /[\r\n]/.test(appVersion)) {
  throw new Error("Runtime manifest appVersion must be a nonempty, single-line string");
}
const launcher = join(runtimeRoot, "bin", "codex-chatgpt-web.exe");
const tunnelVendorDir = join(runtimeRoot, "vendor", "tunnel-client");
const tunnelClient = join(tunnelVendorDir, "tunnel-client.exe");
const tunnelReceipt = join(tunnelVendorDir, "BUILD-RECEIPT.json");
const tunnelLicense = join(tunnelVendorDir, "LICENSE.txt");
const tunnelNotice = join(tunnelVendorDir, "NOTICE.txt");
const tunnelPatch = join(tunnelVendorDir, "NO-EXPIRY.patch");
for (const required of [
  launcher,
  join(runtimeRoot, "bin", "codex-chatgpt-web-gui.exe"),
  join(runtimeRoot, "bin", "codex-chatgpt-web-uninstall.ps1"),
  join(root, "scripts", "install.ps1"),
  join(root, "LICENSE"),
  join(root, "LICENSES", "NOTICE.md"),
  join(root, "LICENSES", "OpenCodex-MIT.txt"),
  join(root, "LICENSES", "Bun-1.3.11.md"),
  join(root, "dist", "THIRD_PARTY_NOTICES.txt"),
  join(root, "docs", "windows.md"),
  tunnelClient,
  tunnelReceipt,
  tunnelLicense,
  tunnelNotice,
  tunnelPatch,
]) {
  if (!existsSync(required)) throw new Error(`Offline setup input is missing: ${required}`);
  if (statSync(required).size === 0) throw new Error(`Offline setup input is empty: ${required}`);
}

const tunnelClientSha256 = createHash("sha256").update(readFileSync(tunnelClient)).digest("hex");
if (tunnelClientSha256 !== manifest.tunnelClientSha256) {
  throw new Error(`Runtime tunnel-client SHA-256 does not match its manifest: ${tunnelClientSha256}`);
}
const tunnelBuildReceipt = JSON.parse(readFileSync(tunnelReceipt, "utf8")) as Record<string, unknown>;
if (tunnelBuildReceipt.schemaVersion !== 1
  || tunnelBuildReceipt.buildId !== manifest.tunnelClientBuild
  || tunnelBuildReceipt.target !== tunnelClientTarget.replace("-", "/")
  || tunnelBuildReceipt.binarySha256 !== tunnelClientSha256
  || tunnelBuildReceipt.upstreamCommit !== "881c9a8fed7cccbe6607cd419863bbca506b8215"
  || tunnelBuildReceipt.patch !== "patches/tunnel-client-v0.0.12-no-expiry.patch") {
  throw new Error(`Runtime tunnel-client build receipt is invalid: ${JSON.stringify(tunnelBuildReceipt)}`);
}

const launcherVersion = Bun.spawnSync([launcher, "--version"], {
  cwd: runtimeRoot,
  stdin: "ignore",
  stdout: "pipe",
  stderr: "pipe",
});
const launcherVersionStdout = launcherVersion.stdout.toString();
const launcherVersionStderr = launcherVersion.stderr.toString();
const expectedLauncherVersionStdout = `${appVersion}\n`;
if (launcherVersion.exitCode !== 0
  || launcherVersionStdout !== expectedLauncherVersionStdout
  || launcherVersionStderr !== "") {
  const describeOutput = (value: string): string => JSON.stringify(value.slice(0, 500));
  throw new Error(
    "Runtime launcher version preflight failed: "
      + `expected exitCode=0, stdout=${describeOutput(expectedLauncherVersionStdout)}, stderr=\"\"; `
      + `received exitCode=${launcherVersion.exitCode}, `
      + `stdout=${describeOutput(launcherVersionStdout)}, stderr=${describeOutput(launcherVersionStderr)}`,
  );
}

const windowsDirectory = process.env.WINDIR || "C:\\Windows";
const compiler = [
  join(windowsDirectory, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
  join(windowsDirectory, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
].find(candidate => existsSync(candidate));
if (!compiler) throw new Error("Offline setup build requires the built-in .NET Framework C# compiler");

const temporaryRoot = join(root, "dist", `.offline-installer-${process.pid}`);
const runtimeArchive = join(temporaryRoot, "runtime.zip");
const nextOutput = join(temporaryRoot, "codex-chatgpt-web-setup.next.exe");
const powershell = join(windowsDirectory, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const quotePowerShell = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const archiveCommand = [
  "$ErrorActionPreference = 'Stop'",
  // The built-in .NET API works even when PowerShell 7's inherited module
  // paths prevent Windows PowerShell from loading Microsoft.PowerShell.Archive.
  "Add-Type -AssemblyName System.IO.Compression.FileSystem",
  `[IO.Compression.ZipFile]::CreateFromDirectory(${quotePowerShell(runtimeRoot)}, `
    + `${quotePowerShell(runtimeArchive)}, [IO.Compression.CompressionLevel]::Optimal, $false)`,
].join("; ");
const encodedArchiveCommand = Buffer.from(archiveCommand, "utf16le").toString("base64");

rmSync(temporaryRoot, { recursive: true, force: true });
mkdirSync(temporaryRoot, { recursive: true });
try {
  const archive = Bun.spawnSync([
    powershell,
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    encodedArchiveCommand,
  ], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (archive.exitCode !== 0 || !existsSync(runtimeArchive)) {
    throw new Error(`Offline runtime ZIP failed: ${archive.stderr.toString() || archive.stdout.toString()}`);
  }

  const compile = Bun.spawnSync([
    compiler,
    "/nologo",
    "/optimize+",
    "/target:winexe",
    "/platform:anycpu",
    "/reference:System.Windows.Forms.dll",
    "/reference:System.Drawing.dll",
    "/reference:System.IO.Compression.dll",
    "/reference:System.IO.Compression.FileSystem.dll",
    `/win32manifest:${join(root, "scripts", "windows-offline-installer.manifest")}`,
    `/out:${nextOutput}`,
    `/resource:${runtimeArchive},CodexChatGptWeb.Runtime.zip`,
    `/resource:${join(root, "scripts", "install.ps1")},CodexChatGptWeb.Install.ps1`,
    `/resource:${join(root, "LICENSE")},CodexChatGptWeb.LICENSE`,
    `/resource:${join(root, "LICENSES", "NOTICE.md")},CodexChatGptWeb.NOTICE.md`,
    `/resource:${join(root, "LICENSES", "OpenCodex-MIT.txt")},CodexChatGptWeb.OpenCodex-MIT.txt`,
    `/resource:${join(root, "LICENSES", "Bun-1.3.11.md")},CodexChatGptWeb.Bun-1.3.11.md`,
    `/resource:${join(root, "dist", "THIRD_PARTY_NOTICES.txt")},CodexChatGptWeb.THIRD_PARTY_NOTICES.txt`,
    `/resource:${join(root, "docs", "windows.md")},CodexChatGptWeb.WINDOWS_SETUP.md`,
    join(root, "scripts", "windows-offline-installer.cs"),
  ], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (compile.exitCode !== 0 || !existsSync(nextOutput)) {
    throw new Error(`Offline setup failed to compile: ${compile.stderr.toString() || compile.stdout.toString()}`);
  }

  mkdirSync(dirname(output), { recursive: true });
  rmSync(output, { force: true });
  renameSync(nextOutput, output);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

process.stdout.write(`${output}\n`);
