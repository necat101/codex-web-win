import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface PackageMetadata {
  version?: string;
}

interface RuntimeManifest {
  schemaVersion?: number;
  appVersion?: string;
  platform?: string;
  launcher?: string;
  tunnelClientBuild?: string;
  tunnelClientTarget?: string;
  tunnelClientPath?: string;
  tunnelClientSha256?: string;
}

const projectRoot = resolve(import.meta.dir, "..");
const packageMetadata = JSON.parse(
  readFileSync(join(projectRoot, "package.json"), "utf8"),
) as PackageMetadata;
const packageVersion = packageMetadata.version;
const setupPath = resolve(
  process.argv[2] ?? join(projectRoot, "dist", `codex-chatgpt-web-windows-${process.arch}-setup.exe`),
);
const smokePrefix = "codex-chatgpt-web-installer-smoke-";

function fail(message: string): never {
  throw new Error(message);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

function normalized(path: string): string {
  const full = resolve(path).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? full.toLowerCase() : full;
}

function assertWithin(root: string, candidate: string, label: string): void {
  const child = relative(resolve(root), resolve(candidate));
  assert(
    child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`)),
    `${label} escaped the isolated smoke root: ${candidate}`,
  );
}

async function run(
  executable: string,
  args: string[],
  options: { env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<CommandResult> {
  const child = Bun.spawn([executable, ...args], {
    env: options.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutPromise = new Response(child.stdout).text();
  const stderrPromise = new Response(child.stderr).text();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, options.timeoutMs ?? 15_000);
  const exitCode = await child.exited;
  clearTimeout(timeout);
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  if (timedOut) {
    fail(`${basename(executable)} ${args.join(" ")} timed out\n${stderr || stdout}`);
  }
  return { exitCode, stdout, stderr };
}

function powershellPath(): string {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

async function captureUserIntegrationState(): Promise<string> {
  const script = String.raw`
$ErrorActionPreference = "Stop"
function Get-SmokeSha256([string]$path) {
  $stream = [IO.File]::OpenRead($path)
  try {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
      return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "")
    } finally {
      $sha.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}
$shortcutName = "Codex ChatGPT Web.lnk"
$shortcutPaths = @(
  (Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::Programs)) $shortcutName),
  (Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)) $shortcutName)
)
$shortcuts = foreach ($path in $shortcutPaths) {
  if (Test-Path -LiteralPath $path -PathType Leaf) {
    [ordered]@{
      path = $path
      sha256 = Get-SmokeSha256 $path
    }
  } else {
    [ordered]@{ path = $path; sha256 = $null }
  }
}
$registrationPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexChatGPTWeb"
$registration = $null
if (Test-Path -LiteralPath $registrationPath) {
  $item = Get-ItemProperty -LiteralPath $registrationPath
  $registration = [ordered]@{
    DisplayName = [string]$item.DisplayName
    DisplayVersion = [string]$item.DisplayVersion
    InstallLocation = [string]$item.InstallLocation
    DisplayIcon = [string]$item.DisplayIcon
    UninstallString = [string]$item.UninstallString
    QuietUninstallString = [string]$item.QuietUninstallString
    NoModify = [int]$item.NoModify
    NoRepair = [int]$item.NoRepair
  }
}
[ordered]@{
  userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  registration = $registration
  shortcuts = @($shortcuts)
} | ConvertTo-Json -Compress -Depth 5
`;
  const result = await run(
    powershellPath(),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { timeoutMs: 20_000 },
  );
  assert(result.exitCode === 0, `could not snapshot user integration state: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

async function processesRunningFrom(root: string): Promise<string[]> {
  const encodedRoot = Buffer.from(root, "utf16le").toString("base64");
  const script = String.raw`
$ErrorActionPreference = "Stop"
$root = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String("${encodedRoot}"))
@(Get-CimInstance Win32_Process | Where-Object {
  $_.ExecutablePath -and (
    [IO.Path]::GetFullPath($_.ExecutablePath).StartsWith(
      [IO.Path]::GetFullPath($root).TrimEnd("\") + "\",
      [StringComparison]::OrdinalIgnoreCase))
} | ForEach-Object { "{0}|{1}" -f $_.ProcessId, $_.ExecutablePath }) | ConvertTo-Json -Compress
`;
  const result = await run(
    powershellPath(),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { timeoutMs: 20_000 },
  );
  assert(result.exitCode === 0, `could not inspect installed processes: ${result.stderr || result.stdout}`);
  const text = result.stdout.trim();
  if (!text || text === "null") return [];
  const parsed = JSON.parse(text) as unknown;
  return Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
}

function decodeSidecar(path: string, expectedLineCount: number): { raw: string; values: string[] } {
  const raw = readFileSync(path, "utf8");
  const lines = raw.split(/\r?\n/);
  assert(lines.length === expectedLineCount, `${basename(path)} has ${lines.length} lines; expected ${expectedLineCount}`);
  assert(lines[0] === "v1", `${basename(path)} has an unsupported schema`);
  return {
    raw,
    values: lines.slice(1).map(value => Buffer.from(value, "base64").toString("utf8")),
  };
}

function assertExactPath(actual: string, expected: string, root: string, label: string): void {
  assert(normalized(actual) === normalized(expected), `${label} did not preserve the custom path\nexpected: ${expected}\nactual:   ${actual}`);
  assertWithin(root, actual, label);
}

function withoutInheritedOverrides(): Record<string, string> {
  const excluded = new Set([
    "codex_chatgpt_web_version",
    "codex_chatgpt_web_bin_dir",
    "codex_chatgpt_web_lib_dir",
    "codex_chatgpt_web_doc_dir",
    "codex_chatgpt_web_home",
  ]);
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !excluded.has(entry[0].toLowerCase()),
    ),
  );
}

if (process.platform !== "win32") {
  process.stdout.write("WINDOWS_INSTALLER_SMOKE_SKIPPED\n");
  process.exit(0);
}

assert(packageVersion, "package.json has no version");
assert(existsSync(setupPath), `Windows offline setup does not exist: ${setupPath}`);

const tempBase = resolve(tmpdir());
const root = mkdtempSync(join(tempBase, smokePrefix));
const alternateProfile = join(root, "Profiles", "Morgan Example \u03a9");
const binDir = join(alternateProfile, "Local App Data", "Programs", "Codex ChatGPT Web", "bin");
const libDir = join(alternateProfile, "Local App Data", "Programs", "Codex ChatGPT Web", "runtime library");
const docDir = join(alternateProfile, "Documents", "Codex ChatGPT Web docs");
const appHome = join(alternateProfile, "Private application state");

try {
  for (const [label, path] of Object.entries({ alternateProfile, binDir, libDir, docDir, appHome })) {
    assertWithin(root, path, label);
  }

  const integrationBefore = await captureUserIntegrationState();
  const environment = withoutInheritedOverrides();
  const install = await run(
    setupPath,
    [
      "--quiet",
      "--no-launch",
      "--no-path",
      "--no-desktop-shortcut",
      "--no-shortcuts",
      "--no-register",
      "--bin-dir", binDir,
      "--lib-dir", libDir,
      "--doc-dir", docDir,
      "--app-home", appHome,
    ],
    { env: environment, timeoutMs: 120_000 },
  );
  assert(install.exitCode === 0, `offline setup failed (${install.exitCode}): ${install.stderr || install.stdout}`);

  const integrationAfter = await captureUserIntegrationState();
  assert(integrationAfter === integrationBefore, "offline setup changed PATH, uninstall registration, or a user shortcut despite isolation flags");
  const unexpectedProcesses = await processesRunningFrom(root);
  assert(unexpectedProcesses.length === 0, `--no-launch left installed processes running: ${unexpectedProcesses.join(", ")}`);

  const launcher = join(binDir, "codex-chatgpt-web.exe");
  const gui = join(binDir, "codex-chatgpt-web-gui.exe");
  const launcherSidecarPath = join(binDir, "codex-chatgpt-web.launcher");
  const installSidecarPath = join(binDir, "codex-chatgpt-web.install");
  const installedRuntime = join(libDir, packageVersion);
  const manifestPath = join(installedRuntime, "manifest.json");
  for (const [label, path] of Object.entries({ launcher, gui, launcherSidecarPath, installSidecarPath, manifestPath })) {
    assert(existsSync(path), `installed ${label} is missing: ${path}`);
    assertWithin(root, path, label);
  }

  const manifestText = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(manifestText) as RuntimeManifest;
  assert(manifest.schemaVersion === 1, `unexpected installed manifest schema: ${manifest.schemaVersion}`);
  assert(manifest.appVersion === packageVersion, `installed manifest version is ${manifest.appVersion}; expected ${packageVersion}`);
  assert(manifest.platform === "win32", `installed manifest platform is ${manifest.platform}`);
  assert(manifest.launcher === "bin/codex-chatgpt-web.exe", `unexpected installed launcher: ${manifest.launcher}`);
  const expectedTunnelTarget = process.arch === "arm64" ? "windows-arm64" : "windows-amd64";
  assert(manifest.tunnelClientBuild === "0.0.12-codexweb-no-expiry.1", `unexpected installed tunnel-client build: ${manifest.tunnelClientBuild}`);
  assert(manifest.tunnelClientTarget === expectedTunnelTarget, `unexpected installed tunnel-client target: ${manifest.tunnelClientTarget}`);
  assert(manifest.tunnelClientPath === "vendor/tunnel-client/tunnel-client.exe", `unexpected installed tunnel-client path: ${manifest.tunnelClientPath}`);
  assert(typeof manifest.tunnelClientSha256 === "string" && /^[0-9a-f]{64}$/.test(manifest.tunnelClientSha256), "installed tunnel-client hash is missing or invalid");

  const expectedVendorDir = join(projectRoot, "dist", "runtime", "vendor", "tunnel-client");
  const installedVendorDir = join(installedRuntime, "vendor", "tunnel-client");
  const vendorNames = ["tunnel-client.exe", "LICENSE.txt", "NOTICE.txt", "BUILD-RECEIPT.json", "NO-EXPIRY.patch"];
  const vendorHashes: string[] = [];
  for (const name of vendorNames) {
    const expectedPath = join(expectedVendorDir, name);
    const installedPath = join(installedVendorDir, name);
    assert(existsSync(expectedPath), `release runtime vendor payload is missing: ${expectedPath}`);
    assert(existsSync(installedPath), `installed vendor payload is missing: ${installedPath}`);
    assertWithin(root, installedPath, `installed ${name}`);
    const expectedHash = createHash("sha256").update(readFileSync(expectedPath)).digest("hex");
    const installedHash = createHash("sha256").update(readFileSync(installedPath)).digest("hex");
    assert(installedHash === expectedHash, `installer changed vendor payload ${name}`);
    vendorHashes.push(installedHash);
  }
  assert(vendorHashes[0] === manifest.tunnelClientSha256, "installed tunnel-client hash does not match the runtime manifest");
  const tunnelReceipt = JSON.parse(readFileSync(join(installedVendorDir, "BUILD-RECEIPT.json"), "utf8")) as Record<string, unknown>;
  assert(tunnelReceipt.schemaVersion === 1, "installed tunnel-client receipt has an unsupported schema");
  assert(tunnelReceipt.buildId === manifest.tunnelClientBuild, "installed tunnel-client receipt has the wrong build ID");
  assert(tunnelReceipt.target === expectedTunnelTarget.replace("-", "/"), "installed tunnel-client receipt has the wrong target");
  assert(tunnelReceipt.binarySha256 === manifest.tunnelClientSha256, "installed tunnel-client receipt has the wrong binary hash");
  assert(tunnelReceipt.upstreamCommit === "881c9a8fed7cccbe6607cd419863bbca506b8215", "installed tunnel-client receipt has the wrong upstream commit");

  const installedTunnelClient = join(installedVendorDir, "tunnel-client.exe");
  const tunnelVersion = await run(installedTunnelClient, ["--version"], { env: environment, timeoutMs: 15_000 });
  assert(tunnelVersion.exitCode === 0, `installed tunnel-client --version failed: ${tunnelVersion.stderr || tunnelVersion.stdout}`);
  assert(`${tunnelVersion.stdout}\n${tunnelVersion.stderr}`.includes("881c9a8fed7cccbe6607cd419863bbca506b8215-codexweb-no-expiry.1"), "installed tunnel-client does not report the pinned no-expiry build");
  const tunnelDoctor = await run(installedTunnelClient, [
    "doctor",
    "--control-plane.tunnel-id", "tunnel_0123456789abcdef0123456789abcdef",
    "--mcp.command", "cmd.exe",
    "--health.listen-addr", "127.0.0.1:0",
    "--json",
  ], {
    env: {
      ...environment,
      CONTROL_PLANE_API_KEY: "synthetic-runtime-key",
      MCP_CONNECTION_MAX_TTL: "0s",
    },
    timeoutMs: 15_000,
  });
  assert(tunnelDoctor.exitCode === 0, `installed tunnel-client rejected disabled TTL: ${tunnelDoctor.stderr || tunnelDoctor.stdout}`);
  assert((JSON.parse(tunnelDoctor.stdout) as { result?: string }).result === "ok", "installed tunnel-client doctor did not report success with disabled TTL");

  const launcherSidecar = decodeSidecar(launcherSidecarPath, 5);
  const installSidecar = decodeSidecar(installSidecarPath, 11);
  assertExactPath(launcherSidecar.values[0] ?? "", join(installedRuntime, "runtime", "node.exe"), root, "launcher runtime path");
  assertExactPath(launcherSidecar.values[1] ?? "", join(installedRuntime, "app", "cli.js"), root, "launcher entrypoint path");
  assertExactPath(launcherSidecar.values[2] ?? "", appHome, root, "launcher application-home path");
  assert(launcherSidecar.values[3] === "", "launcher sidecar contains unexpected extra arguments");
  assertExactPath(installSidecar.values[0] ?? "", binDir, root, "recorded bin path");
  assertExactPath(installSidecar.values[1] ?? "", libDir, root, "recorded library path");
  assertExactPath(installSidecar.values[2] ?? "", docDir, root, "recorded documentation path");
  assertExactPath(installSidecar.values[3] ?? "", appHome, root, "recorded application-home path");
  assertExactPath(installSidecar.values[4] ?? "", gui, root, "recorded GUI path");
  assert(installSidecar.values[7] === packageVersion, "install sidecar version does not match package.json");
  assert(installSidecar.values[9] === "False", "install sidecar says uninstall registration was enabled");

  const legacyFixedProfile = join("C:\\", "Users", ["Us", "er"].join(""));
  const pathEvidence = [
    ...launcherSidecar.values.slice(0, 3),
    ...installSidecar.values.slice(0, 5),
  ];
  assert(pathEvidence.every(path => normalized(path).startsWith(`${normalized(root)}${sep}`)), "an installed operational path did not use the custom temp root");
  const scrubbedEvidence = pathEvidence
    .map(path => normalized(path).replace(normalized(root), "<custom-root>"))
    .join("\n");
  assert(!scrubbedEvidence.includes(normalized(legacyFixedProfile)), "installed path metadata contains a fixed legacy user-profile path");

  const version = await run(launcher, ["--version"], { env: environment, timeoutMs: 15_000 });
  assert(version.exitCode === 0, `installed launcher --version failed (${version.exitCode}): ${version.stderr}`);
  assert(version.stdout === `${packageVersion}\n`, `installed launcher stdout was not exactly ${JSON.stringify(`${packageVersion}\n`)}: ${JSON.stringify(version.stdout)}`);
  assert(version.stderr === "", `installed launcher --version wrote to stderr: ${version.stderr}`);

  const evidenceHash = createHash("sha256")
    .update(launcherSidecar.raw)
    .update(installSidecar.raw)
    .update(manifestText)
    .update(vendorHashes.join("\n"))
    .digest("hex");
  process.stdout.write(`WINDOWS_OFFLINE_INSTALLER_ISOLATION_SMOKE_OK ${packageVersion} ${evidenceHash}\n`);
} finally {
  assertWithin(tempBase, root, "cleanup root");
  assert(basename(root).startsWith(smokePrefix), `refusing to clean an unexpected path: ${root}`);
  rmSync(root, { recursive: true, force: true });
}
