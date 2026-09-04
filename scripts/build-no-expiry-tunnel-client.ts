import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  requireTunnelClientTarget,
  TUNNEL_CLIENT_BUILD_ID,
  TUNNEL_CLIENT_UPSTREAM_COMMIT,
  TUNNEL_CLIENT_UPSTREAM_VERSION,
  type TunnelClientTarget,
  type TunnelClientTargetKey,
} from "../src/tunnel-client-artifact";

export {
  TUNNEL_CLIENT_BUILD_ID,
  TUNNEL_CLIENT_UPSTREAM_COMMIT,
  TUNNEL_CLIENT_UPSTREAM_VERSION,
};

const GO_VERSION = "1.26.2";
const SOURCE_ARCHIVE_SHA256 = "29653639ba4c3b4dbf5457c5bc269b36694b3d1d4eca008dceef41e2de1003e1";
const SOURCE_LICENSE_SHA256 = "f4c1d7ba32ef5bcf5cf03e2eefec5825ebafedf50fa330a36700a49c605c1ef4";
const SOURCE_NOTICE_SHA256 = "1364c020d86ecf948b78b7c655175032068203d13aece70fb0bfe112d7802dc2";
const root = resolve(import.meta.dir, "..");
const cacheRoot = join(root, "node_modules", ".cache", "codex-chatgpt-web", "tunnel-client-no-expiry");

const GO_HOST_TOOLCHAINS = {
  "windows-amd64": {
    platform: "win32",
    arch: "x64",
    archiveName: `go${GO_VERSION}.windows-amd64.zip`,
    archiveSha256: "98eb3570bade15cb826b0909338df6cc6d2cf590bc39c471142002db3832b708",
    executable: join("go", "bin", "go.exe"),
  },
  "windows-arm64": {
    platform: "win32",
    arch: "arm64",
    archiveName: `go${GO_VERSION}.windows-arm64.zip`,
    archiveSha256: "094d05caaf6ba235e2bd570b625d064ceb65943866252722a8f3fdba232139c6",
    executable: join("go", "bin", "go.exe"),
  },
  "darwin-amd64": {
    platform: "darwin",
    arch: "x64",
    archiveName: `go${GO_VERSION}.darwin-amd64.tar.gz`,
    archiveSha256: "bc3f1500d9968c36d705442d90ba91addf9271665033748b82532682e90a7966",
    executable: join("go", "bin", "go"),
  },
  "darwin-arm64": {
    platform: "darwin",
    arch: "arm64",
    archiveName: `go${GO_VERSION}.darwin-arm64.tar.gz`,
    archiveSha256: "32af1522bf3e3ff3975864780a429cc0b41d190ec7bf90faa661d6d64566e7af",
    executable: join("go", "bin", "go"),
  },
} as const;

type GoHostToolchain = (typeof GO_HOST_TOOLCHAINS)[keyof typeof GO_HOST_TOOLCHAINS];

export interface PatchedTunnelClientArtifact {
  target: TunnelClientTargetKey;
  binaryName: string;
  binaryPath: string;
  licensePath: string;
  noticePath: string;
  receiptPath: string;
  sha256: string;
}

function hostToolchain(): GoHostToolchain {
  const toolchain = Object.values(GO_HOST_TOOLCHAINS).find(candidate => (
    candidate.platform === process.platform && candidate.arch === process.arch
  ));
  if (!toolchain) throw new Error(`The pinned Go toolchain does not support ${process.platform}/${process.arch}`);
  return toolchain;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function downloadVerified(url: string, destination: string, expectedHash: string): Promise<void> {
  if (existsSync(destination) && sha256(destination) === expectedHash) return;
  mkdirSync(dirname(destination), { recursive: true });
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  const temporary = `${destination}.next-${process.pid}`;
  writeFileSync(temporary, new Uint8Array(await response.arrayBuffer()));
  const actualHash = sha256(temporary);
  if (actualHash !== expectedHash) {
    rmSync(temporary, { force: true });
    throw new Error(`SHA-256 mismatch for ${url}: expected ${expectedHash}, received ${actualHash}`);
  }
  rmSync(destination, { force: true });
  renameSync(temporary, destination);
}

function extract(archive: string, destination: string): void {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  const result = Bun.spawnSync([process.platform === "win32" ? "tar.exe" : "tar", "-xf", archive, "-C", destination], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`Archive extraction failed: ${result.stderr.toString() || result.stdout.toString()}`);
  }
}

function replaceExactly(path: string, before: string, after: string): void {
  const original = readFileSync(path, "utf8");
  const first = original.indexOf(before);
  if (first < 0 || original.indexOf(before, first + before.length) >= 0) {
    throw new Error(`Pinned tunnel-client patch context is missing or ambiguous: ${path}`);
  }
  writeFileSync(path, original.slice(0, first) + after + original.slice(first + before.length));
}

function applyNoExpiryPatch(sourceRoot: string): void {
  const configPath = join(sourceRoot, "pkg", "runtimeconfig", "config.go");
  const processorPath = join(sourceRoot, "pkg", "dispatcher", "internal", "processor.go");
  const configTestPath = join(sourceRoot, "pkg", "runtimeconfig", "shared_config_test.go");
  const processorTestPath = join(sourceRoot, "pkg", "dispatcher", "internal", "processor_test.go");
  replaceExactly(
    configPath,
    '\tif ttl <= 0 {\n\t\treturn MCPConfig{}, errors.New("mcp.connection-max-ttl must be positive")\n\t}',
    '\tif ttl < 0 {\n\t\treturn MCPConfig{}, errors.New("mcp.connection-max-ttl must be non-negative")\n\t}',
  );
  replaceExactly(
    processorPath,
    '\tif p.MCPConfig.ConnectionMaxTTL <= 0 {\n\t\treturn nil, fmt.Errorf("dispatcher processor: non-positive MCP connection TTL")\n\t}',
    '\tif p.MCPConfig.ConnectionMaxTTL < 0 {\n\t\treturn nil, fmt.Errorf("dispatcher processor: negative MCP connection TTL")\n\t}',
  );
  replaceExactly(
    configTestPath,
    "func TestLoadRejectsNonPositiveMCPConnectionTTL(t *testing.T)",
    "func TestLoadRejectsNegativeMCPConnectionTTL(t *testing.T)",
  );
  replaceExactly(
    configTestPath,
    '"--mcp.connection-max-ttl=0s",',
    '"--mcp.connection-max-ttl=-1s",',
  );
  replaceExactly(
    configTestPath,
    "expected error for non-positive connection ttl",
    "expected error for negative connection ttl",
  );
  replaceExactly(
    processorTestPath,
    '\t\t\tname: "non_positive_ttl",\n\t\t\tparams: processorParams{\n\t\t\t\tLogger:          logger,\n\t\t\t\tChannelBindings: newTestChannelBindings(transport),\n\t\t\t\tTunnelResponder: responder,\n\t\t\t\tMCPConfig: func() *config.MCPConfig {\n\t\t\t\t\tcfg := *validMCP\n\t\t\t\t\tcfg.ConnectionMaxTTL = 0',
    '\t\t\tname: "negative_ttl",\n\t\t\tparams: processorParams{\n\t\t\t\tLogger:          logger,\n\t\t\t\tChannelBindings: newTestChannelBindings(transport),\n\t\t\t\tTunnelResponder: responder,\n\t\t\t\tMCPConfig: func() *config.MCPConfig {\n\t\t\t\t\tcfg := *validMCP\n\t\t\t\t\tcfg.ConnectionMaxTTL = -time.Second',
  );

  const forwarder = readFileSync(processorPath, "utf8");
  if (!/connectionMaxTTL\s*>\s*0/.test(forwarder)) {
    throw new Error("Pinned tunnel-client no longer guards its MCP TTL timer with connectionMaxTTL > 0");
  }
}

function addNoExpiryRegressionTests(sourceRoot: string): void {
  writeFileSync(join(sourceRoot, "pkg", "runtimeconfig", "codexweb_no_expiry_test.go"), `package runtimeconfig

import (
  "strings"
  "testing"
)

func TestCodexWebAcceptsDisabledMCPConnectionTTL(t *testing.T) {
  t.Parallel()
  cfg, err := LoadRuntimeForTest([]string{
    "--control-plane.tunnel-id", "tunnel_0123456789abcdef0123456789abcdef",
    "--mcp.server-url", "https://mcp.default",
  }, func(key string) (string, bool) {
    switch key {
    case "CONTROL_PLANE_API_KEY":
      return "key", true
    case "LOG_FORMAT":
      return "struct-text", true
    case "MCP_CONNECTION_MAX_TTL":
      return "0s", true
    default:
      return "", false
    }
  })
  if err != nil {
    t.Fatalf("Load returned error: %v", err)
  }
  if cfg.MCP.ConnectionMaxTTL != 0 {
    t.Fatalf("expected disabled connection ttl, got %s", cfg.MCP.ConnectionMaxTTL)
  }
}

func TestCodexWebRejectsNegativeMCPConnectionTTL(t *testing.T) {
  t.Parallel()
  _, err := LoadRuntimeForTest([]string{
    "--control-plane.tunnel-id", "tunnel_0123456789abcdef0123456789abcdef",
    "--mcp.server-url", "https://mcp.default",
    "--mcp.connection-max-ttl=-1s",
  }, func(key string) (string, bool) {
    if key == "CONTROL_PLANE_API_KEY" {
      return "key", true
    }
    if key == "LOG_FORMAT" {
      return "struct-text", true
    }
    return "", false
  })
  if err == nil {
    t.Fatal("expected error for negative connection ttl")
  }
  if !strings.Contains(err.Error(), "mcp.connection-max-ttl") {
    t.Fatalf("unexpected error: %v", err)
  }
}
`);

  writeFileSync(join(sourceRoot, "pkg", "dispatcher", "internal", "codexweb_no_expiry_test.go"), `package dispatcherinternal

import (
  "io"
  "log/slog"
  "net/http"
  "testing"
  "time"

  "github.com/stretchr/testify/require"
)

func TestCodexWebNewProcessorAcceptsDisabledConnectionTTL(t *testing.T) {
  t.Parallel()
  logger := slog.New(slog.NewTextHandler(io.Discard, nil))
  responder := newRecordingResponder()
  transport := &stubForwardingTransport{conn: &stubForwardingConnection{}}
  mcpCfg := newTestMCPConfig(t, time.Second)
  mcpCfg.ConnectionMaxTTL = 0

  processor, err := NewProcessor(processorParams{
    Logger: logger,
    ChannelBindings: newTestChannelBindings(transport),
    TunnelResponder: responder,
    MCPConfig: mcpCfg,
    OAuthHTTPClient: &http.Client{},
    ControlPlaneCfg: newTestControlPlaneConfig(t),
    MeterProvider: newTestMeterProvider(t),
  })
  require.NoError(t, err)
  require.NotNil(t, processor)
}
`);
}

function smokeNoExpiryBinary(binary: string, target: TunnelClientTarget): void {
  const mcpCommand = target.platform === "win32" ? "cmd.exe" : "/bin/sh";
  const smoke = Bun.spawnSync([
    binary,
    "doctor",
    "--control-plane.tunnel-id", "tunnel_0123456789abcdef0123456789abcdef",
    "--mcp.command", mcpCommand,
    "--health.listen-addr", "127.0.0.1:0",
    "--json",
  ], {
    cwd: root,
    env: {
      ...process.env,
      CONTROL_PLANE_API_KEY: "synthetic-runtime-key",
      MCP_CONNECTION_MAX_TTL: "0s",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = smoke.stdout.toString();
  if (smoke.exitCode !== 0) {
    throw new Error(`Patched tunnel-client rejected disabled TTL: ${smoke.stderr.toString() || stdout}`);
  }
  const parsed = JSON.parse(stdout) as { result?: string };
  if (parsed.result !== "ok") throw new Error(`Patched tunnel-client doctor did not pass: ${stdout}`);
}

function onlyDirectory(path: string): string {
  const directories = readdirSync(path)
    .map(name => join(path, name))
    .filter(candidate => statSync(candidate).isDirectory());
  if (directories.length !== 1) throw new Error(`Expected one source directory in ${path}`);
  return directories[0]!;
}

export async function buildNoExpiryTunnelClient(): Promise<PatchedTunnelClientArtifact> {
  const target = requireTunnelClientTarget();
  const toolchain = hostToolchain();
  const artifactRoot = join(cacheRoot, TUNNEL_CLIENT_BUILD_ID, target.key);
  const binaryPath = join(artifactRoot, target.binaryName);
  const licensePath = join(artifactRoot, "LICENSE.txt");
  const noticePath = join(artifactRoot, "NOTICE.txt");
  const receiptPath = join(artifactRoot, "BUILD-RECEIPT.json");
  if (existsSync(binaryPath)
    && existsSync(licensePath)
    && existsSync(noticePath)
    && existsSync(receiptPath)
    && sha256(binaryPath) === target.binarySha256) {
    return {
      target: target.key,
      binaryName: target.binaryName,
      binaryPath,
      licensePath,
      noticePath,
      receiptPath,
      sha256: target.binarySha256,
    };
  }

  const downloads = join(cacheRoot, "downloads");
  const goArchive = join(downloads, toolchain.archiveName);
  const sourceArchive = join(downloads, `tunnel-client-${TUNNEL_CLIENT_UPSTREAM_COMMIT}.tar.gz`);
  await Promise.all([
    downloadVerified(`https://go.dev/dl/${toolchain.archiveName}`, goArchive, toolchain.archiveSha256),
    downloadVerified("https://api.github.com/repos/openai/tunnel-client/tarball/v0.0.12", sourceArchive, SOURCE_ARCHIVE_SHA256),
  ]);

  const goRoot = join(cacheRoot, `go${GO_VERSION}.${target.key}`);
  const goExecutable = join(goRoot, toolchain.executable);
  if (!existsSync(goExecutable)) extract(goArchive, goRoot);
  if (!existsSync(goExecutable)) throw new Error(`Pinned Go toolchain is incomplete: ${goExecutable}`);

  const work = join(cacheRoot, `.work-${process.pid}`);
  const sourceContainer = join(work, "source");
  rmSync(work, { recursive: true, force: true });
  try {
    extract(sourceArchive, sourceContainer);
    const sourceRoot = onlyDirectory(sourceContainer);
    applyNoExpiryPatch(sourceRoot);
    addNoExpiryRegressionTests(sourceRoot);
    const sourceLicense = join(sourceRoot, "LICENSE");
    const sourceNotice = join(sourceRoot, "NOTICE");
    if (!existsSync(sourceLicense)) throw new Error("Pinned tunnel-client source archive has no LICENSE");
    if (!existsSync(sourceNotice)) throw new Error("Pinned tunnel-client source archive has no NOTICE");

    const candidate = join(work, target.binaryName);
    const environment = {
      ...process.env,
      CGO_ENABLED: "0",
      GOOS: target.goos,
      GOARCH: target.goarch,
      GOTOOLCHAIN: "local",
      GOCACHE: join(cacheRoot, "go-build-cache"),
      GOMODCACHE: join(cacheRoot, "go-module-cache"),
    };
    const tests = Bun.spawnSync([
      goExecutable,
      "test",
      "./pkg/runtimeconfig",
      "./pkg/dispatcher/internal",
    ], { cwd: sourceRoot, env: environment, stdout: "inherit", stderr: "inherit" });
    if (tests.exitCode !== 0) {
      throw new Error(`Patched tunnel-client regression tests failed with exit code ${tests.exitCode}`);
    }
    const build = Bun.spawnSync([
      goExecutable,
      "build",
      "-trimpath",
      "-buildvcs=false",
      "-ldflags",
      `-X github.com/openai/tunnel-client/pkg/version.GitSHA=${TUNNEL_CLIENT_UPSTREAM_COMMIT}-codexweb-no-expiry.1`,
      "-o",
      candidate,
      "./cmd/client",
    ], { cwd: sourceRoot, env: environment, stdout: "inherit", stderr: "inherit" });
    if (build.exitCode !== 0 || !existsSync(candidate)) {
      throw new Error(`Patched tunnel-client build failed with exit code ${build.exitCode}`);
    }
    if (target.platform !== "win32") chmodSync(candidate, 0o755);
    smokeNoExpiryBinary(candidate, target);
    const binaryHash = sha256(candidate);
    if (binaryHash !== target.binarySha256) {
      throw new Error(
        `Patched tunnel-client SHA-256 mismatch for ${target.key}: expected ${target.binarySha256}, received ${binaryHash}`,
      );
    }

    mkdirSync(artifactRoot, { recursive: true });
    copyFileSync(candidate, binaryPath);
    copyFileSync(sourceLicense, licensePath);
    copyFileSync(sourceNotice, noticePath);
    writeFileSync(receiptPath, `${JSON.stringify({
      schemaVersion: 1,
      buildId: TUNNEL_CLIENT_BUILD_ID,
      upstreamVersion: TUNNEL_CLIENT_UPSTREAM_VERSION,
      upstreamCommit: TUNNEL_CLIENT_UPSTREAM_COMMIT,
      upstreamSourceSha256: SOURCE_ARCHIVE_SHA256,
      patch: "patches/tunnel-client-v0.0.12-no-expiry.patch",
      goVersion: GO_VERSION,
      goArchiveSha256: toolchain.archiveSha256,
      target: `${target.goos}/${target.goarch}`,
      binarySha256: binaryHash,
    }, null, 2)}\n`);
    process.stdout.write(`PATCHED_TUNNEL_CLIENT_SHA256=${binaryHash}\n`);
    return {
      target: target.key,
      binaryName: target.binaryName,
      binaryPath,
      licensePath,
      noticePath,
      receiptPath,
      sha256: binaryHash,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const artifact = await buildNoExpiryTunnelClient();
  process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
}
