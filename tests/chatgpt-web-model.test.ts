import { describe, expect, test } from "bun:test";
import {
  CHATGPT_WEB_LUNA_MODEL_ID,
  CHATGPT_WEB_SOL_MODEL_ID,
  resolveChatGptWebModelMode,
} from "../src/adapters/chatgpt-web/model";
import { chatGptEffortLabelsMatch } from "../src/adapters/chatgpt-web/browser-worker";

const capabilities = { localToolsEnabled: true, proAvailable: false };

describe("ChatGPT 5.6 web model wiring", () => {
  test("maps Luna exclusively to low/Instant", () => {
    expect(resolveChatGptWebModelMode(CHATGPT_WEB_LUNA_MODEL_ID, "low", capabilities)).toMatchObject({
      modelId: "gpt-5.6-luna",
      effort: "low",
      displayLabel: "Instant",
      uiEffortLabel: "Instant",
      localTools: true,
    });
    expect(() => resolveChatGptWebModelMode(CHATGPT_WEB_LUNA_MODEL_ID, "high", capabilities)).toThrow(
      "GPT-5.6 Luna only supports the low/Instant ChatGPT web route",
    );
  });

  test("maps Sol high to High and rejects the low route", () => {
    expect(resolveChatGptWebModelMode(CHATGPT_WEB_SOL_MODEL_ID, "high", capabilities)).toMatchObject({
      modelId: "gpt-5.6-sol",
      effort: "high",
      displayLabel: "High",
      uiEffortLabel: "High",
      localTools: true,
    });
    expect(() => resolveChatGptWebModelMode(CHATGPT_WEB_SOL_MODEL_ID, "low", capabilities)).toThrow(
      "use GPT-5.6 Luna",
    );
  });

  test("accepts versioned and unversioned Instant UI labels", () => {
    expect(chatGptEffortLabelsMatch("Instant", "Instant")).toBe(true);
    expect(chatGptEffortLabelsMatch("Instant 5.5", "Instant")).toBe(true);
    expect(chatGptEffortLabelsMatch("Instant 5.6", "Instant")).toBe(true);
  });
});
