import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { CHATGPT_WEB_MODEL_ROUTES } from "../src/chatgpt-web-models";
import { defaultConfig } from "../src/config";
import { installCodexIntegration } from "../src/codex-integration";
import { augmentNativeModelCatalog } from "../src/model-catalog";

function discoverCodex(): string {
  if (process.argv[2]) return resolve(process.argv[2]);
  if (process.platform === "darwin") return "/Applications/ChatGPT.app/Contents/Resources/codex";
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    const localCandidates = localAppData ? [
      join(localAppData, "Programs", "Codex", "resources", "codex.exe"),
      join(localAppData, "Programs", "ChatGPT", "resources", "codex.exe"),
    ] : [];
    for (const candidate of localCandidates) {
      if (existsSync(candidate)) return candidate;
    }
    const appx = spawnSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(Get-AppxPackage OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1).InstallLocation",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 });
    if (appx.status === 0 && appx.stdout.trim()) {
      const candidate = join(appx.stdout.trim(), "app", "resources", "codex.exe");
      if (existsSync(candidate)) return candidate;
    }
    const pathLookup = spawnSync("where.exe", ["codex.exe"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    });
    if (pathLookup.status === 0) {
      const candidate = pathLookup.stdout.split(/\r?\n/).find(line => line.trim())?.trim();
      if (candidate && existsSync(candidate)) return candidate;
    }
  }
  throw new Error("Could not find the Codex executable; pass its absolute path to smoke:codex");
}

const root = join(tmpdir(), `codex-chatgpt-web-codex-smoke-${process.pid}-${Date.now()}`);
mkdirSync(root, { recursive: true });
const discoveredCodex = discoverCodex();
const codex = process.platform === "win32" && discoveredCodex.toLowerCase().includes("\\windowsapps\\")
  ? join(root, "codex.exe")
  : discoveredCodex;
if (codex !== discoveredCodex) copyFileSync(discoveredCodex, codex);

function runCodex(args: string[], env = process.env): { stdout: string; stderr: string } {
  const result = spawnSync(codex, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env,
    // WindowsApps Codex is copied out of the package because its installed ACL
    // blocks direct execution from this smoke. The standalone binary is large
    // enough that first launch can spend tens of seconds in Windows scanning,
    // especially immediately after an app update.
    timeout: 60_000,
  });
  if (result.status !== 0) {
    throw new Error(`Codex ${args.join(" ")} failed: ${result.error?.message || result.stderr || result.signal || `exit ${result.status}`}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

interface ListedModel {
  id?: string;
  hidden?: boolean;
}

async function runCodexModelList(env: NodeJS.ProcessEnv): Promise<ListedModel[]> {
  const child = Bun.spawn({
    cmd: [codex, "app-server", "--listen", "stdio://"],
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = new Response(child.stderr).text();
  child.stdin.write(`${JSON.stringify({
    id: 1,
    method: "initialize",
    params: { clientInfo: { name: "codex-chatgpt-web-route-smoke", version: "1" } },
  })}\n`);
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + 60_000;
  let buffer = "";
  let initialized = false;
  try {
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      let readTimeout: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          readTimeout = setTimeout(() => {
            reject(new Error("Codex app-server model/list timed out"));
          }, remaining);
        }),
      ]).finally(() => {
        if (readTimeout) clearTimeout(readTimeout);
      });
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = JSON.parse(line) as {
          id?: number;
          result?: { data?: ListedModel[] };
          error?: unknown;
        };
        if (message.id === 1 && !initialized) {
          if (message.error) throw new Error(`Codex app-server initialize failed: ${JSON.stringify(message.error)}`);
          initialized = true;
          child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
          child.stdin.write(`${JSON.stringify({
            id: 2,
            method: "model/list",
            params: { cursor: null, limit: 100, includeHidden: true },
          })}\n`);
        } else if (message.id === 2) {
          if (message.error) throw new Error(`Codex app-server model/list failed: ${JSON.stringify(message.error)}`);
          if (!Array.isArray(message.result?.data)) {
            throw new Error("Codex app-server model/list returned no model array");
          }
          return message.result.data;
        }
      }
    }
    throw new Error("Codex app-server ended before model/list completed");
  } catch (error) {
    child.kill();
    const stderrText = await stderr;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${detail}${stderrText.trim() ? `; stderr=${stderrText.trim()}` : ""}`);
  } finally {
    child.kill();
    await child.exited;
  }
}

try {
  const bundled = runCodex(["debug", "models", "--bundled"]);
  const sourceCatalog = JSON.parse(bundled.stdout) as { models?: unknown[] };
  if (!sourceCatalog.models?.some(model => model && typeof model === "object" && (model as { slug?: string }).slug === "gpt-5.6-sol")) {
    throw new Error("Bundled Codex catalog has no gpt-5.6-sol template");
  }

  process.env.CODEX_HOME = join(root, "codex");
  process.env.CODEX_CHATGPT_WEB_HOME = join(root, "app");
  mkdirSync(process.env.CODEX_HOME, { recursive: true });
  const config = defaultConfig("browser-only");
  config.proAvailable = true;
  const catalogPath = join(root, "augmented-models.json");
  writeFileSync(catalogPath, `${JSON.stringify(augmentNativeModelCatalog(sourceCatalog, config))}\n`);
  writeFileSync(join(process.env.CODEX_HOME, "config.toml"), `model_catalog_json = ${JSON.stringify(catalogPath)}\n`);
  const result = runCodex(["debug", "models"], { ...process.env, CODEX_HOME: process.env.CODEX_HOME });
  const catalog = JSON.parse(result.stdout) as { models?: Array<{ slug?: string; supported_reasoning_levels?: unknown[] }> };
  const web = catalog.models?.filter(model => model.slug?.startsWith("chatgpt-web/")) ?? [];
  const expected = CHATGPT_WEB_MODEL_ROUTES.map(route => ({ slug: route.slug, effort: route.codexEffort }));
  const actual = web.map(model => ({
    slug: model.slug,
    effort: Array.isArray(model.supported_reasoning_levels)
      ? (model.supported_reasoning_levels as Array<{ effort?: string }>).map(level => level.effort).join(",")
      : "",
  }));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Codex did not preserve the fixed ChatGPT Web model contract: ${JSON.stringify(actual)}`);
  }

  const routeCodexHome = join(root, "route-codex");
  const routeAppHome = join(root, "route-app");
  process.env.CODEX_HOME = routeCodexHome;
  process.env.CODEX_CHATGPT_WEB_HOME = routeAppHome;
  mkdirSync(routeCodexHome, { recursive: true });
  const liveAuthPath = join(homedir(), ".codex", "auth.json");
  if (!existsSync(liveAuthPath)) {
    throw new Error("Authenticated model-route smoke requires an existing Codex ChatGPT login");
  }
  const liveAuth = JSON.parse(readFileSync(liveAuthPath, "utf8")) as { auth_mode?: unknown };
  if (liveAuth.auth_mode !== "chatgpt") {
    throw new Error("Authenticated model-route smoke requires Codex ChatGPT auth mode");
  }
  copyFileSync(liveAuthPath, join(routeCodexHome, "auth.json"));
  const routeConfig = defaultConfig("browser-only");
  routeConfig.proAvailable = true;
  const routeCatalog = augmentNativeModelCatalog(sourceCatalog, routeConfig);
  const modelRequests: Array<{ path: string; authenticated: boolean }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const authorization = request.headers.get("authorization") ?? "";
      const authenticated = authorization.startsWith("Bearer ") && authorization.length > "Bearer ".length;
      modelRequests.push({ path: url.pathname, authenticated });
      if (url.pathname !== "/v1/models") return new Response("Not Found", { status: 404 });
      if (!authenticated) {
        return Response.json(
          { error: { message: "Native Codex passthrough requires the incoming Bearer authorization" } },
          { status: 502 },
        );
      }
      return Response.json(routeCatalog, { headers: { "cache-control": "no-store" } });
    },
  });
  try {
    if (!server.port) throw new Error("Authenticated model-route smoke server did not bind a port");
    routeConfig.port = server.port;
    installCodexIntegration(routeConfig);
    const installedConfig = readFileSync(join(routeCodexHome, "config.toml"), "utf8");
    if (!installedConfig.includes("requires_openai_auth = true")
      || installedConfig.includes("requires_openai_auth = false")) {
      throw new Error("Installed Codex provider does not opt into the OpenAI authentication its model route requires");
    }

    const routeEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      CODEX_HOME: routeCodexHome,
    };
    delete routeEnvironment.OPENAI_API_KEY;
    delete routeEnvironment.CODEX_ACCESS_TOKEN;
    delete routeEnvironment.CODEX_API_KEY;
    const listedModels = await runCodexModelList(routeEnvironment);
    const routedModels = listedModels.filter(model => model.id?.startsWith("chatgpt-web/"));
    const routedSlugs = routedModels.map(model => model.id!);
    const expectedSlugs = CHATGPT_WEB_MODEL_ROUTES.map(route => route.slug);
    if (JSON.stringify(routedSlugs) !== JSON.stringify(expectedSlugs)) {
      throw new Error(
        `Codex did not discover ChatGPT Web models through the installed provider: ${JSON.stringify(routedSlugs)}; `
        + `requests=${JSON.stringify(modelRequests)}`,
      );
    }
    if (routedModels.some(model => model.hidden !== false)) {
      throw new Error(`Codex app-server hid an installed ChatGPT Web model: ${JSON.stringify(routedModels)}`);
    }
    if (!modelRequests.some(request => request.path === "/v1/models" && request.authenticated)) {
      throw new Error(`Codex did not authenticate its installed provider model request: ${JSON.stringify(modelRequests)}`);
    }
  } finally {
    server.stop(true);
  }
  process.stdout.write("NATIVE_CODEX_CATALOG_SMOKE_OK\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
