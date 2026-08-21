import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../src/config";
import { augmentNativeModelCatalog } from "../src/model-catalog";
import { compactRequest, responseRequest } from "../src/server";

function config(mode: "browser-only" | "full"): AppConfig {
  return {
    mode,
    proAvailable: false,
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
});
