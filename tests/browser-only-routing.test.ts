import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../src/config";
import { augmentNativeModelCatalog } from "../src/model-catalog";
import { compactRequest, responseRequest } from "../src/server";

function config(mode: "browser-only" | "full", deepSeekEnabled = false): AppConfig {
  return {
    mode,
    proAvailable: false,
    ...(deepSeekEnabled ? {
      deepSeekWeb: {
        enabled: true,
        storageStatePath: "C:\\test\\deepseek-storage-state.json",
        acknowledgedAt: "2026-08-23T00:00:00.000Z",
      },
    } : {}),
  } as AppConfig;
}

const nativeTemplate = {
  object: "list",
  models: [{
    slug: "gpt-5.6-sol",
    display_name: "GPT-5.6 Sol",
    context_window: 256_000,
    max_context_window: 256_000,
    auto_compact_token_limit: 220_000,
    tool_mode: "code_mode_only",
    comp_hash: "native-only-hash",
    supported_reasoning_levels: [{ effort: "high", description: "High" }],
  }, {
    slug: "another-native-model",
    display_name: "Another native model",
  }],
};

describe("browser-only native routing guard", () => {
  test("hides native models from the catalog", () => {
    const catalog = augmentNativeModelCatalog(nativeTemplate, config("browser-only"));
    const slugs = (catalog.models as Array<{ slug: string }>).map(model => model.slug);
    expect(slugs.length).toBeGreaterThan(0);
    expect(slugs.every(slug => slug.startsWith("chatgpt-web/"))).toBe(true);
  });

  test("full mode keeps native models available", () => {
    const catalog = augmentNativeModelCatalog(nativeTemplate, config("full"));
    const slugs = (catalog.models as Array<{ slug: string }>).map(model => model.slug);
    expect(slugs).toContain("gpt-5.6-sol");
    expect(slugs).toContain("another-native-model");
    expect(slugs.some(slug => slug.startsWith("chatgpt-web/"))).toBe(true);
  });

  test("adds opt-in DeepSeek Web models without replacing ChatGPT Web models", () => {
    const catalog = augmentNativeModelCatalog(nativeTemplate, config("browser-only", true));
    const models = catalog.models as Array<Record<string, unknown>>;
    const slugs = models.map(model => model.slug);

    expect(slugs).toContain("chatgpt-web/high");
    expect(slugs).toContain("deepseek-web/instant");
    expect(slugs).toContain("deepseek-web/expert");
    expect(slugs.filter(slug => typeof slug === "string" && slug.startsWith("deepseek-web/")))
      .toEqual(["deepseek-web/instant", "deepseek-web/expert"]);
    expect(models.find(model => model.slug === "deepseek-web/instant")).toMatchObject({
      input_modalities: ["text"],
      tool_mode: null,
      default_reasoning_level: "low",
      service_tiers: [],
      context_window: 64_000,
      max_context_window: 64_000,
      auto_compact_token_limit: 56_000,
    });
    expect(models.find(model => model.slug === "deepseek-web/expert")).toMatchObject({
      input_modalities: ["text"],
      tool_mode: null,
      default_reasoning_level: "high",
      service_tiers: [],
    });
  });

  test("keeps native models while DeepSeek does not inherit code-mode-only routing in full mode", () => {
    const catalog = augmentNativeModelCatalog(nativeTemplate, config("full", true));
    const models = catalog.models as Array<Record<string, unknown>>;
    const slugs = models.map(model => model.slug);

    expect(slugs).toContain("gpt-5.6-sol");
    expect(slugs).toContain("chatgpt-web/high");
    expect(slugs).toContain("deepseek-web/instant");
    expect(slugs).toContain("deepseek-web/expert");
    expect(models.find(model => model.slug === "gpt-5.6-sol")?.tool_mode).toBe("code_mode_only");
    expect(models.find(model => model.slug === "deepseek-web/instant")?.tool_mode).toBeNull();
    expect(models.find(model => model.slug === "deepseek-web/expert")?.tool_mode).toBeNull();
  });

  test("keeps native context boundaries so Codex can compact web-model history", () => {
    const catalog = augmentNativeModelCatalog(nativeTemplate, config("browser-only"));
    const web = (catalog.models as Array<Record<string, unknown>>)
      .find(model => model.slug === "chatgpt-web/high");

    expect(web).toMatchObject({
      context_window: 256_000,
      max_context_window: 256_000,
      auto_compact_token_limit: 220_000,
    });
    expect(web?.comp_hash).toBeUndefined();
  });

  test("rejects non-web response requests before native passthrough", async () => {
    const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello" }),
    }), config("browser-only"));

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Native Codex passthrough is disabled in browser-only mode");
  });

  test("rejects non-web compaction requests before native passthrough", async () => {
    const response = await compactRequest(new Request("http://127.0.0.1/v1/responses/compact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: [] }),
    }), config("browser-only"));

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Native Codex passthrough is disabled in browser-only mode");
  });

  test("rejects disabled and unknown DeepSeek response models locally", async () => {
    const disabled = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "deepseek-web/instant", input: "hello" }),
    }), config("browser-only"));
    expect(disabled.status).toBe(400);
    expect(await disabled.text()).toContain("DeepSeek Web is not enabled");

    const unknown = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "deepseek-web/unknown", input: "hello" }),
    }), config("full", true));
    expect(unknown.status).toBe(400);
    expect(await unknown.text()).toContain("DeepSeek web model is not enabled: deepseek-web/unknown");
  });

  test("dispatches an enabled DeepSeek response to its browser adapter preflight", async () => {
    const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "deepseek-web/instant", input: "hello", stream: false }),
    }), config("browser-only", true));

    expect(response.status).toBe(401);
    expect(await response.text()).toContain("deepseek_login_required");
  });

  test("rejects unknown DeepSeek compaction models locally in full mode", async () => {
    const response = await compactRequest(new Request("http://127.0.0.1/v1/responses/compact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "deepseek-web/unknown", input: [] }),
    }), config("full", true));

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("DeepSeek web model is not enabled: deepseek-web/unknown");
  });
});
