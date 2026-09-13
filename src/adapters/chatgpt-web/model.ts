export const CHATGPT_WEB_SOL_MODEL_ID = "gpt-5.6-sol";
export const CHATGPT_WEB_LUNA_MODEL_ID = "gpt-5.6-luna";
export const CHATGPT_WEB_MODEL_ID = CHATGPT_WEB_SOL_MODEL_ID;

export interface ChatGptWebCapabilities {
  localToolsEnabled: boolean;
  proAvailable: boolean;
}

export interface ChatGptWebModelMode {
  modelId: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  displayLabel: "Instant" | "Medium" | "High" | "Extra High" | "Pro";
  uiEffortLabel: "Instant" | "Medium" | "High" | "Extra High" | "Pro";
  localTools: boolean;
}

export function resolveChatGptWebModelMode(
  modelId: string,
  reasoning: string | undefined,
  capabilities: ChatGptWebCapabilities,
): ChatGptWebModelMode {
  if (modelId !== CHATGPT_WEB_SOL_MODEL_ID && modelId !== CHATGPT_WEB_LUNA_MODEL_ID) {
    throw new Error(`ChatGPT web model is not supported: ${modelId}`);
  }
  const effort = reasoning ?? "high";
  if (modelId === CHATGPT_WEB_LUNA_MODEL_ID && effort !== "low") {
    throw new Error(`GPT-5.6 Luna only supports the low/Instant ChatGPT web route, received: ${effort}`);
  }
  if (modelId === CHATGPT_WEB_SOL_MODEL_ID && effort === "low") {
    throw new Error("GPT-5.6 Sol is not the low/Instant ChatGPT web route; use GPT-5.6 Luna");
  }
  switch (effort) {
    case "low":
      return { modelId, effort, displayLabel: "Instant", uiEffortLabel: "Instant", localTools: capabilities.localToolsEnabled };
    case "medium":
      return { modelId, effort, displayLabel: "Medium", uiEffortLabel: "Medium", localTools: capabilities.localToolsEnabled };
    case "high":
      return { modelId, effort, displayLabel: "High", uiEffortLabel: "High", localTools: capabilities.localToolsEnabled };
    case "xhigh":
      return { modelId, effort, displayLabel: "Extra High", uiEffortLabel: "Extra High", localTools: capabilities.localToolsEnabled };
    case "max":
      if (!capabilities.proAvailable) throw new Error("ChatGPT Pro effort is not available for this account");
      return { modelId, effort, displayLabel: "Pro", uiEffortLabel: "Pro", localTools: false };
    default:
      throw new Error(`ChatGPT web effort is not supported: ${effort}`);
  }
}
