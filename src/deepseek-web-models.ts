export const DEEPSEEK_WEB_MODEL_PREFIX = "deepseek-web/";
// Conservative harness boundary. The public Web UI has no stable, documented
// context contract, so do not inherit GPT-5.6 Sol's native catalog limits.
export const DEEPSEEK_WEB_CONTEXT_WINDOW = 64_000;
export const DEEPSEEK_WEB_AUTO_COMPACT_TOKEN_LIMIT = 56_000;

export type DeepSeekWebCodexEffort = "low" | "high";
export type DeepSeekWebAdapterMode = "instant" | "expert";

export interface DeepSeekWebModelRoute {
  slug: string;
  displayName: string;
  description: string;
  codexEffort: DeepSeekWebCodexEffort;
  adapterMode: DeepSeekWebAdapterMode;
}

/**
 * These are stable harness-facing modes rather than claims about a particular
 * versioned DeepSeek backend. The browser adapter owns the current UI mapping.
 */
export const DEEPSEEK_WEB_MODEL_ROUTES: readonly DeepSeekWebModelRoute[] = [
  {
    slug: "deepseek-web/instant",
    displayName: "DeepSeek Web — Instant",
    description: "DeepSeek Web Instant through the native Codex harness. Local Codex tool calls are relayed in full-harness mode.",
    codexEffort: "low",
    adapterMode: "instant",
  },
  {
    slug: "deepseek-web/expert",
    displayName: "DeepSeek Web — Expert",
    description: "DeepSeek Web Expert through the native Codex harness. Local Codex tool calls are relayed in full-harness mode.",
    codexEffort: "high",
    adapterMode: "expert",
  },
];

const routesBySlug = new Map(DEEPSEEK_WEB_MODEL_ROUTES.map(route => [route.slug, route]));

export function isDeepSeekWebModelSlug(modelId: string): boolean {
  return modelId.startsWith(DEEPSEEK_WEB_MODEL_PREFIX);
}

export function availableDeepSeekWebModelRoutes(enabled: boolean): readonly DeepSeekWebModelRoute[] {
  return enabled ? DEEPSEEK_WEB_MODEL_ROUTES : [];
}

export function requireDeepSeekWebModelRoute(modelId: string, enabled: boolean): DeepSeekWebModelRoute {
  const route = routesBySlug.get(modelId);
  if (!route) throw new Error(`DeepSeek web model is not enabled: ${modelId}`);
  if (!enabled) throw new Error("DeepSeek Web is not enabled; complete its explicit setup first");
  return route;
}
