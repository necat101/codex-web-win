import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { AppConfig, TunnelConfig } from "./config";
import { atomicWriteFile, getConfigDir, saveConfig } from "./config";
import { runCommand, runChecked } from "./process";
import {
  requireTunnelClientTarget,
  TUNNEL_CLIENT_BUILD_ID as TUNNEL_BUILD_ID,
  TUNNEL_CLIENT_UPSTREAM_COMMIT as TUNNEL_UPSTREAM_COMMIT,
  TUNNEL_CLIENT_UPSTREAM_VERSION as TUNNEL_VERSION,
  tunnelClientVendorPath,
} from "./tunnel-client-artifact";
import { getTunnelServiceStatus, TUNNEL_MCP_CONNECTION_MAX_TTL } from "./tunnel-service";

const TUNNEL_REPORTED_BUILD_MARKER = `${TUNNEL_UPSTREAM_COMMIT}-codexweb-no-expiry.1`;
const TUNNEL_RUNTIME_POLICY_VERSION = 2;

export interface TunnelInstallManifest {
  version: 2;
  tunnelClientVersion: string;
  tunnelClientBuild: string;
  upstreamCommit: string;
  binarySha256: string;
}

/** Invalid/stale install metadata is replaceable state, not a startup failure. */
export function parseTunnelInstallManifest(serialized: string): Partial<TunnelInstallManifest> | undefined {
  try {
    const parsed = JSON.parse(serialized) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Partial<TunnelInstallManifest>
      : undefined;
  } catch {
    return undefined;
  }
}

interface TunnelRuntimePolicyMarker {
  version: number;
  tunnelClientVersion: string;
  tunnelClientBuild: string;
  mcpConnectionMaxTtl: string;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function binaryPath(): string {
  return join(getConfigDir(), "bin", requireTunnelClientTarget().binaryName);
}

function manifestPath(): string {
  return join(getConfigDir(), "bin", "tunnel-client-manifest.json");
}

function runtimePolicyMarkerPath(): string {
  return join(getConfigDir(), "bin", "tunnel-runtime-policy.json");
}

function runtimePolicyIsCurrent(): boolean {
  const markerFile = runtimePolicyMarkerPath();
  if (!existsSync(markerFile)) return false;
  try {
    const marker = JSON.parse(readFileSync(markerFile, "utf8")) as Partial<TunnelRuntimePolicyMarker>;
    return marker.version === TUNNEL_RUNTIME_POLICY_VERSION
      && marker.tunnelClientVersion === TUNNEL_VERSION
      && marker.tunnelClientBuild === TUNNEL_BUILD_ID
      && marker.mcpConnectionMaxTtl === TUNNEL_MCP_CONNECTION_MAX_TTL;
  } catch {
    return false;
  }
}

function markRuntimePolicyCurrent(): void {
  const marker: TunnelRuntimePolicyMarker = {
    version: TUNNEL_RUNTIME_POLICY_VERSION,
    tunnelClientVersion: TUNNEL_VERSION,
    tunnelClientBuild: TUNNEL_BUILD_ID,
    mcpConnectionMaxTtl: TUNNEL_MCP_CONNECTION_MAX_TTL,
  };
  atomicWriteFile(runtimePolicyMarkerPath(), `${JSON.stringify(marker, null, 2)}\n`);
}

export interface TunnelClientInstallOptions {
  /**
   * Runs after the bundled patched binary has passed checksum
   * validation, immediately before an existing managed executable is replaced.
   */
  beforeReplace?: (replacementPath?: string) => void | Promise<void>;
}

function bundledTunnelClientPath(): string {
  const target = requireTunnelClientTarget();
  const relative = tunnelClientVendorPath(target);
  const launcher = process.env.CODEX_CHATGPT_WEB_LAUNCHER?.trim();
  const entrypoint = process.argv[1]?.trim();
  const runtimeRoots = [...new Set([
    ...(launcher ? [dirname(dirname(resolve(launcher)))] : []),
    ...(entrypoint ? [dirname(dirname(resolve(entrypoint)))] : []),
  ])];
  const candidates = runtimeRoots.flatMap(runtimeRoot => [
    join(runtimeRoot, relative),
    join(
      runtimeRoot,
      "node_modules",
      ".cache",
      "codex-chatgpt-web",
      "tunnel-client-no-expiry",
      TUNNEL_BUILD_ID,
      target.key,
      target.binaryName,
    ),
  ]);
  const bundled = candidates.find(existsSync);
  if (!bundled) {
    throw new Error(`Bundled no-expiry tunnel-client is missing; checked: ${candidates.join(", ")}`);
  }
  return bundled;
}

export async function installTunnelClient(options: TunnelClientInstallOptions = {}): Promise<string> {
  const target = requireTunnelClientTarget();
  const expectedHash = target.binarySha256;
  const executable = binaryPath();
  const manifestFile = manifestPath();
  const bundled = bundledTunnelClientPath();
  const binary = readFileSync(bundled);
  const bundledHash = sha256(binary);
  if (bundledHash !== expectedHash) {
    throw new Error(`Bundled no-expiry tunnel-client failed integrity validation: ${bundled}`);
  }
  if (existsSync(executable) && existsSync(manifestFile)) {
    const manifest = parseTunnelInstallManifest(readFileSync(manifestFile, "utf8"));
    if (manifest?.version === 2
      && manifest.tunnelClientVersion === TUNNEL_VERSION
      && manifest.tunnelClientBuild === TUNNEL_BUILD_ID) {
      const actual = sha256(readFileSync(executable));
      if (manifest.binarySha256 === expectedHash && actual === expectedHash) return executable;
      throw new Error(`Existing tunnel-client failed integrity validation: ${executable}`);
    }
    // An official or older custom build is replaced only after the bundled
    // no-expiry payload above has passed its pinned checksum.
  }

  await options.beforeReplace?.(executable);
  mkdirSync(dirname(executable), { recursive: true, mode: 0o700 });
  atomicWriteFile(executable, binary);
  const manifest: TunnelInstallManifest = {
    version: 2,
    tunnelClientVersion: TUNNEL_VERSION,
    tunnelClientBuild: TUNNEL_BUILD_ID,
    upstreamCommit: TUNNEL_UPSTREAM_COMMIT,
    binarySha256: bundledHash,
  };
  atomicWriteFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  const version = runChecked(executable, ["--version"]);
  const reported = `${version.stdout}\n${version.stderr}`;
  if (!reported.includes(TUNNEL_REPORTED_BUILD_MARKER)) {
    throw new Error(`Installed tunnel-client did not report build ${TUNNEL_BUILD_ID}`);
  }
  return executable;
}

export function installRuntimeKey(sourcePath: string): string {
  if (!existsSync(sourcePath)) throw new Error(`Tunnel runtime key file does not exist: ${sourcePath}`);
  const key = readFileSync(sourcePath);
  if (key.byteLength === 0 || key.byteLength > 64 * 1024) throw new Error("Tunnel runtime key file is empty or unexpectedly large");
  return installRuntimeKeyBytes(key);
}

export function managedRuntimeKeyPath(): string {
  return join(getConfigDir(), "secrets", "tunnel-runtime.key");
}

export function installRuntimeKeyBytes(key: Uint8Array | string): string {
  const bytes = typeof key === "string" ? new TextEncoder().encode(key.trim()) : key;
  if (bytes.byteLength === 0 || bytes.byteLength > 64 * 1024) throw new Error("Tunnel runtime key is empty or unexpectedly large");
  const destination = managedRuntimeKeyPath();
  atomicWriteFile(destination, bytes);
  return destination;
}

export function createTunnelConfig(options: {
  binaryPath: string;
  tunnelId: string;
  runtimeKeyFile: string;
  profileName?: string;
  alias?: string;
}): TunnelConfig {
  if (!/^tunnel_[a-f0-9]{32}$/.test(options.tunnelId)) throw new Error("--tunnel-id must be tunnel_ followed by 32 lowercase hexadecimal characters");
  const profileName = options.profileName ?? "codex-chatgpt-web";
  const alias = options.alias ?? "codex-chatgpt-web";
  if (!/^[A-Za-z0-9._-]+$/.test(profileName) || !/^[A-Za-z0-9._-]+$/.test(alias)) {
    throw new Error("Tunnel profile and alias may contain only letters, digits, dot, underscore, and dash");
  }
  return {
    binaryPath: options.binaryPath,
    tunnelId: options.tunnelId,
    runtimeKeyFile: options.runtimeKeyFile,
    profileDir: join(getConfigDir(), "tunnel", "profiles"),
    profileName,
    alias,
  };
}

/**
 * Quote one argv item for tunnel-client's mcp.command parser.
 *
 * The pinned tunnel-client does not pass this string through cmd.exe on
 * Windows. It parses a small shell-like grammar itself and then calls
 * exec.Command with the resulting argv. Single quotes are therefore
 * intentional: unlike that parser's double quotes, they preserve Windows
 * backslashes verbatim.
 */
export function quoteTunnelCommandArgument(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function mcpCommand(config: AppConfig): string {
  return [...config.runtimeCommand, "mcp", "--broker-socket", config.brokerSocketPath]
    .map(quoteTunnelCommandArgument)
    .join(" ");
}

export function tunnelClientEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...environment,
    // The bundled patched client treats 0s as a disabled connection timer.
    // Omitting this value would restore upstream's 10-minute default.
    MCP_CONNECTION_MAX_TTL: TUNNEL_MCP_CONNECTION_MAX_TTL,
  };
}

function tunnel(config: AppConfig): TunnelConfig {
  if (config.mode !== "full" || !config.tunnel) throw new Error("Tunnel commands require full mode");
  return config.tunnel;
}

export function connectTunnel(config: AppConfig): void {
  const settings = tunnel(config);
  mkdirSync(settings.profileDir, { recursive: true, mode: 0o700 });
  runChecked(settings.binaryPath, [
    "runtimes", "connect",
    "--alias", settings.alias,
    "--profile", settings.profileName,
    "--profile-dir", settings.profileDir,
    "--tunnel-client-bin", settings.binaryPath,
    "--tunnel-id", settings.tunnelId,
    "--runtime-api-key", `file:${settings.runtimeKeyFile}`,
    "--mcp-command", mcpCommand(config),
    "--json",
  ], { env: tunnelClientEnvironment() });
}

export interface TunnelSession {
  readonly status: TunnelRuntimeStatus;
  stop: () => Promise<void>;
}

export interface TunnelSessionOperations {
  start: () => void | Promise<void>;
  status: () => Promise<TunnelRuntimeStatus>;
  stop: () => void | Promise<void>;
}

export interface PinnedTunnelClientOperations {
  install: (options?: TunnelClientInstallOptions) => Promise<string>;
  binaryExists: (path: string) => boolean;
  stop: (config: AppConfig) => void | Promise<void>;
  persist: (config: AppConfig) => void | Promise<void>;
  runtimePolicyCurrent: () => boolean;
  markRuntimePolicyCurrent: () => void | Promise<void>;
}

function sameFilesystemPath(left: string, right: string): boolean {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  return process.platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

/**
 * Validate (and, when needed, atomically replace) the managed tunnel client
 * before a foreground session starts accepting tool-capable turns.
 *
 * v0.0.11 could close the shared stdio MCP pipe when one long connector
 * request reached its response deadline. The replacement hook lets an old
 * Windows runtime keep serving until the verified v0.0.12 payload is ready,
 * then stops it before replacing the locked executable.
 *
 * The separate runtime-policy marker handles an already-installed v0.0.12
 * process that was started with the official expiring build or the former 4h
 * policy. Missing or stale policy state forces one successful stop before
 * reusing an existing managed binary. A genuinely fresh install has no prior
 * runtime to stop. The marker is written only after either case succeeds, so a
 * failed migration retries on the next launch instead of silently retaining an
 * expiring connection policy.
 */
export async function ensurePinnedTunnelClient(
  config: AppConfig,
  operations: PinnedTunnelClientOperations = {
    install: installTunnelClient,
    binaryExists: existsSync,
    stop: stopTunnel,
    persist: saveConfig,
    runtimePolicyCurrent: runtimePolicyIsCurrent,
    markRuntimePolicyCurrent,
  },
): Promise<boolean> {
  const settings = tunnel(config);
  let replaced = false;
  const configuredPathBeforeInstall = settings.binaryPath;
  const stoppedRuntimePaths: string[] = [];
  const runtimeWasStopped = (path: string) => stoppedRuntimePaths.some(stopped => sameFilesystemPath(stopped, path));
  const stopRuntimeAt = async (path: string) => {
    if (runtimeWasStopped(path)) return;
    const stopConfig = sameFilesystemPath(path, settings.binaryPath)
      ? config
      : {
          ...config,
          tunnel: { ...settings, binaryPath: path },
        } as AppConfig;
    await operations.stop(stopConfig);
    stoppedRuntimePaths.push(path);
  };
  const policyMigrationRequired = !operations.runtimePolicyCurrent();
  // Check before install: a fresh install creates the executable but has no
  // old runtime whose inherited environment needs to be replaced.
  const configuredBinaryExistedBeforeInstall = operations.binaryExists(settings.binaryPath);
  const installedPath = await operations.install({
    beforeReplace: async replacementPath => {
      replaced = true;
      const stopPath = replacementPath && operations.binaryExists(replacementPath)
        ? replacementPath
        : operations.binaryExists(settings.binaryPath)
          ? settings.binaryPath
          : undefined;
      if (stopPath) await stopRuntimeAt(stopPath);
    },
  });
  let pathMigrated = false;
  if (!sameFilesystemPath(installedPath, settings.binaryPath)) {
    // Older releases may have persisted a legacy managed path. Stop a runtime
    // launched through that path before migrating the config, otherwise the
    // new binary's StartOrReuse command could adopt the still-affected process.
    if (operations.binaryExists(settings.binaryPath) && !runtimeWasStopped(settings.binaryPath)) {
      await stopRuntimeAt(settings.binaryPath);
    }
    settings.binaryPath = installedPath;
    await operations.persist(config);
    pathMigrated = true;
  }
  if (policyMigrationRequired) {
    if (configuredBinaryExistedBeforeInstall && !runtimeWasStopped(configuredPathBeforeInstall)) {
      await stopRuntimeAt(configuredPathBeforeInstall);
    }
    await operations.markRuntimePolicyCurrent();
  }
  return replaced || pathMigrated || policyMigrationRequired;
}

let activeTunnelSession: TunnelSession | undefined;
let tunnelSessionStarting = false;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function negotiateTunnelSession(operations: TunnelSessionOperations): Promise<TunnelSession> {
  try {
    // `runtimes connect` is deliberately StartOrReuse upstream. Let it reuse a
    // healthy local runtime instead of unconditionally tearing down its stdio
    // MCP child first; a forced stop can cancel an in-flight tunnel response
    // and defeats redundant/same-tunnel operation during launcher restarts.
    await operations.start();
    const status = await operations.status();
    if (!status.ok) throw new Error(`Tunnel runtime did not become healthy and ready: ${status.detail}`);
    let stopPromise: Promise<void> | undefined;
    return {
      status,
      stop: () => {
        if (!stopPromise) {
          stopPromise = Promise.resolve()
            .then(() => operations.stop())
            .catch(error => {
              stopPromise = undefined;
              throw error;
            });
        }
        return stopPromise;
      },
    };
  } catch (error) {
    try {
      await operations.stop();
    } catch (cleanupError) {
      throw new Error(`${errorMessage(error)}; tunnel cleanup also failed: ${errorMessage(cleanupError)}`);
    }
    throw error;
  }
}

/**
 * Start the tunnel runtime as a descendant of the current session launcher.
 *
 * The Windows package launcher assigns the process tree to a kill-on-close Job
 * Object. That hard boundary covers terminal closure and launcher crashes even
 * after the short-lived `runtimes connect` command exits; the explicit stop
 * path remains responsible for normal graceful shutdown.
 */
export async function startTunnelSession(config: AppConfig, timeoutMs = 30_000): Promise<TunnelSession> {
  if (activeTunnelSession || tunnelSessionStarting) {
    throw new Error("A tunnel session is already active in this process");
  }
  tunnelSessionStarting = true;
  try {
    const prepared = await ensurePinnedTunnelClient(config);
    if (prepared) {
      console.info(
        `[tunnel] prepared managed tunnel-client ${TUNNEL_VERSION} and runtime policy `
        + `${TUNNEL_RUNTIME_POLICY_VERSION} before session startup`,
      );
    }
    const owned = await negotiateTunnelSession({
      start: () => connectTunnel(config),
      status: () => waitForTunnelReady(config, timeoutMs),
      stop: () => stopTunnel(config),
    });
    const session: TunnelSession = {
      status: owned.status,
      stop: async () => {
        await owned.stop();
        if (activeTunnelSession === session) activeTunnelSession = undefined;
      },
    };
    activeTunnelSession = session;
    return session;
  } finally {
    tunnelSessionStarting = false;
  }
}

export function stopTunnel(config: AppConfig): void {
  const settings = tunnel(config);
  const result = runCommand(settings.binaryPath, ["runtimes", "stop", settings.alias, "--json"]);
  if (result.status !== 0 && !isTunnelAlreadyStopped(`${result.stdout}\n${result.stderr}`)) {
    throw new Error(`Failed to stop tunnel runtime: ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

export function isTunnelAlreadyStopped(output: string): boolean {
  return /not found|not running|not known|unknown alias/i.test(output);
}

export interface TunnelRuntimeStatus {
  ok: boolean;
  processRunning: boolean;
  healthy: boolean;
  ready: boolean;
  state?: string;
  logPath?: string;
  detail: string;
}

function safeTunnelDetail(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text
    .replace(/tunnel_[a-f0-9]{32}/g, "[tunnel-id]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[redacted-key]")
    .slice(0, 2_000);
}

export function parseTunnelStatus(output: string, exitStatus = 0): TunnelRuntimeStatus {
  if (exitStatus !== 0) {
    return { ok: false, processRunning: false, healthy: false, ready: false, detail: safeTunnelDetail(output) };
  }
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    const processRunning = parsed.process_running === true;
    const healthy = parsed.healthy === true;
    const ready = parsed.ready === true;
    const state = typeof parsed.runtime_state === "string" ? parsed.runtime_state
      : typeof parsed.status === "string" ? parsed.status
        : undefined;
    const local = parsed.local && typeof parsed.local === "object" && !Array.isArray(parsed.local)
      ? parsed.local as Record<string, unknown>
      : undefined;
    const issues = local && Array.isArray(local.issues)
      ? local.issues.filter(issue => typeof issue === "string").slice(0, 3)
      : [];
    const localLog = local?.log && typeof local.log === "object" && !Array.isArray(local.log)
      ? local.log as Record<string, unknown>
      : undefined;
    const logPath = typeof localLog?.path === "string" && localLog.path.trim() ? localLog.path : undefined;
    const explicitError = typeof parsed.error === "string" && parsed.error ? parsed.error : undefined;
    const ok = processRunning && healthy && ready;
    const detail = ok
      ? "process_running=true healthy=true ready=true"
      : safeTunnelDetail([`process_running=${processRunning}`, `healthy=${healthy}`, `ready=${ready}`, ...(state ? [`state=${state}`] : []), ...(explicitError ? [explicitError] : []), ...issues].join("; "));
    return { ok, processRunning, healthy, ready, ...(state ? { state } : {}), ...(logPath ? { logPath } : {}), detail };
  } catch {
    return { ok: false, processRunning: false, healthy: false, ready: false, detail: `tunnel-client returned non-JSON status: ${safeTunnelDetail(output)}` };
  }
}

export function tunnelStatus(config: AppConfig): TunnelRuntimeStatus {
  const settings = tunnel(config);
  if (!existsSync(settings.binaryPath)) {
    return { ok: false, processRunning: false, healthy: false, ready: false, detail: `Missing ${settings.binaryPath}` };
  }
  const result = runCommand(settings.binaryPath, ["runtimes", "status", settings.alias, "--json"]);
  let output = (result.stdout || result.stderr).trim();
  const service = getTunnelServiceStatus();
  if (result.status === 0 && (service.running || process.platform === "win32")) {
    try {
      const parsed = JSON.parse(output) as Record<string, unknown>;
      // `runtimes status` probes the configured health and readiness endpoints
      // on every call. A foreground Windows runtime outlives the short
      // `runtimes connect` command while remaining inside the package
      // launcher's Job Object, so a successful live probe is stronger evidence
      // than stale supervisor PID metadata.
      if (service.running || (parsed.healthy === true && parsed.ready === true)) {
        parsed.process_running = true;
      }
      if (parsed.process_running === true && parsed.healthy === true && parsed.ready === true) {
        parsed.runtime_state = "ready";
      }
      output = JSON.stringify(parsed);
    } catch {
      // parseTunnelStatus owns the diagnostic for malformed output.
    }
  }
  return parseTunnelStatus(output, result.status);
}

export async function waitForTunnelReady(config: AppConfig, timeoutMs = 30_000): Promise<TunnelRuntimeStatus> {
  const deadline = Date.now() + timeoutMs;
  let status = tunnelStatus(config);
  while (!status.ok && Date.now() < deadline) {
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
    status = tunnelStatus(config);
  }
  return status;
}

export function tunnelClientVersion(): string {
  return TUNNEL_VERSION;
}

export function tunnelClientBuildId(): string {
  return TUNNEL_BUILD_ID;
}

export function tunnelRuntimePolicyVersion(): number {
  return TUNNEL_RUNTIME_POLICY_VERSION;
}

export function installedTunnelClientVersion(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const result = runCommand(path, ["--version"]);
  if (result.status !== 0) return undefined;
  return /\b(\d+\.\d+\.\d+)\b/.exec(`${result.stdout}\n${result.stderr}`)?.[1];
}

export function installedTunnelClientBuildId(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const result = runCommand(path, ["--version"]);
  if (result.status !== 0) return undefined;
  return `${result.stdout}\n${result.stderr}`.includes(TUNNEL_REPORTED_BUILD_MARKER) ? TUNNEL_BUILD_ID : undefined;
}
