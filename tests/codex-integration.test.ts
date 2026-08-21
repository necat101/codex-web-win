import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCodexIntegration, uninstallCodexIntegration } from "../src/codex-integration";
import { defaultConfig } from "../src/config";

const roots: string[] = [];
const originalCodexHome = process.env.CODEX_HOME;
const originalHarnessHome = process.env.CODEX_CHATGPT_WEB_HOME;

afterEach(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  if (originalHarnessHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
  else process.env.CODEX_CHATGPT_WEB_HOME = originalHarnessHome;
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("Codex model route integration", () => {
  test("migrates the legacy openai_base_url route to an authenticated SSE-only custom provider", () => {
    const root = mkdtempSync(join(tmpdir(), "codex web route (v10 migration)-"));
    roots.push(root);
    const codexHome = join(root, "codex");
    const harnessHome = join(root, "harness");
    process.env.CODEX_HOME = codexHome;
    process.env.CODEX_CHATGPT_WEB_HOME = harnessHome;
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(join(harnessHome, "codex"), { recursive: true });

    const configPath = join(codexHome, "config.toml");
    const bridgeUrl = "http://127.0.0.1:17841/v1";
    const originalConfig = 'model = "chatgpt-web/high"\n';
    writeFileSync(
      configPath,
      '# Managed by codex-chatgpt-web; `codex-chatgpt-web uninstall` restores prior values.\n'
        + `openai_base_url = ${JSON.stringify(bridgeUrl)}\n`
        + originalConfig,
    );
    writeFileSync(join(harnessHome, "codex", "integration-journal.json"), JSON.stringify({
      version: 10,
      configPath,
      installed: { openai_base_url: bridgeUrl },
      previous: {
        openai_base_url: { present: false },
        chatgpt_base_url: { present: false },
        model_provider: { present: false },
        model_catalog_json: { present: false },
      },
      previousProviderBlock: { present: false },
    }));
    const appConfig = defaultConfig("browser-only");
    installCodexIntegration(appConfig, { replaceExistingRoute: true });

    const migrated = readFileSync(configPath, "utf8");
    expect(migrated).toContain('model_provider = "codex-chatgpt-web"');
    expect(migrated).toContain("[model_providers.codex-chatgpt-web]");
    expect(migrated).toContain(`base_url = ${JSON.stringify(bridgeUrl)}`);
    expect(migrated).toContain('wire_api = "responses"');
    expect(migrated).toContain("requires_openai_auth = true");
    expect(migrated).toContain("supports_websockets = false");
    expect(migrated).not.toContain("openai_base_url");

    const journal = JSON.parse(readFileSync(join(harnessHome, "codex", "integration-journal.json"), "utf8"));
    expect(journal.version).toBe(12);
    expect(journal.migratedFromVersion).toBe(10);
    expect(journal.installed).toEqual({ model_provider: "codex-chatgpt-web", base_url: bridgeUrl });

    uninstallCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toBe(originalConfig);
  });

  test("migrates broken and manually repaired v11 providers without replacing the rollback baseline", () => {
    for (const previousAuth of [false, true]) {
      const root = mkdtempSync(join(tmpdir(), `codex web route (v11 ${previousAuth})-`));
      roots.push(root);
      const codexHome = join(root, "codex");
      const harnessHome = join(root, "harness");
      process.env.CODEX_HOME = codexHome;
      process.env.CODEX_CHATGPT_WEB_HOME = harnessHome;
      mkdirSync(codexHome, { recursive: true });
      mkdirSync(join(harnessHome, "codex"), { recursive: true });

      const configPath = join(codexHome, "config.toml");
      const bridgeUrl = "http://127.0.0.1:17841/v1";
      const originalConfig = 'model = "chatgpt-web/high"\n';
      writeFileSync(configPath, [
        originalConfig.trimEnd(),
        '# Managed by codex-chatgpt-web; `codex-chatgpt-web uninstall` restores prior values.',
        'model_provider = "codex-chatgpt-web"',
        "",
        "[model_providers.codex-chatgpt-web]",
        'name = "codex-chatgpt-web"',
        `base_url = ${JSON.stringify(bridgeUrl)}`,
        'wire_api = "responses"',
        `requires_openai_auth = ${previousAuth}`,
        "supports_websockets = false",
        "",
      ].join("\n"));
      writeFileSync(join(harnessHome, "codex", "integration-journal.json"), JSON.stringify({
        version: 11,
        configPath,
        installed: { model_provider: "codex-chatgpt-web", base_url: bridgeUrl },
        previous: {
          openai_base_url: { present: false },
          chatgpt_base_url: { present: false },
          model_provider: { present: false },
          model_catalog_json: { present: false },
        },
        previousProviderBlock: { present: false },
      }));
      const modelsCachePath = join(codexHome, "models_cache.json");
      writeFileSync(modelsCachePath, '{"stale":true}\n');

      const appConfig = defaultConfig("browser-only");
      installCodexIntegration(appConfig);

      const repaired = readFileSync(configPath, "utf8");
      expect(repaired).toContain("requires_openai_auth = true");
      expect(repaired).not.toContain("requires_openai_auth = false");
      expect(existsSync(modelsCachePath)).toBe(false);
      const journal = JSON.parse(readFileSync(join(harnessHome, "codex", "integration-journal.json"), "utf8"));
      expect(journal.version).toBe(12);
      expect(journal.migratedFromVersion).toBe(11);

      uninstallCodexIntegration();
      expect(readFileSync(configPath, "utf8")).toBe(originalConfig);
    }
  });
});
