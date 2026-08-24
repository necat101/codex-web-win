import type {
  CodexAssistantContentPart,
  CodexContentPart,
  CodexMessage,
  CodexParsedRequest,
} from "../../types";
import { deepSeekToolInstructions } from "./tool-protocol";

export interface CompiledDeepSeekWebPrompt {
  text: string;
  sourceChars: number;
}

const DEEPSEEK_TOOL_CALL_ID = /^deepseek_([0-9a-f]{12})_\d+$/;

function textContent(content: string | CodexContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .map(part => part.type === "text" ? part.text : "[image omitted: DeepSeek Web routes are text-only]")
    .join("\n");
}

function assistantContent(content: CodexAssistantContentPart[]): string {
  const blocks: string[] = [];
  for (const part of content) {
    if (part.type === "text") blocks.push(part.text);
    else if (part.type === "toolCall") {
      blocks.push(
        `[tool call from earlier provider: ${part.name} ${JSON.stringify(part.arguments)}]`,
      );
    }
    // Hidden/signed reasoning is deliberately not copied into another provider.
  }
  return blocks.join("\n");
}

function messageBlock(message: CodexMessage, index: number): string {
  if (message.role === "assistant") {
    return `<message index="${index}" role="assistant">\n${assistantContent(message.content)}\n</message>`;
  }
  if (message.role === "toolResult") {
    const status = message.isError ? "error" : "success";
    return `<message index="${index}" role="tool_result" tool="${message.toolName}" status="${status}">\n${textContent(message.content)}\n</message>`;
  }
  return `<message index="${index}" role="${message.role}">\n${textContent(message.content)}\n</message>`;
}

export function deepSeekPromptContainsImages(parsed: CodexParsedRequest): boolean {
  return parsed.context.messages.some(message => {
    if (message.role === "assistant") return false;
    if (typeof message.content === "string") return false;
    return message.content.some(part => part.type === "image");
  });
}

function trailingToolResults(parsed: CodexParsedRequest) {
  const results = [];
  for (let index = parsed.context.messages.length - 1; index >= 0; index--) {
    const message = parsed.context.messages[index]!;
    if (message.role !== "toolResult") break;
    results.unshift(message);
  }
  return results;
}

/**
 * A native Codex tool result can be sent back into the exact DeepSeek browser
 * chat that requested it. The synthetic call id embeds the producing browser
 * trace, which lets the worker prove the continuation belongs to its current
 * chat instead of guessing from thread ids or timing.
 */
export function deepSeekToolContinuationTraceId(parsed: CodexParsedRequest): string | undefined {
  const results = trailingToolResults(parsed);
  if (results.length === 0) return undefined;
  let traceId: string | undefined;
  for (const result of results) {
    const match = result.toolCallId.match(DEEPSEEK_TOOL_CALL_ID);
    if (!match) return undefined;
    if (traceId !== undefined && traceId !== match[1]) return undefined;
    traceId = match[1];
  }
  return traceId;
}

export function compileDeepSeekWebFollowUpPrompt(
  parsed: CodexParsedRequest,
  traceId: string,
): CompiledDeepSeekWebPrompt | undefined {
  const results = trailingToolResults(parsed);
  if (results.length === 0 || results.some(result => result.toolCallId.match(DEEPSEEK_TOOL_CALL_ID)?.[1] !== traceId)) {
    return undefined;
  }

  const blocks = [
    "Codex executed the tool call(s) you requested in your immediately preceding response.",
    "The tool results below are authoritative. Continue the same task from them now; request another tool if needed, otherwise finish the user's task.",
    "Unless the user explicitly asks for detail, keep the response concise and result-first; do not narrate internal reasoning or extended planning.",
  ];
  const toolInstructions = deepSeekToolInstructions(parsed);
  if (toolInstructions) blocks.push(`<codex_bridge_protocol>\n${toolInstructions}\n</codex_bridge_protocol>`);
  else blocks.push("You do not have an active Codex tool for this follow-up. Do not claim that you ran another command or edited another file.");
  results.forEach((message, index) => blocks.push(messageBlock(message, index)));
  if (parsed._structuredOutput) {
    blocks.push("Return only the requested JSON value, without a Markdown fence or surrounding prose.");
  }
  const text = blocks.join("\n\n");
  return { text, sourceChars: text.length };
}

function lastAssistantBoundary(parsed: CodexParsedRequest): number {
  for (let index = parsed.context.messages.length - 1; index >= 0; index--) {
    const message = parsed.context.messages[index]!;
    if (message.role !== "assistant") continue;
    if (assistantContent(message.content).trim()) return index;
  }
  return -1;
}

/**
 * Delta prompt for a browser chat that already contains the earlier Codex
 * conversation. Re-sending the expanded previous_response_id transcript on
 * every user turn both wastes context and encourages DeepSeek to imitate old
 * transport/tool markup, so only the messages after its last assistant turn
 * are forwarded here.
 */
export function compileDeepSeekWebContinuationPrompt(
  parsed: CodexParsedRequest,
): CompiledDeepSeekWebPrompt | undefined {
  const boundary = lastAssistantBoundary(parsed);
  if (boundary < 0) return undefined;
  const suffix = parsed.context.messages.slice(boundary + 1);
  if (suffix.length === 0 || suffix.every(message => message.role === "toolResult")) return undefined;

  const blocks = [
    "Continue the same Codex task in this existing DeepSeek chat.",
    "Only the new Codex messages since your last response are included below. Earlier conversation context is already present in this chat; do not treat this delta as a replacement transcript.",
    "Unless the user explicitly asks for detail, keep the response concise and result-first; do not narrate internal reasoning or extended planning.",
  ];
  const toolInstructions = deepSeekToolInstructions(parsed);
  if (toolInstructions) blocks.push(`<codex_bridge_protocol>\n${toolInstructions}\n</codex_bridge_protocol>`);
  else blocks.push("You do not have an active Codex tool for this turn. Do not claim that you ran commands or edited files.");
  suffix.forEach((message, offset) => blocks.push(messageBlock(message, boundary + 1 + offset)));
  if (parsed._structuredOutput) {
    blocks.push("Return only the requested JSON value, without a Markdown fence or surrounding prose.");
  }
  const text = blocks.join("\n\n");
  return { text, sourceChars: text.length };
}

/**
 * Full-history prompt used for a fresh DeepSeek chat and as the safe fallback
 * when an exact browser-chat continuation is unavailable.
 */
export function compileDeepSeekWebPrompt(parsed: CodexParsedRequest): CompiledDeepSeekWebPrompt {
  const blocks: string[] = [
    "You are continuing a Codex conversation through an explicit DeepSeek Web browser bridge.",
    "The serialized messages below are conversation history, in order. Continue as the assistant after the final message.",
    "Preserve the instruction priority represented by the serialized system, developer, and user messages. Bridge protocol instructions govern only how you interact with the Codex harness.",
    "Be action-oriented. When the user asks you to perform a task, make reasonable harmless assumptions and proceed instead of presenting a menu of choices or interviewing the user.",
    "Ask a clarifying question only when the missing information cannot be discovered from the available context/tools and a reasonable assumption would materially change the result or require new authority.",
    "Unless the user explicitly asks for detail, keep responses concise and result-first; do not narrate internal reasoning, extended planning, or repetitive summaries.",
  ];

  const toolInstructions = deepSeekToolInstructions(parsed);
  if (toolInstructions) blocks.push(`<codex_bridge_protocol>\n${toolInstructions}\n</codex_bridge_protocol>`);
  else blocks.push("You do not have an active Codex tool for this turn. Do not claim that you ran commands or edited files.");

  for (const instruction of parsed.context.systemPrompt ?? []) {
    blocks.push(`<message role="system">\n${instruction}\n</message>`);
  }
  parsed.context.messages.forEach((message, index) => blocks.push(messageBlock(message, index)));

  if (parsed._structuredOutput) {
    blocks.push("Return only the requested JSON value, without a Markdown fence or surrounding prose.");
  }

  const text = blocks.join("\n\n");
  return { text, sourceChars: text.length };
}
