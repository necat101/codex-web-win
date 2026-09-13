import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { chromium, type BrowserContextOptions } from "playwright-core";
import type { AppConfig, DeepSeekWebConfig } from "./config";
import { atomicWriteFile } from "./config";
import { childProcessEnvironment } from "./process";
import {
  assertAuthenticatedDeepSeekPage,
  DEEPSEEK_HOME_URL,
  deepSeekComposer,
} from "./deepseek-session";

export interface DeepSeekBrowserLoginResult {
  storageStatePath: string;
  accountSurfaceUrl: string;
}

interface DeepSeekLoginVerificationMarker {
  version: 1;
  authenticated: true;
  verifiedAt: string;
  accountSurfaceUrl: string;
}

function deepSeekConfig(config: AppConfig): DeepSeekWebConfig {
  if (!config.deepSeekWeb) {
    throw new Error("DeepSeek Web is not configured; rerun setup with DeepSeek Web enabled");
  }
  return config.deepSeekWeb;
}

export function deepSeekLoginVerificationMarkerPath(storageStatePath: string): string {
  return `${storageStatePath}.verified.json`;
}

export function normalDeepSeekChromeLoginArguments(profileDir: string): string[] {
  return [
    `--user-data-dir=${profileDir}`,
    "--new-window",
    "--disable-background-mode",
    "--no-first-run",
    "--no-default-browser-check",
    DEEPSEEK_HOME_URL,
  ];
}

function writeVerificationMarker(storageStatePath: string, accountSurfaceUrl: string): void {
  const marker: DeepSeekLoginVerificationMarker = {
    version: 1,
    authenticated: true,
    verifiedAt: new Date().toISOString(),
    accountSurfaceUrl,
  };
  atomicWriteFile(
    deepSeekLoginVerificationMarkerPath(storageStatePath),
    `${JSON.stringify(marker)}\n`,
  );
}

function wait(delayMs: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, delayMs));
}

function powershellSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function windowsDedicatedChromePids(profileDir: string): Promise<number[]> {
  if (process.platform !== "win32") return [];
  const needle = `--user-data-dir=${profileDir}`;
  const script = [
    `$needle = ${powershellSingleQuoted(needle)}`,
    "$pids = @(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" -ErrorAction SilentlyContinue",
    "  | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($needle) }",
    "  | ForEach-Object { [int]$_.ProcessId })",
    "if ($pids.Count -gt 0) { $pids -join ',' }",
  ].join("; ");

  const output = await new Promise<string>(resolveOutput => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 10_000 },
      (error, stdout) => resolveOutput(error ? "" : stdout.trim()),
    );
  });
  if (!output) return [];
  return output
    .split(",")
    .map(value => Number.parseInt(value.trim(), 10))
    .filter(value => Number.isInteger(value) && value > 0);
}

async function terminateDedicatedChromeProfile(profileDir: string): Promise<void> {
  if (process.platform !== "win32") return;
  for (const pid of await windowsDedicatedChromePids(profileDir)) {
    await new Promise<void>(resolveDone => {
      execFile(
        "taskkill.exe",
        ["/PID", String(pid), "/T", "/F"],
        { windowsHide: true, timeout: 10_000 },
        () => resolveDone(),
      );
    });
  }
}

async function waitForDedicatedChromeProfileRelease(profileDir: string): Promise<void> {
  const naturalDeadline = Date.now() + 6_000;
  while (Date.now() < naturalDeadline) {
    if ((await windowsDedicatedChromePids(profileDir)).length === 0) {
      await wait(350);
      return;
    }
    await wait(250);
  }

  const lingering = await windowsDedicatedChromePids(profileDir);
  if (lingering.length > 0) {
    process.stdout.write(
      `Closing lingering dedicated DeepSeek login Chrome process(es): ${lingering.join(", ")}\n`,
    );
    await terminateDedicatedChromeProfile(profileDir);
  }

  const forcedDeadline = Date.now() + 5_000;
  while (Date.now() < forcedDeadline) {
    if ((await windowsDedicatedChromePids(profileDir)).length === 0) {
      await wait(500);
      return;
    }
    await wait(250);
  }
  throw new Error("The dedicated DeepSeek login Chrome profile is still in use");
}

async function removeLoginProfileBestEffort(profileDir: string): Promise<void> {
  for (let attempt = 1; attempt <= 20; attempt++) {
    try {
      rmSync(profileDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "ENOTEMPTY") return;
      if (attempt < 20) await wait(250);
    }
  }
  process.stderr.write(
    `Warning: temporary DeepSeek login profile is still locked and was left for later cleanup: ${profileDir}\n`,
  );
}

async function inspectStoredState(
  config: AppConfig,
  storageState: NonNullable<BrowserContextOptions["storageState"]>,
): Promise<string> {
  const verifierBrowser = await chromium.launch({
    executablePath: config.chromeExecutablePath,
    headless: false,
    env: childProcessEnvironment(),
    ignoreDefaultArgs: ["--password-store=basic", "--use-mock-keychain"],
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  try {
    const verifierContext = await verifierBrowser.newContext({ storageState });
    try {
      const page = await verifierContext.newPage();
      await page.goto(DEEPSEEK_HOME_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await assertAuthenticatedDeepSeekPage(page);
      return page.url();
    } finally {
      await verifierContext.close();
    }
  } finally {
    await verifierBrowser.close();
  }
}

export async function inspectDeepSeekStoredState(config: AppConfig): Promise<{ accountSurfaceUrl: string }> {
  const provider = deepSeekConfig(config);
  if (!deepSeekBrowserLoginStateExists(config)) {
    throw new Error("DeepSeek Web login state is missing or unverified");
  }
  const accountSurfaceUrl = await inspectStoredState(config, provider.storageStatePath);
  writeVerificationMarker(provider.storageStatePath, accountSurfaceUrl);
  return { accountSurfaceUrl };
}

export async function loginToDeepSeek(
  config: AppConfig,
  options: { timeoutMs?: number; announce?: boolean } = {},
): Promise<DeepSeekBrowserLoginResult> {
  const provider = deepSeekConfig(config);
  if (!existsSync(config.chromeExecutablePath)) {
    throw new Error(
      `Google Chrome was not found at ${config.chromeExecutablePath}. Pass --chrome with its executable path.`,
    );
  }

  const profileDir = resolve(
    dirname(provider.storageStatePath),
    `deepseek-login-profile-${process.pid}-${Date.now().toString(36)}`,
  );
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });

  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  try {
    if (options.announce !== false) {
      process.stdout.write(
        "A dedicated Chrome profile is open. Sign in to DeepSeek normally, confirm the message composer is visible, then quit this dedicated Chrome instance completely.\n",
      );
    }

    const loginBrowser = spawn(
      config.chromeExecutablePath,
      normalDeepSeekChromeLoginArguments(profileDir),
      { env: childProcessEnvironment(), stdio: "ignore" },
    );
    const loginExit = await new Promise<number>((resolveExit, rejectExit) => {
      loginBrowser.once("error", rejectExit);
      loginBrowser.once("exit", (code, signal) => {
        if (signal) rejectExit(new Error(`DeepSeek login window exited from signal ${signal}`));
        else resolveExit(code ?? 1);
      });
    });
    if (loginExit !== 0) throw new Error(`DeepSeek login window exited with status ${loginExit}`);

    await waitForDedicatedChromeProfileRelease(profileDir);
    process.stdout.write("Login Chrome closed; extracting DeepSeek session state...\n");

    context = await chromium.launchPersistentContext(profileDir, {
      executablePath: config.chromeExecutablePath,
      headless: false,
      env: childProcessEnvironment(),
      ignoreDefaultArgs: ["--password-store=basic", "--use-mock-keychain"],
      args: ["--no-first-run", "--no-default-browser-check"],
    });
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(DEEPSEEK_HOME_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    try {
      await deepSeekComposer(page).waitFor({ state: "visible", timeout: options.timeoutMs ?? 60_000 });
      await assertAuthenticatedDeepSeekPage(page);
    } catch {
      throw new Error("The authenticated DeepSeek page did not produce a visible message composer");
    }

    const state = await context.storageState();
    const accountSurfaceUrl = page.url();
    await context.close();
    context = undefined;
    await wait(500);

    const verifiedUrl = await inspectStoredState(config, state);
    atomicWriteFile(provider.storageStatePath, `${JSON.stringify(state)}\n`);
    writeVerificationMarker(provider.storageStatePath, verifiedUrl);
    return { storageStatePath: provider.storageStatePath, accountSurfaceUrl };
  } finally {
    if (context) await context.close().catch(() => {});
    await terminateDedicatedChromeProfile(profileDir).catch(() => {});
    await wait(300);
    await removeLoginProfileBestEffort(profileDir);
  }
}

export function deepSeekBrowserLoginStateExists(config: AppConfig): boolean {
  const provider = config.deepSeekWeb;
  if (!provider || !existsSync(provider.storageStatePath)) return false;
  const markerPath = deepSeekLoginVerificationMarkerPath(provider.storageStatePath);
  if (!existsSync(markerPath)) return false;
  try {
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Partial<DeepSeekLoginVerificationMarker>;
    return marker.version === 1
      && marker.authenticated === true
      && typeof marker.verifiedAt === "string"
      && typeof marker.accountSurfaceUrl === "string";
  } catch {
    return false;
  }
}
