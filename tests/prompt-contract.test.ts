import { describe, expect, test } from "bun:test";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import type { CodexParsedRequest } from "../src/types";

function minimalRequest(): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-sol",
    stream: true,
    options: { reasoning: "high" },
    context: {
      messages: [{ role: "user", content: "test", timestamp: 0 }],
    },
  };
}

describe("ChatGPT Web transport contract", () => {
  test("keeps the native bridge contract compact while preserving required controls", () => {
    const compiled = compileChatGptWebPrompt(
      minimalRequest(),
      { localToolsEnabled: true, proAvailable: false },
      "turn_00000000000000000000000000000000",
    );

    expect(compiled.text).toContain("call codex_bind_turn");
    expect(compiled.text).toContain("dangerFullAccess");
    expect(compiled.text).toContain("codex_tool_inventory");
    expect(compiled.text).toContain("before concluding local command execution is unavailable");
    expect(compiled.text).toContain("__bridge_read_compaction");
    expect(compiled.text).toContain("CODEX_SHARED_TUNNEL_ROUTE_MISS");
    expect(compiled.text).toContain("up to 8 additional times");
    expect(compiled.text).toContain("Return only the answer that the outer Codex task should receive.");
    expect(compiled.text.length).toBeLessThan(5_200);
  });
});
