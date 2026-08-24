import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { deepSeekLoginVerificationMarkerPath } from "../../deepseek-browser-login";
import { requireDeepSeekWebModelRoute } from "../../deepseek-web-models";
import { estimateTokens } from "../../lib/token-estimate";
import { CODEX_TURN_METADATA_KEY } from "../../responses/turn-metadata";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../../types";
import { AdapterTurnError, type ProviderAdapter } from "../base";
import { DeepSeekBrowserTurnFailure, DeepSeekBrowserWorker } from "./browser-worker";
import {
  compileDeepSeekWebContinuationPrompt,
  compileDeepSeekWebFollowUpPrompt,
  compileDeepSeekWebPrompt,
  deepSeekPromptContainsImages,
  deepSeekToolContinuationTraceId,
} from "./prompt";
import {
  deepSeekEffectiveTools,
  deepSeekResponseNeedsToolRecovery,
  deepSeekToolRecoveryPrompt,
  parseDeepSeekToolRequests,
  type DeepSeekToolRequest,
} from "./tool-protocol";

const DEEPSEEK_MAX_NARRATION_RECOVERY_ATTEMPTS = 2;

export function emitDeepSeekToolRequests(
  requests: DeepSeekToolRequest[],
  traceId: string,
  usage: Extract<AdapterEvent, { type: "done" }>["usage"],
  emit: (event: AdapterEvent) => void,
): void {
  requests.forEach((request, index) => {
    emit({ type: "tool_call_start", id: `deepseek_${traceId}_${index}`, name: request.name });
    emit({ type: "tool_call_delta", arguments: JSON.stringify(request.arguments) });
    emit({ type: "tool_call_end" });
  });
  emit({
    type: "done",
    stopReason: "tool_use",
    endTurn: false,
    usage,
  } satisfies AdapterEvent);
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function deepSeekTurnMetadata(parsed: CodexParsedRequest): Record<string, unknown> | undefined {
  const raw = objectRecord(parsed._rawBody);
  const metadata = objectRecord(raw?.client_metadata);
  const encoded = metadata?.[CODEX_TURN_METADATA_KEY];
  if (typeof encoded === "string") {
    try {
      return objectRecord(JSON.parse(encoded)) ?? metadata;
    } catch {
      return metadata;
    }
  }
  return metadata;
}

/**
 * Codex retries a transport failure with the same turn id, while an intentional
 * later send receives a new one. Use that identity when available so replay
 * suppression never turns into a semantic response cache across user turns.
 */
export function deepSeekRequestTurnIdentity(parsed: CodexParsedRequest): string {
  const metadata = deepSeekTurnMetadata(parsed);
  const flatTurnId = metadata?.turn_id;
  if (typeof flatTurnId === "string" && flatTurnId) return flatTurnId;
  return "";
}

export function deepSeekConversationKey(
  parsed: CodexParsedRequest,
  modelSlug: string,
): string | undefined {
  const metadata = deepSeekTurnMetadata(parsed);
  const threadId = typeof metadata?.thread_id === "string" ? metadata.thread_id.trim() : "";
  const clientThreadId = typeof parsed._clientThreadId === "string" ? parsed._clientThreadId.trim() : "";
  const identity = threadId || clientThreadId;
  if (!identity) return undefined;
  return createHash("sha256")
    .update(modelSlug)
    .update("\0")
    .update(identity)
    .update("\0")
    .update(parsed._contextCompactionEpoch ?? "")
    .digest("hex")
    .slice(0, 24);
}

export function deepSeekTraceId(
  parsed: CodexParsedRequest,
  modelSlug: string,
  promptText: string,
): string {
  return createHash("sha256")
    .update(modelSlug)
    .update("\0")
    .update(deepSeekRequestTurnIdentity(parsed))
    .update("\0")
    .update(parsed._clientThreadId ?? "")
    .update("\0")
    .update(parsed.previousResponseId ?? "")
    .update("\0")
    .update(promptText)
    .digest("hex")
    .slice(0, 12);
}

export function deepSeekToolRecoveryTraceId(traceId: string, responseText: string): string {
  return createHash("sha256")
    .update(traceId)
    .update("\0tool-recovery\0")
    .update(responseText)
    .digest("hex")
    .slice(0, 12);
}

export function classifiedDeepSeekError(error: unknown): AdapterTurnError {
  if (error instanceof AdapterTurnError) return error;
  if (error instanceof DOMException && error.name === "AbortError") {
    return new AdapterTurnError(error.message, {
      status: 499,
      errorType: "cancelled",
      code: "turn_cancelled",
      retryable: false,
    }, { cause: error });
  }
  const message = error instanceof Error ? error.message : String(error);
  const postSubmit = error instanceof DeepSeekBrowserTurnFailure && error.submissionAttempted;
  const runtimeFailure = (status: number, errorType: string) => new AdapterTurnError(message, {
    status,
    errorType,
    // DeepSeek browser automation intentionally has no automatic replay path.
    // codex-rs currently retries streamed response.failed events with unfamiliar
    // codes even when retryable=false is present. `invalid_prompt` is its
    // established non-retryable code, so use it for every browser-runtime
    // failure and let the user explicitly resend after fixing the condition.
    code: "invalid_prompt",
    retryable: false,
  }, error instanceof Error ? { cause: error } : undefined);
  if (postSubmit) {
    return runtimeFailure(400, "invalid_request_error");
  }
  if (/login (?:is required|expired|state is missing)|missing or unverified/i.test(message)) {
    return runtimeFailure(401, "authentication_error");
  }
  if (/\b(?:403|WAF|security challenge|access control|blocked)\b/i.test(message)) {
    return runtimeFailure(403, "permission_error");
  }
  if (/no observable progress|continuous minutes/i.test(message)) {
    return runtimeFailure(504, "upstream_timeout");
  }
  const contractDrift = /UI contract drift|composer rejected|submission could not be confirmed|response DOM (?:was unavailable|could not be inspected|disappeared)|did not create a response DOM|completed without a readable final answer|browser page closed unexpectedly|changed Markdown|final Markdown rewrote|DeepSeek .*tool|codex_tool_calls|active Codex round did not advertise/i.test(message);
  if (contractDrift) {
    return runtimeFailure(400, "invalid_request_error");
  }
  return runtimeFailure(502, "upstream_error");
}

function assertConfiguredLogin(provider: CodexProviderConfig): void {
  const config = provider.deepseekWeb;
  if (!config?.enabled) {
    throw new AdapterTurnError("DeepSeek Web is not enabled", {
      status: 400,
      errorType: "invalid_request_error",
      code: "model_not_enabled",
      retryable: false,
    });
  }
  if (!config.storageStatePath
    || !existsSync(config.storageStatePath)
    || !existsSync(deepSeekLoginVerificationMarkerPath(config.storageStatePath))) {
    throw new AdapterTurnError(
      "DeepSeek Web login state is missing or unverified; run codex-chatgpt-web deepseek-login",
      {
        status: 401,
        errorType: "authentication_error",
        code: "deepseek_login_required",
        retryable: false,
      },
    );
  }
}

export function createDeepSeekWebAdapter(provider: CodexProviderConfig): ProviderAdapter {
  const worker = DeepSeekBrowserWorker.forProvider(provider);
  return {
    name: "deepseek-web",
    validateTurn(parsed) {
      assertConfiguredLogin(provider);
      requireDeepSeekWebModelRoute(parsed.modelId, provider.deepseekWeb?.enabled === true);
      if (deepSeekPromptContainsImages(parsed)) {
        throw new AdapterTurnError(
          "DeepSeek Web Instant and Expert are text-only; remove image inputs or select a vision-capable model",
          {
            status: 400,
            errorType: "invalid_request_error",
            code: "unsupported_input",
            retryable: false,
          },
        );
      }
    },
    async runTurn(parsed, incoming, emit) {
      try {
        if (incoming.abortSignal?.aborted) throw new DOMException("DeepSeek Web turn aborted", "AbortError");
        const route = requireDeepSeekWebModelRoute(parsed.modelId, provider.deepseekWeb?.enabled === true);
        const prompt = compileDeepSeekWebPrompt(parsed);
        const traceId = deepSeekTraceId(parsed, route.slug, prompt.text);
        const conversationKey = deepSeekConversationKey(parsed, route.slug);
        const continuationPrompt = conversationKey
          ? compileDeepSeekWebContinuationPrompt(parsed)
          : undefined;
        const continueFromTraceId = deepSeekToolContinuationTraceId(parsed);
        const followUpPrompt = continueFromTraceId
          ? compileDeepSeekWebFollowUpPrompt(parsed, continueFromTraceId)
          : undefined;
        const toolCapable = deepSeekEffectiveTools(parsed).length > 0;
        let output = "";
        let result = await worker.run({
          traceId,
          mode: route.adapterMode,
          prompt: prompt.text,
          ...(conversationKey ? { conversationKey } : {}),
          ...(continuationPrompt ? { continuationPrompt: continuationPrompt.text } : {}),
          ...(continueFromTraceId && followUpPrompt
            ? { continueFromTraceId, followUpPrompt: followUpPrompt.text }
            : {}),
          abortSignal: incoming.abortSignal,
          onHeartbeat: () => emit({ type: "heartbeat" }),
          onTextDelta: delta => {
            output += delta;
            // Buffer every DeepSeek completion until it has been classified.
            // This prevents both tool envelopes and promise-only narration from
            // leaking to the user before the adapter can recover them.
          },
        });
        // The worker returns the authoritative final Markdown. Deltas normally
        // equal it; keep accounting correct even if the renderer emitted none.
        output = result.markdown || output;
        let activeTraceId = traceId;
        let inputTokens = estimateTokens(result.inputText, route.slug);
        let outputTokens = estimateTokens(output, route.slug);
        let toolRequests = toolCapable
          ? parseDeepSeekToolRequests(result.rawText, parsed)
            ?? (result.rawText !== output ? parseDeepSeekToolRequests(output, parsed) : undefined)
          : undefined;

        let recoveryAttempts = 0;
        while (
          !toolRequests
          && deepSeekResponseNeedsToolRecovery(result.rawText || output)
          && recoveryAttempts < DEEPSEEK_MAX_NARRATION_RECOVERY_ATTEMPTS
        ) {
          const recoveryPrompt = deepSeekToolRecoveryPrompt(parsed);
          const previousTraceId = activeTraceId;
          const recoveryTraceId = deepSeekToolRecoveryTraceId(previousTraceId, result.rawText || output);
          output = "";
          result = await worker.run({
            traceId: recoveryTraceId,
            mode: route.adapterMode,
            prompt: prompt.text,
            ...(conversationKey ? { conversationKey } : {}),
            continueFromTraceId: previousTraceId,
            followUpPrompt: recoveryPrompt,
            abortSignal: incoming.abortSignal,
            onHeartbeat: () => emit({ type: "heartbeat" }),
            onTextDelta: delta => {
              output += delta;
            },
          });
          output = result.markdown || output;
          activeTraceId = recoveryTraceId;
          inputTokens += estimateTokens(result.inputText, route.slug);
          outputTokens += estimateTokens(output, route.slug);
          toolRequests = toolCapable
            ? parseDeepSeekToolRequests(result.rawText, parsed)
              ?? (result.rawText !== output ? parseDeepSeekToolRequests(output, parsed) : undefined)
            : undefined;
          recoveryAttempts++;
        }

        if (!toolRequests && deepSeekResponseNeedsToolRecovery(result.rawText || output)) {
          throw new Error(
            "DeepSeek Web repeatedly returned planning/progress narration instead of completing the task or requesting a Codex tool",
          );
        }

        const usage = {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          estimated: true,
        };
        if (toolRequests) {
          emitDeepSeekToolRequests(toolRequests, activeTraceId, usage, emit);
          return;
        }
        if (output) {
          emit({ type: "text_delta", text: output, phase: "final_answer" });
        }
        emit({
          type: "done",
          stopReason: "stop",
          endTurn: true,
          usage,
        } satisfies AdapterEvent);
      } catch (error) {
        throw classifiedDeepSeekError(error);
      }
    },
  };
}
