import { closeSync, existsSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import type { AppConfig } from "./config";
import { getConfigPath, loadConfig } from "./config";
import { inspectCodexIntegration } from "./codex-integration";
import { browserLoginStateExists, loginVerificationMarkerPath } from "./browser-login";
import {
  deepSeekBrowserLoginStateExists,
  deepSeekLoginVerificationMarkerPath,
} from "./deepseek-browser-login";
import { getServiceStatus } from "./service";
import {
  installedTunnelClientBuildId,
  installedTunnelClientVersion,
  tunnelClientBuildId,
  tunnelClientVersion,
  tunnelStatus,
} from "./tunnel";
import { getTunnelServiceStatus } from "./tunnel-service";

export type CheckStatus = "ok" | "warning" | "error";

export interface DoctorCheck {
  id: string;
  status: CheckStatus;
  message: string;
  detail?: string;
}

export interface DoctorReport {
  ok: boolean;
  mode?: AppConfig["mode"];
  checks: DoctorCheck[];
}

function secureFile(path: string): boolean {
  if (process.platform === "win32") return true;
  return (statSync(path).mode & 0o077) === 0;
}

export function recentSharedTunnelRouteMissCount(logPath: string, maxBytes = 2 * 1024 * 1024): number {
  if (!existsSync(logPath) || maxBytes <= 0) return 0;
  let fd: number | undefined;
  try {
    fd = openSync(logPath, "r");
    const size = fstatSync(fd).size;
    const bytes = Math.min(size, maxBytes);
    if (bytes <= 0) return 0;
    const buffer = Buffer.allocUnsafe(bytes);
    readSync(fd, buffer, 0, bytes, Math.max(0, size - bytes));
    return buffer.toString("utf8").split("[chatgpt-web-mcp] shared-tunnel route miss").length - 1;
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

async function proxyCheck(config: AppConfig): Promise<DoctorCheck> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(`http://${config.host}:${config.port}/healthz`, { signal: controller.signal });
    if (!response.ok) return { id: "proxy", status: "error", message: `Responses proxy returned HTTP ${response.status}` };
    const body = await response.json() as Record<string, unknown>;
    if (body.service !== "codex-chatgpt-web" || body.status !== "ok") {
      return { id: "proxy", status: "error", message: "The configured port belongs to another service" };
    }
    if (body.mode !== config.mode) {
      return { id: "proxy", status: "error", message: `Daemon is running in ${String(body.mode)} mode; config requires ${config.mode}` };
    }
    if (body.version !== config.releaseVersion) {
      return { id: "proxy", status: "error", message: `Daemon version is ${String(body.version)}; config requires ${config.releaseVersion}` };
    }
    return { id: "proxy", status: "ok", message: `Responses proxy is healthy on 127.0.0.1:${config.port}` };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { id: "proxy", status: "error", message: "Responses proxy is not reachable", detail };
  } finally {
    clearTimeout(timeout);
  }
}

export async function runDoctor(): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  let config: AppConfig;
  try {
    config = loadConfig();
    checks.push({ id: "config", status: "ok", message: `Configuration is valid (${getConfigPath()})` });
  } catch (error) {
    checks.push({ id: "config", status: "error", message: "Configuration is invalid", detail: error instanceof Error ? error.message : String(error) });
    return { ok: false, checks };
  }

  if (!existsSync(config.chromeExecutablePath)) {
    checks.push({ id: "chrome", status: "error", message: `Chrome executable is missing: ${config.chromeExecutablePath}` });
  } else {
    checks.push({ id: "chrome", status: "ok", message: `Chrome executable found: ${config.chromeExecutablePath}` });
  }
  const ffmpegPath = Bun.which("ffmpeg");
  const ffprobePath = Bun.which("ffprobe");
  if (ffmpegPath && ffprobePath) {
    checks.push({
      id: "media-tools",
      status: "ok",
      message: "FFmpeg media inspection tools are available",
      detail: `ffmpeg=${ffmpegPath}; ffprobe=${ffprobePath}`,
    });
  } else {
    checks.push({
      id: "media-tools",
      status: "warning",
      message: "FFmpeg media inspection tools are not fully available on PATH",
      detail: "Local video/audio inspection through Codex can use ffmpeg/ffprobe when installed. Install FFmpeg, ensure both executables are on PATH, then restart the Codex ChatGPT Web session. A missing binary is a dependency issue, not a harness permission denial.",
    });
  }
  if (!browserLoginStateExists(config)) {
    checks.push({ id: "login", status: "error", message: "ChatGPT login state is missing or unverified; run `codex-chatgpt-web login`" });
  } else if (!secureFile(config.storageStatePath)) {
    checks.push({ id: "login", status: "error", message: `ChatGPT login state is readable by other users: ${config.storageStatePath}` });
  } else if (!secureFile(loginVerificationMarkerPath(config.storageStatePath))) {
    checks.push({ id: "login", status: "error", message: "ChatGPT login verification marker is readable by other users" });
  } else {
    checks.push({ id: "login", status: "ok", message: "ChatGPT login state was verified in a fresh runtime context" });
  }

  if (config.deepSeekWeb?.enabled !== true) {
    checks.push({
      id: "deepseek-login",
      status: "ok",
      message: "DeepSeek Web is disabled; any previously stored login state remains private and retained",
    });
  } else if (!deepSeekBrowserLoginStateExists(config)) {
    checks.push({
      id: "deepseek-login",
      status: "error",
      message: "DeepSeek login state is missing or unverified; run `codex-chatgpt-web deepseek-login`",
    });
  } else if (!secureFile(config.deepSeekWeb.storageStatePath)) {
    checks.push({
      id: "deepseek-login",
      status: "error",
      message: `DeepSeek login state is readable by other users: ${config.deepSeekWeb.storageStatePath}`,
    });
  } else if (!secureFile(deepSeekLoginVerificationMarkerPath(config.deepSeekWeb.storageStatePath))) {
    checks.push({
      id: "deepseek-login",
      status: "error",
      message: "DeepSeek login verification marker is readable by other users",
    });
  } else {
    checks.push({
      id: "deepseek-login",
      status: "ok",
      message: "DeepSeek login state was verified independently from ChatGPT",
    });
  }

  const codex = inspectCodexIntegration();
  if (!codex.installed) {
    checks.push({ id: "codex", status: "error", message: "Codex model route is not installed" });
  } else if (codex.errors.length > 0) {
    checks.push({ id: "codex", status: "error", message: "Codex integration is inconsistent", detail: codex.errors.join("; ") });
  } else {
    checks.push({ id: "codex", status: "ok", message: "Codex native model route is installed" });
  }

  const service = getServiceStatus();
  if (!service.supported) {
    checks.push({
      id: "service",
      status: "warning",
      message: process.platform === "win32"
        ? "Windows is foreground-only by design; keep the desktop app open (or run `codex-chatgpt-web session`) while using Codex"
        : "Managed service is unavailable on this OS; keep `serve` running manually",
    });
  } else if (!service.installed || !service.loaded) {
    checks.push({ id: "service", status: "error", message: "Background service is not installed and loaded" });
  } else {
    checks.push({ id: "service", status: "ok", message: "Background service is loaded" });
  }
  checks.push(await proxyCheck(config));

  if (config.mode === "full") {
    const settings = config.tunnel!;
    if (!existsSync(settings.binaryPath)) {
      checks.push({ id: "tunnel-binary", status: "error", message: `tunnel-client is missing: ${settings.binaryPath}` });
    } else {
      const installedVersion = installedTunnelClientVersion(settings.binaryPath);
      const requiredVersion = tunnelClientVersion();
      const installedBuild = installedTunnelClientBuildId(settings.binaryPath);
      const requiredBuild = tunnelClientBuildId();
      checks.push(installedVersion === requiredVersion && installedBuild === requiredBuild
        ? { id: "tunnel-binary", status: "ok", message: `Pinned no-expiry tunnel-client build ${requiredBuild} is installed` }
        : {
            id: "tunnel-binary",
            status: "error",
            message: `tunnel-client build mismatch; expected ${requiredBuild}, found ${installedBuild ?? installedVersion ?? "unknown"}`,
            detail: "Rerun setup to install the pinned tunnel client before starting Full mode.",
          });
    }
    if (!existsSync(settings.runtimeKeyFile)) {
      checks.push({ id: "tunnel-key", status: "error", message: "Tunnel runtime key file is missing" });
    } else if (!secureFile(settings.runtimeKeyFile)) {
      checks.push({ id: "tunnel-key", status: "error", message: "Tunnel runtime key file has unsafe permissions" });
    } else {
      checks.push({ id: "tunnel-key", status: "ok", message: "Tunnel runtime key is stored privately" });
    }
    const tunnelService = getTunnelServiceStatus();
    checks.push(!tunnelService.supported
      ? {
          id: "tunnel-service",
          status: "warning",
          message: process.platform === "win32"
            ? "Tunnel runtime is owned by the foreground Windows session"
            : "Managed tunnel service is unavailable on this OS",
        }
      : tunnelService.installed && tunnelService.loaded && tunnelService.running
        ? { id: "tunnel-service", status: "ok", message: "Tunnel service is installed, loaded, and running" }
        : { id: "tunnel-service", status: "error", message: "Tunnel service is not fully running", detail: JSON.stringify(tunnelService) });
    const runtime = tunnelStatus(config);
    checks.push(runtime.ok
      ? { id: "tunnel-runtime", status: "ok", message: "Tunnel runtime reports healthy and ready" }
      : { id: "tunnel-runtime", status: "error", message: "Tunnel runtime is not ready", detail: runtime.detail });
    const sharedRouteMisses = runtime.logPath ? recentSharedTunnelRouteMissCount(runtime.logPath) : 0;
    if (sharedRouteMisses > 0) {
      checks.push({
        id: "shared-tunnel-routing",
        status: "warning",
        message: `Tunnel log contains ${sharedRouteMisses} recent shared-tunnel ownership miss${sharedRouteMisses === 1 ? "" : "es"}`,
        detail: "These calls belong to a different broker ownership epoch. They can be stale in-flight calls after a local tunnel/MCP restart, or traffic from another computer using the same tunnel. If they persist without a restart, verify each computer has its own tunnel ID and uniquely named ChatGPT custom app/connector.",
      });
    }
    if (config.appName === "Codex Native") {
      checks.push({
        id: "connector-machine-name",
        status: "warning",
        message: "Full mode is using the legacy generic connector name \"Codex Native\"",
        detail: "If this ChatGPT account is used with Full mode on more than one computer, give every computer a unique connector name and its own tunnel ID. Fresh installs now default to a machine-specific connector name.",
      });
    }
    checks.push({
      id: "connector",
      status: "warning",
      message: `Local checks cannot prove that ChatGPT connector ${JSON.stringify(config.appName)} is attached to this tunnel`,
      detail: "Verify it once at https://chatgpt.com/#settings/Connectors while the tunnel is ready.",
    });
  } else {
    checks.push({ id: "tools", status: "warning", message: "Browser-only mode intentionally has no local tools or MCP tunnel" });
  }

  return {
    ok: !checks.some(check => check.status === "error"),
    mode: config.mode,
    checks,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const icon: Record<CheckStatus, string> = { ok: "✓", warning: "!", error: "✗" };
  const lines = report.checks.flatMap(check => [
    `${icon[check.status]} ${check.message}`,
    ...(check.detail ? [`  ${check.detail}`] : []),
  ]);
  lines.push(report.ok ? "Doctor result: ready" : "Doctor result: not ready");
  return `${lines.join("\n")}\n`;
}
