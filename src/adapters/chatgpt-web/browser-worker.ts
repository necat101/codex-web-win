import { existsSync, rmSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page, type Request } from "playwright-core";
import { atomicWriteFile, defaultChromeExecutable, expandUserPath, getConfigDir } from "../../config";
import type { CodexProviderConfig } from "../../types";
import { browserComposerTextMatches, normalizeBrowserComposerText } from "../composer-text";
import { parseDataUrl } from "../image";
import { ChatGptMarkdownStream } from "./markdown";
import { ChatGptBrowserEventStream, ChatGptStreamDiagnostics } from "./event-stream";
import { resolveChatGptWebModelMode, type ChatGptWebCapabilities, type ChatGptWebModelMode } from "./model";
import { CHATGPT_INTERNAL_COMPACTION_MARKER, containsChatGptCompactionMarker, stripChatGptTransportMarkers, type CompiledChatGptWebPrompt, type ChatGptWebPromptImage } from "./prompt";
import { estimateCompiledChatGptWebInputTokens } from "./usage";
import {
  assertAuthenticatedChatGptPage,
  assertTemporaryChatPage,
  chatGptReauthenticationMessage,
  CHATGPT_TEMPORARY_CHAT_URL,
  isGoogleAccountSignInUrl,
} from "../../chatgpt-session";
import { loginVerificationMarkerPath } from "../../browser-login";
import { childProcessEnvironment } from "../../process";

const workers = new Map<string, ChatGptBrowserWorker>();

// Browser-only turns retain a bounded inactivity budget. Tool-capable turns
// rely on explicit cancellation plus the specific DOM/operation watchdogs
// below and must not expire merely because a generic deadline elapsed.
export const DEFAULT_CHATGPT_TURN_TIMEOUT_MS = 2 * 60 * 60_000;
const MAX_CHATGPT_DELIVERY_TIMEOUT_RECOVERIES = 6;
// ChatGPT can remount its assistant turn while a long reasoning pass is still
// healthy. Thirty seconds proved too aggressive in production: a real 14m42s
// task was cancelled during one of these remounts. Keep inspecting the page,
// but only fail after a continuously observed, five-minute absence.
export const CHATGPT_RESPONSE_DOM_GRACE_MS = 5 * 60_000;
export const CHATGPT_RUNNING_WITHOUT_RESPONSE_GRACE_MS = 15 * 60_000;
export const CHATGPT_EMPTY_RESPONSE_GRACE_MS = 10_000;
export const CHATGPT_DOM_PROBE_GRACE_MS = 5 * 60_000;
export const CHATGPT_POST_TOOL_COMPLETION_GRACE_MS = 5_000;
export const CHATGPT_COMPLETION_OBSERVATION_GAP_MS = 10_000;
export const CHATGPT_WATCHDOG_OBSERVATION_GAP_MS = 30_000;
export const CHATGPT_MAX_SCHEDULER_GAP_EXTENSION_MS = 60 * 60_000;
export const CHATGPT_RESPONSE_POLL_MS = 1_250;
export const CHATGPT_TOOL_WAIT_POLL_MS = 15_000;
export const CHATGPT_UI_POLL_MS = 500;
export const CHATGPT_TRACE_POLL_MS = 4_000;
export const CHATGPT_RENDERER_TELEMETRY_MS = 15_000;
export const CHATGPT_RECOVERY_SIGNAL_POLL_MS = 2_500;
export const CHATGPT_CONSTRAINED_PARALLELISM = 4;
export const CHATGPT_ATTACHMENT_NETWORK_SETTLE_MS = 2_000;
export const CHATGPT_ATTACHMENT_FAILURE_GRACE_MS = 5_000;
export const CHATGPT_ATTACHMENT_INPUT_TIMEOUT_MS = 20_000;
export const CHATGPT_ATTACHMENT_UPLOAD_TIMEOUT_MS = 105_000;
export const CHATGPT_ATTACHMENT_STAGE_TIMEOUT_MS = (
  CHATGPT_ATTACHMENT_INPUT_TIMEOUT_MS + CHATGPT_ATTACHMENT_UPLOAD_TIMEOUT_MS + 10_000
);
const MAX_CHATGPT_TRACE_CANDIDATES = 48;
const CHATGPT_RENDERER_TELEMETRY_ENV = "CODEX_CHATGPT_WEB_RENDERER_TELEMETRY";

export interface ChatGptPollingProfile {
  constrained: boolean;
  responseMs: number;
  uiMs: number;
  traceMs: number;
  recoveryMs: number;
}

export function chatGptPollingProfile(parallelism = availableParallelism()): ChatGptPollingProfile {
  const constrained = parallelism <= CHATGPT_CONSTRAINED_PARALLELISM;
  return constrained
    ? {
        constrained: true,
        responseMs: 1_800,
        uiMs: 750,
        traceMs: 6_000,
        recoveryMs: 4_000,
      }
    : {
        constrained: false,
        responseMs: CHATGPT_RESPONSE_POLL_MS,
        uiMs: CHATGPT_UI_POLL_MS,
        traceMs: CHATGPT_TRACE_POLL_MS,
        recoveryMs: CHATGPT_RECOVERY_SIGNAL_POLL_MS,
      };
}

const activeParallelism = availableParallelism();
const activePollingProfile = chatGptPollingProfile(activeParallelism);

export const CHATGPT_LOW_POWER_STYLE = `
html { scroll-behavior: auto !important; }
*, *::before, *::after {
  animation-duration: 0.001ms !important;
  animation-delay: 0ms !important;
  animation-iteration-count: 1 !important;
  transition-duration: 0.001ms !important;
  transition-delay: 0ms !important;
}
`;

/**
 * Keep Playwright's background-liveness defaults intact. ChatGPT's web client
 * owns browser-side timers and streaming state that must continue running while
 * a long Codex Native tool call leaves the controlled window occluded. Re-
 * enabling Chromium background throttling here caused long laptop turns to lose
 * that liveness even though the local turn and tunnel deadlines were disabled.
 *
 * Resource savings belong in the polling profile below, not in Chromium's
 * renderer/timer scheduler. Keep this explicit empty list as a regression pin.
 */
export const CHATGPT_IGNORED_DEFAULT_ARGS = [] as const;

// Attachment thumbnails and status icons are part of ChatGPT's upload state.
// Keep image loading enabled so the composer can finish mounting those chips.
export const CHATGPT_LOW_RESOURCE_LAUNCH_ARGS = [] as const;

const browserStageTimeouts = {
  browserPage: 60_000,
  navigation: 70_000,
  pageStyle: 20_000,
  composerReady: 40_000,
  sessionVerification: 40_000,
  effortSelection: 120_000,
  personalizationSelection: 30_000,
  promptAttachment: 60_000,
  fileAttachment: CHATGPT_ATTACHMENT_STAGE_TIMEOUT_MS,
  send: 40_000,
} as const;

export interface BrowserTurn {
  traceId: string;
  modelId: string;
  reasoning?: string;
  capabilities: ChatGptWebCapabilities;
  prepare: () => Promise<CompiledChatGptWebPrompt & { release: () => void }>;
  abortSignal?: AbortSignal;
  onHeartbeat?: () => void;
  /** Visible ChatGPT reasoning-summary step titles only; never hidden chain-of-thought. */
  onReasoningSummary?: (text: string, continuation?: boolean) => void;
  hasBoundTurn?: () => boolean;
  /** Stable visible ChatGPT prose between status/tool rows. */
  onCommentary?: (text: string, continuation?: boolean) => void;
  /** Append-only, structurally stable Markdown chunks. */
  onTextDelta: (delta: string) => void;
  /** Exact number of Codex Native invocations currently waiting for local results. */
  pendingToolCount?: () => number;
  /**
   * Event-driven wakeup for local tool activity. This lets constrained machines
   * sleep for a long fallback interval without adding equivalent tool latency.
   */
  waitForPendingToolCountChange?: (previousCount: number, timeoutMs: number) => Promise<number>;
}

export type ChatGptTemporaryChatPersonalizationState = "personalized" | "unpersonalized" | "unknown";

export function chatGptTemporaryChatPersonalizationState(
  values: Iterable<string | null | undefined>,
): ChatGptTemporaryChatPersonalizationState {
  for (const value of values) {
    const normalized = (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    if (/^unpersonalized(?:\b|$)/.test(normalized)) return "unpersonalized";
    if (/^personalized(?:\b|$)/.test(normalized)) return "personalized";
  }
  return "unknown";
}

interface ResolvedBrowserConfig {
  appName: string;
  storageStatePath: string;
  chromeExecutablePath: string;
  turnTimeoutMs: number;
  headed: boolean;
  autoApproveToolCalls: boolean;
}

export function chatGptTurnIsComplete(state: {
  responsePresent: boolean;
  running: boolean;
  currentText: string;
  completionActionPresent: boolean;
}): boolean {
  return state.responsePresent
    && !state.running
    && state.currentText.length > 0
    && state.completionActionPresent;
}

export class ChatGptCompletionTracker {
  private candidate?: { signature: string; since: number };
  private lastObservedAt?: number;

  constructor(
    private readonly stableMs = 750,
    private readonly maxObservationGapMs = CHATGPT_COMPLETION_OBSERVATION_GAP_MS,
  ) {}

  reset(): void {
    this.candidate = undefined;
    this.lastObservedAt = undefined;
  }

  update(state: Parameters<typeof chatGptTurnIsComplete>[0], now = Date.now()): boolean {
    // Stability means continuously observed stability. A pending tool, an
    // event-loop stall, or Windows sleep must not age one stale pre-pause DOM
    // sample into an instantly accepted final answer.
    if (this.lastObservedAt !== undefined
      && (now < this.lastObservedAt || now - this.lastObservedAt >= this.maxObservationGapMs)) {
      this.candidate = undefined;
    }
    this.lastObservedAt = now;
    if (!chatGptTurnIsComplete(state)) {
      this.candidate = undefined;
      return false;
    }
    const signature = state.currentText;
    if (this.candidate?.signature !== signature) {
      this.candidate = { signature, since: now };
      return false;
    }
    return now - this.candidate.since >= this.stableMs;
  }
}

export class ChatGptTurnDomHealthTracker {
  private sawResponse = false;
  private missingResponseSince?: number;
  private runningWithoutResponseSince?: number;
  private emptyCompletionSince?: number;
  private probeFailureSince?: number;
  private lastObservedAt?: number;

  constructor(
    private readonly missingResponseMs = CHATGPT_RESPONSE_DOM_GRACE_MS,
    private readonly emptyCompletionMs = CHATGPT_EMPTY_RESPONSE_GRACE_MS,
    /**
     * Connector/tool turns may legitimately execute for a long time before
     * ChatGPT creates its first assistant conversation-turn DOM node.
     *
     * This relaxes ONLY the initial-absence check. Once a response DOM has
     * appeared, losing it still uses the normal missingResponseMs watchdog.
     */
    private readonly allowInitialMissingResponse = false,
    private readonly probeFailureMs = CHATGPT_DOM_PROBE_GRACE_MS,
    private readonly maxObservationGapMs = CHATGPT_WATCHDOG_OBSERVATION_GAP_MS,
    private readonly runningWithoutResponseMs = CHATGPT_RUNNING_WITHOUT_RESPONSE_GRACE_MS,
  ) {}

  update(state: {
    responsePresent: boolean;
    running: boolean;
    currentText: string;
    completionActionPresent: boolean;
    probeSucceeded?: boolean;
  }, now = Date.now()): string | undefined {
    // A watchdog deadline is valid only while failed observations are
    // continuous. Pending tools, renderer stalls, and sleep/resume all create
    // legitimate gaps between browser samples.
    if (this.lastObservedAt !== undefined
      && (now < this.lastObservedAt || now - this.lastObservedAt >= this.maxObservationGapMs)) {
      this.missingResponseSince = undefined;
      this.runningWithoutResponseSince = undefined;
      this.emptyCompletionSince = undefined;
      this.probeFailureSince = undefined;
    }
    this.lastObservedAt = now;

    if (state.probeSucceeded === false) {
      this.probeFailureSince ??= now;
      if (now - this.probeFailureSince >= this.probeFailureMs) {
        return "ChatGPT browser response could not be inspected continuously";
      }
      return undefined;
    }
    this.probeFailureSince = undefined;

    if (state.responsePresent) {
      this.sawResponse = true;
      this.missingResponseSince = undefined;
      this.runningWithoutResponseSince = undefined;
    } else if (state.running) {
      // A visible Stop/Answer-now/current streaming control is stronger
      // liveness evidence than the transient absence of one assistant root,
      // but an unchanged stale control must not suppress every watchdog
      // forever. Tool turns may legitimately run before creating their first
      // assistant root; their outer inactivity budget remains the bound.
      this.missingResponseSince = undefined;
      if (this.allowInitialMissingResponse && !this.sawResponse) {
        this.runningWithoutResponseSince = undefined;
      } else {
        this.runningWithoutResponseSince ??= now;
        if (now - this.runningWithoutResponseSince >= this.runningWithoutResponseMs) {
          return "ChatGPT remained active without a response DOM beyond the recovery window";
        }
      }
    } else if (!this.allowInitialMissingResponse || this.sawResponse) {
      this.runningWithoutResponseSince = undefined;
      this.missingResponseSince ??= now;
      if (now - this.missingResponseSince >= this.missingResponseMs) {
        return this.sawResponse
          ? "ChatGPT response DOM disappeared while the browser turn was active"
          : "ChatGPT did not create a response DOM after the message was sent";
      }
    } else {
      // A tool-capable ChatGPT turn can remain in a page-level "Thinking"
      // state while Codex Native executes commands before the first assistant
      // conversation-turn node exists. Do not turn that valid pre-response
      // phase into a false DOM-health failure.
      this.missingResponseSince = undefined;
      this.runningWithoutResponseSince = undefined;
    }

    const emptyCompletion = state.responsePresent
      && !state.running
      && state.currentText.length === 0
      && state.completionActionPresent;
    if (!emptyCompletion) {
      this.emptyCompletionSince = undefined;
    } else {
      this.emptyCompletionSince ??= now;
      if (now - this.emptyCompletionSince >= this.emptyCompletionMs) {
        return "ChatGPT browser turn completed without a final answer";
      }
    }
    return undefined;
  }
}

export interface ChatGptVisibleTraceBlock {
  kind: "markdown" | "status";
  text: string;
}

export interface ChatGptVisibleTraceEvent {
  kind: "reasoning" | "commentary";
  text: string;
  continuation?: boolean;
}

interface ChatGptResponseDomSnapshot {
  probeSucceeded: boolean;
  responsePresent: boolean;
  running: boolean;
  deliveryTimeoutPresent: boolean;
  toolConfirmationPresent: boolean;
  completionSignature: string;
  visibleText: string;
  visibleTextLength: number;
  completionActionPresent: boolean;
  traceBlocks: ChatGptVisibleTraceBlock[];
}

const absentResponseDomSnapshot = (probeSucceeded = true): ChatGptResponseDomSnapshot => ({
  probeSucceeded,
  responsePresent: false,
  running: false,
  deliveryTimeoutPresent: false,
  toolConfirmationPresent: false,
  completionSignature: "",
  visibleText: "",
  visibleTextLength: 0,
  completionActionPresent: false,
  traceBlocks: [],
});

interface ChatGptRendererTelemetryPoint {
  atMs: number;
  taskDurationSeconds: number;
  scriptDurationSeconds: number;
  layoutDurationSeconds: number;
}

function metricValue(metrics: Array<{ name: string; value: number }>, name: string): number {
  return metrics.find(metric => metric.name === name)?.value ?? 0;
}

function percentageDelta(current: number, previous: number, elapsedSeconds: number): string {
  if (elapsedSeconds <= 0) return "n/a";
  return (Math.max(0, current - previous) / elapsedSeconds * 100).toFixed(1);
}

/**
 * Low-frequency CDP telemetry used only while ChatGPT is blocked on real local
 * tool calls. It intentionally measures the renderer instead of the Node host:
 * TaskDuration catches main-thread burn while heap/DOM counters expose the
 * long-session growth that tends to make each DOM probe more expensive.
 */
class ChatGptRendererTelemetry {
  private session?: CDPSession;
  private previous?: ChatGptRendererTelemetryPoint;
  private nextSampleAt = 0;
  private disabled = false;

  constructor(private readonly page: Page, private readonly traceId: string) {}

  async sample(phase: "tool-wait-start" | "tool-wait" | "tool-wait-end", pendingTools: number, force = false): Promise<void> {
    if (this.disabled) return;
    const now = Date.now();
    if (!force && now < this.nextSampleAt) return;
    this.nextSampleAt = now + CHATGPT_RENDERER_TELEMETRY_MS;
    try {
      if (!this.session) {
        this.session = await this.page.context().newCDPSession(this.page);
        await this.session.send("Performance.enable");
      }
      const [performanceMetrics, domCounters] = await Promise.all([
        this.session.send("Performance.getMetrics") as Promise<{ metrics: Array<{ name: string; value: number }> }>,
        this.session.send("Memory.getDOMCounters") as Promise<{ documents: number; nodes: number; jsEventListeners: number }>,
      ]);
      const point: ChatGptRendererTelemetryPoint = {
        atMs: now,
        taskDurationSeconds: metricValue(performanceMetrics.metrics, "TaskDuration"),
        scriptDurationSeconds: metricValue(performanceMetrics.metrics, "ScriptDuration"),
        layoutDurationSeconds: metricValue(performanceMetrics.metrics, "LayoutDuration"),
      };
      const previous = this.previous;
      const elapsedSeconds = previous ? Math.max(0.001, (point.atMs - previous.atMs) / 1_000) : 0;
      const mainThreadCpuPct = previous
        ? percentageDelta(point.taskDurationSeconds, previous.taskDurationSeconds, elapsedSeconds)
        : "n/a";
      const scriptCpuPct = previous
        ? percentageDelta(point.scriptDurationSeconds, previous.scriptDurationSeconds, elapsedSeconds)
        : "n/a";
      const layoutCpuPct = previous
        ? percentageDelta(point.layoutDurationSeconds, previous.layoutDurationSeconds, elapsedSeconds)
        : "n/a";
      const jsHeapUsedMiB = metricValue(performanceMetrics.metrics, "JSHeapUsedSize") / 1_048_576;
      const jsHeapTotalMiB = metricValue(performanceMetrics.metrics, "JSHeapTotalSize") / 1_048_576;
      console.info(
        `[chatgpt-web] browser turn ${this.traceId} renderer telemetry phase=${phase} pendingTools=${pendingTools}`
        + ` mainThreadCpuPct=${mainThreadCpuPct} scriptCpuPct=${scriptCpuPct} layoutCpuPct=${layoutCpuPct}`
        + ` jsHeapMiB=${jsHeapUsedMiB.toFixed(1)}/${jsHeapTotalMiB.toFixed(1)}`
        + ` documents=${domCounters.documents} nodes=${domCounters.nodes} listeners=${domCounters.jsEventListeners}`,
      );
      this.previous = point;
    } catch (error) {
      this.disabled = true;
      console.warn(
        `[chatgpt-web] browser turn ${this.traceId} renderer telemetry unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async close(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    if (session) await session.detach().catch(() => {});
  }
}

export function chatGptResponsePollInterval(
  pendingToolCount: number,
  responsePollMs = CHATGPT_RESPONSE_POLL_MS,
): number {
  return pendingToolCount > 0 ? CHATGPT_TOOL_WAIT_POLL_MS : responsePollMs;
}

/**
 * Give a suspended or heavily starved process back a bounded amount of its
 * inactivity budget. A renderer that returns one failed probe every 30 seconds
 * must still reach a terminal watchdog instead of renewing itself forever.
 */
export function chatGptSchedulerGapExtension(gapMs: number, remainingMs: number): number {
  if (!Number.isFinite(gapMs)
    || gapMs < CHATGPT_WATCHDOG_OBSERVATION_GAP_MS
    || !Number.isFinite(remainingMs)
    || remainingMs <= 0) {
    return 0;
  }
  return Math.min(gapMs, remainingMs);
}

/** A generic inactivity deadline applies only to browser-only ChatGPT turns. */
export function chatGptTurnInactivityExpired(
  localTools: boolean,
  now: number,
  deadline: number,
): boolean {
  return !localTools && now >= deadline;
}

export function chatGptRendererTelemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[CHATGPT_RENDERER_TELEMETRY_ENV]?.trim() === "1";
}

/** Convert the public ChatGPT turn DOM into append-only Codex reasoning summaries. */
export class ChatGptVisibleTraceTracker {
  private readonly seen = new Set<string>();
  private readonly emittedCommentary = new Map<number, string>();
  private readonly commentaryChangedAt = new Map<number, number>();

  constructor(private readonly commentaryStabilityMs = 1_000) {}

  observe(
    blocks: ChatGptVisibleTraceBlock[],
    completionActionPresent: boolean,
    now = Date.now(),
    pendingToolCount = 0,
  ): ChatGptVisibleTraceEvent[] {
    let lastMarkdown = -1;
    for (let index = 0; index < blocks.length; index++) {
      if (blocks[index]!.kind === "markdown") lastMarkdown = index;
    }
    const output: ChatGptVisibleTraceEvent[] = [];
    for (let index = 0; index < blocks.length; index++) {
      const block = blocks[index]!;
      if (containsChatGptCompactionMarker(block.text)
        && !this.seen.has(CHATGPT_INTERNAL_COMPACTION_MARKER)) {
        this.seen.add(CHATGPT_INTERNAL_COMPACTION_MARKER);
        output.push({ kind: "reasoning", text: "Context automatically compacted" });
      }
      const text = stripChatGptTransportMarkers(block.text)
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map(line => line.replace(/[\t ]+/g, " ").trim())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      if (!text) continue;
      // The trailing Markdown root is ambiguous while running and becomes the final answer once
      // complete. It stays owned by ChatGptMarkdownStream; earlier roots are stable commentary.
      if (pendingToolCount === 0
        && block.kind === "markdown"
        && (completionActionPresent ? index === lastMarkdown : index === blocks.length - 1)) {
        continue;
      }
      if (block.kind === "markdown") {
        const previous = this.emittedCommentary.get(index);
        if (previous === text) {
          const changedAt = this.commentaryChangedAt.get(index) ?? now;
          if (now - changedAt < this.commentaryStabilityMs) break;
          continue;
        }
        this.commentaryChangedAt.set(index, now);
        if (previous && text.startsWith(previous)) {
          this.emittedCommentary.set(index, text);
          output.push({ kind: "commentary", text: text.slice(previous.length), continuation: true });
          break;
        }
        this.emittedCommentary.set(index, text);
      }
      const key = `${block.kind}\0${text}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      output.push({ kind: block.kind === "markdown" ? "commentary" : "reasoning", text });
      if (block.kind === "markdown") break;
    }
    return output;
  }
}

export function chatGptEffortLabelsMatch(current: string, desired: string): boolean {
  const normalize = (value: string) => {
    const label = value.replace(/\s+/g, " ").trim();
    return /^Instant(?:\s+5\.\d+)?$/.test(label) ? "Instant" : label;
  };
  return normalize(current) === normalize(desired);
}

export function isChatGptTraceControl(block: ChatGptVisibleTraceBlock): boolean {
  return block.kind === "status" && block.text.replace(/\s+/g, " ").trim() === "Answer now";
}

export function redactChatGptUiDiagnostic(value: string): string {
  return value
    .replace(/<codex_context_json>[\s\S]*?<\/codex_context_json>/gi, "<codex_context_json>[redacted]</codex_context_json>")
    .replace(/\b(turn|binding|call)_[A-Za-z0-9_-]{12,}\b/g, "$1_[redacted]");
}

interface ChatGptConnectorSelectionCandidate {
  names: string[];
  visible: boolean;
  hasArea: boolean;
  knownPill: boolean;
}

interface ChatGptConnectorSuggestionCandidate {
  names: string[];
  visible: boolean;
  containsComposer: boolean;
  insideComposer: boolean;
  excludedRegion: boolean;
  suggestionRole: boolean;
  markedSuggestion: boolean;
  inPopup: boolean;
  nearComposer: boolean;
  actionable: boolean;
}

interface ChatGptSubmissionState {
  initialUserTurns: number;
  initialAssistantTurns: number;
  userTurns: number;
  assistantTurns: number;
  running: boolean;
  promptCleared: boolean;
}

function normalizedConnectorName(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/^@\s*/, "");
}

function connectorNameMatches(value: string, appName: string): boolean {
  return normalizedConnectorName(value) === normalizedConnectorName(appName);
}

/**
 * ChatGPT's current connector pill puts its one-letter app icon in the same
 * rendered text as the connector name (for example, `C Codex Native`).  DOM
 * probes add the icon-free text as a second candidate; keep matching exact
 * here so an arbitrary phrase such as `Open Codex Native` can never become a
 * selected connector merely by sharing a suffix.
 */
function connectorCandidateNames(element: HTMLElement): string[] {
  const clone = element.cloneNode(true) as HTMLElement;
  clone.querySelectorAll<HTMLElement>([
    "[data-testid*='icon']",
    '[aria-hidden="true"]',
    "svg",
    "img",
  ].join(", ")).forEach(icon => icon.remove());
  return [
    element.getAttribute("aria-label") ?? "",
    element.getAttribute("title") ?? "",
    element.innerText ?? "",
    element.textContent ?? "",
    clone.innerText ?? "",
    clone.textContent ?? "",
  ].filter(Boolean);
}

/** Pure DOM contract used by connector pill detection and its regression tests. */
export function chatGptConnectorSelectionMatches(
  candidate: ChatGptConnectorSelectionCandidate,
  appName: string,
): boolean {
  if (!candidate.visible || (!candidate.hasArea && !candidate.knownPill)) return false;
  return candidate.names.some(name => connectorNameMatches(name, appName));
}

/**
 * A suggestion must be an actionable row in the currently visible composer
 * popup. Matching text elsewhere in the page is deliberately insufficient.
 */
export function chatGptConnectorSuggestionIsUsable(
  candidate: ChatGptConnectorSuggestionCandidate,
  appName: string,
  accessibleNameMatched = false,
): boolean {
  if (!candidate.visible
    || candidate.containsComposer
    || candidate.insideComposer
    || candidate.excludedRegion
    || !candidate.inPopup
    || !candidate.nearComposer
    || !candidate.actionable
    || (!candidate.suggestionRole && !candidate.markedSuggestion)) {
    return false;
  }
  return accessibleNameMatched || candidate.names.some(name => connectorNameMatches(name, appName));
}

/** A click is not a submission until ChatGPT exposes concrete UI progress. */
export function chatGptSubmissionWasObserved(state: ChatGptSubmissionState): boolean {
  return state.promptCleared
    || state.userTurns > state.initialUserTurns
    || state.assistantTurns > state.initialAssistantTurns
    || state.running;
}

function resolveBrowserConfig(provider: CodexProviderConfig): ResolvedBrowserConfig {
  const configured = provider.chatgptWeb ?? {};
  return {
    appName: configured.appName?.trim() || "Codex Native",
    storageStatePath: resolve(expandUserPath(configured.storageStatePath?.trim() || join(getConfigDir(), "browser", "storage-state.json"))),
    chromeExecutablePath: resolve(expandUserPath(configured.chromeExecutablePath?.trim() || defaultChromeExecutable())),
    turnTimeoutMs: configured.turnTimeoutMs ?? DEFAULT_CHATGPT_TURN_TIMEOUT_MS,
    headed: configured.headed !== false,
    autoApproveToolCalls: configured.autoApproveToolCalls === true,
  };
}

const imageExtensions = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
]);

export function chatGptImageFilePayloads(images: ChatGptWebPromptImage[]): Array<{ name: string; mimeType: string; buffer: Buffer }> {
  if (images.length > 10) throw new Error("ChatGPT web accepts at most 10 input images per Codex turn");
  let totalBytes = 0;
  return images.map(image => {
    const parsed = parseDataUrl(image.imageUrl);
    if (!parsed) throw new Error(`ChatGPT web input image ${image.ref} must be an inline base64 data URL`);
    const extension = imageExtensions.get(parsed.mediaType.toLowerCase());
    if (!extension) throw new Error(`ChatGPT web input image ${image.ref} has unsupported media type: ${parsed.mediaType}`);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(parsed.base64) || parsed.base64.length % 4 !== 0) {
      throw new Error(`ChatGPT web input image ${image.ref} contains invalid base64 data`);
    }
    const buffer = Buffer.from(parsed.base64, "base64");
    if (buffer.length === 0) throw new Error(`ChatGPT web input image ${image.ref} is empty`);
    if (buffer.length > 20_000_000) throw new Error(`ChatGPT web input image ${image.ref} exceeds 20 MB`);
    totalBytes += buffer.length;
    if (totalBytes > 50_000_000) throw new Error("ChatGPT web input images exceed the 50 MB per-turn limit");
    return { name: `${image.ref}.${extension}`, mimeType: parsed.mediaType.toLowerCase(), buffer };
  });
}

export function chatGptPromptFilePayloads(
  prompt: CompiledChatGptWebPrompt,
): Array<{ name: string; mimeType: string; buffer: Buffer }> {
  return chatGptImageFilePayloads(prompt.images);
}

export const CHATGPT_ATTACHMENT_REMOVE_CONTROL_SELECTOR = [
  'button[aria-label^="Remove file" i]',
  'button[aria-label^="Remove image" i]',
  'button[aria-label^="Remove attachment" i]',
  'button[aria-label*="remove" i][aria-label*="file" i]',
  'button[aria-label*="remove" i][aria-label*="image" i]',
  'button[aria-label*="remove" i][aria-label*="attachment" i]',
  'button[data-testid*="remove-file" i]',
  'button[data-testid*="remove-image" i]',
  'button[data-testid*="remove-attachment" i]',
  '[role="button"][data-testid*="remove-file" i]',
  '[role="button"][data-testid*="remove-image" i]',
  '[role="button"][data-testid*="remove-attachment" i]',
].join(", ");

const CHATGPT_ATTACHMENT_CARD_SELECTOR = [
  '[data-testid*="attachment-chip" i]',
  '[data-testid*="file-chip" i]',
  '[data-testid*="image-chip" i]',
  '[data-testid*="attachment-preview" i]',
  '[data-testid*="file-preview" i]',
  '[data-testid*="image-preview" i]',
  '[data-upload-state]',
  '[data-file-state]',
].join(", ");

const CHATGPT_ATTACHMENT_PENDING_SELECTOR = [
  '[aria-busy="true"]',
  '[role="progressbar"]',
  '[data-loading="true"]',
  '[data-state="loading" i]',
  '[data-state="pending" i]',
  '[data-state="processing" i]',
  '[data-state="uploading" i]',
  '[data-upload-state="loading" i]',
  '[data-upload-state="pending" i]',
  '[data-upload-state="processing" i]',
  '[data-upload-state="uploading" i]',
  '[data-file-state="loading" i]',
  '[data-file-state="pending" i]',
  '[data-file-state="processing" i]',
  '[data-file-state="uploading" i]',
  '[data-testid*="progress" i]',
  '[data-testid*="loading" i]',
  '[aria-label*="uploading" i]',
  '[aria-label*="processing" i]',
  '.animate-spin',
].join(", ");

const CHATGPT_ATTACHMENT_UPLOADED_SELECTOR = [
  '[data-state="uploaded" i]',
  '[data-state="complete" i]',
  '[data-state="completed" i]',
  '[data-state="success" i]',
  '[data-state="ready" i]',
  '[data-upload-state="uploaded" i]',
  '[data-upload-state="complete" i]',
  '[data-upload-state="completed" i]',
  '[data-upload-state="success" i]',
  '[data-upload-state="ready" i]',
  '[data-file-state="uploaded" i]',
  '[data-file-state="complete" i]',
  '[data-file-state="completed" i]',
  '[data-file-state="success" i]',
  '[data-file-state="ready" i]',
  '[data-testid*="upload-complete" i]',
  '[data-testid*="upload-success" i]',
  '[aria-label*="upload complete" i]',
  '[aria-label*="uploaded" i]',
].join(", ");

const CHATGPT_ATTACHMENT_STATUS_SELECTOR = [
  '[role="status"]',
  '[role="progressbar"]',
  '[aria-live]',
  '[data-testid*="status" i]',
].join(", ");

export interface ChatGptAttachmentStatusTextNode {
  text: string;
  role: string | null;
  ariaLive: string | null;
  testId: string | null;
}

/** Only explicit attachment status/progress nodes may turn prose into upload state. */
export function chatGptAttachmentStatusTextKind(
  node: ChatGptAttachmentStatusTextNode,
): "pending" | "uploaded" | undefined {
  const role = node.role?.trim().toLowerCase();
  const testId = node.testId?.trim().toLowerCase() ?? "";
  const explicitStatusNode = role === "status"
    || role === "progressbar"
    || node.ariaLive !== null
    || testId.includes("status");
  if (!explicitStatusNode) return undefined;
  if (/\b(?:uploading|processing|attaching|pending)\b/i.test(node.text)) return "pending";
  if (/\b(?:uploaded|upload complete|complete|completed|ready)\b/i.test(node.text)) return "uploaded";
  return undefined;
}

export interface ChatGptAttachmentReadinessObservation {
  attachedCount: number;
  expectedCount: number;
  sendEnabled: boolean;
  pendingUi: boolean;
  uploadedUiCount: number;
  uploadRequestsSeen: number;
  uploadRequestsPending: number;
  uploadRequestsFailed: number;
  successfulUploads: number;
  uploadActivitySequence: number;
}

/**
 * Require attachment readiness to remain stable after the last upload event.
 *
 * ChatGPT enables Send as soon as prompt text exists, before an image upload is
 * necessarily complete. The attachment card's Remove button also appears when
 * an upload is merely queued. Neither signal is sufficient on its own.
 */
export class ChatGptAttachmentReadinessTracker {
  private stableSince?: number;
  private lastUploadActivitySequence = -1;

  update(observation: ChatGptAttachmentReadinessObservation, at = Date.now()): boolean {
    if (observation.uploadActivitySequence !== this.lastUploadActivitySequence) {
      this.lastUploadActivitySequence = observation.uploadActivitySequence;
      this.stableSince = undefined;
    }
    const uploadProven = observation.successfulUploads >= observation.expectedCount
      || observation.uploadedUiCount >= observation.expectedCount;
    const eligible = observation.attachedCount >= observation.expectedCount
      && observation.sendEnabled
      && !observation.pendingUi
      && observation.uploadRequestsPending === 0
      && observation.uploadRequestsFailed === 0
      && uploadProven;
    if (!eligible) {
      this.stableSince = undefined;
      return false;
    }
    this.stableSince ??= at;
    return at - this.stableSince >= CHATGPT_ATTACHMENT_NETWORK_SETTLE_MS;
  }
}

/** Keep upload tracking narrow enough that unrelated ChatGPT telemetry cannot hold the composer. */
export function chatGptRequestLooksLikeAttachmentUpload(method: string, url: string): boolean {
  const normalizedMethod = method.trim().toUpperCase();
  if (normalizedMethod !== "POST" && normalizedMethod !== "PUT" && normalizedMethod !== "PATCH") return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const target = `${parsed.hostname}${parsed.pathname}`.toLowerCase();
  return /(?:^|[./_-])(?:files?|uploads?|attachments?)(?:[./_-]|$)/.test(target)
    || (normalizedMethod === "PUT" && (
      parsed.hostname.toLowerCase().endsWith(".blob.core.windows.net")
      || parsed.hostname.toLowerCase().includes("usercontent")
      || parsed.hostname.toLowerCase().endsWith(".amazonaws.com")
  ));
}

export type ChatGptAttachmentUploadProofKind = "transfer" | "finalize";

/** Identify successful requests that prove bytes were transferred or the file was finalized. */
export function chatGptAttachmentUploadProofKind(
  method: string,
  url: string,
): ChatGptAttachmentUploadProofKind | undefined {
  if (!chatGptRequestLooksLikeAttachmentUpload(method, url)) return undefined;
  const normalizedMethod = method.trim().toUpperCase();
  let pathname: string;
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    return undefined;
  }
  if (/(?:^|[./_-])(?:uploaded|completed?|finali[sz](?:e|ed))(?:[./_-]|$)/.test(pathname)) {
    return "finalize";
  }
  return normalizedMethod === "PUT" ? "transfer" : undefined;
}

export class ChatGptAttachmentNetworkTracker {
  private readonly pending = new Map<Request, string>();
  private readonly failed = new Set<string>();
  private readonly transferred = new Set<string>();
  private readonly finalized = new Set<string>();
  private seen = 0;
  private activitySequence = 0;
  private lastActivityAt = Date.now();
  private requestKey(request: Request): string {
    const parsed = new URL(request.url());
    return `${request.method().toUpperCase()}:${parsed.hostname.toLowerCase()}${parsed.pathname.toLowerCase()}`;
  }
  private recordActivity(): void {
    this.activitySequence += 1;
    this.lastActivityAt = Date.now();
  }
  private readonly onRequest = (request: Request) => {
    if (!chatGptRequestLooksLikeAttachmentUpload(request.method(), request.url())) return;
    const key = this.requestKey(request);
    this.failed.delete(key);
    this.transferred.delete(key);
    this.finalized.delete(key);
    this.pending.set(request, key);
    this.seen += 1;
    this.recordActivity();
  };
  private readonly onRequestFinished = async (request: Request) => {
    const key = this.pending.get(request);
    if (!key) return;
    const response = await request.response().catch(() => null);
    this.pending.delete(request);
    if (!response || !response.ok()) {
      this.failed.add(key);
    } else {
      this.failed.delete(key);
      const proof = chatGptAttachmentUploadProofKind(request.method(), request.url());
      if (proof === "transfer") this.transferred.add(key);
      if (proof === "finalize") this.finalized.add(key);
    }
    this.recordActivity();
  };
  private readonly onRequestFailed = (request: Request) => {
    const key = this.pending.get(request);
    if (!key) return;
    this.pending.delete(request);
    this.failed.add(key);
    this.recordActivity();
  };

  constructor(private readonly page: Page) {
    page.on("request", this.onRequest);
    page.on("requestfinished", this.onRequestFinished);
    page.on("requestfailed", this.onRequestFailed);
  }

  snapshot(): {
    seen: number;
    pending: number;
    activitySequence: number;
    failed: number;
    successfulUploads: number;
    lastActivityAt: number;
  } {
    return {
      seen: this.seen,
      pending: this.pending.size,
      activitySequence: this.activitySequence,
      failed: this.failed.size,
      // ChatGPT normally performs both a storage PUT and a later finalize POST
      // for one image. Take the stronger population instead of double-counting
      // those two requests as two uploaded images.
      successfulUploads: Math.max(this.transferred.size, this.finalized.size),
      lastActivityAt: this.lastActivityAt,
    };
  }

  stop(): void {
    this.page.off("request", this.onRequest);
    this.page.off("requestfinished", this.onRequestFinished);
    this.page.off("requestfailed", this.onRequestFailed);
  }
}

class ChatGptSharedBrowser {
  private browser?: Browser;
  private launchPromise?: Promise<Browser>;

  constructor(private readonly config: ResolvedBrowserConfig) {}

  async get(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (this.launchPromise) return this.launchPromise;
    const launch = chromium.launch({
      executablePath: this.config.chromeExecutablePath,
      headless: !this.config.headed,
      env: childProcessEnvironment(),
      ignoreDefaultArgs: [...CHATGPT_IGNORED_DEFAULT_ARGS],
      args: [...CHATGPT_LOW_RESOURCE_LAUNCH_ARGS],
    });
    this.launchPromise = launch;
    try {
      const browser = await launch;
      this.browser = browser;
      browser.on("disconnected", () => {
        if (this.browser === browser) this.browser = undefined;
      });
      return browser;
    } finally {
      if (this.launchPromise === launch) this.launchPromise = undefined;
    }
  }

  discard(browser: Browser): void {
    if (this.browser !== browser) return;
    this.browser = undefined;
    void browser.close().catch(() => {});
  }

  async close(): Promise<void> {
    const launch = this.launchPromise;
    this.launchPromise = undefined;
    const launched = launch ? await launch.catch(() => undefined) : undefined;
    const browser = this.browser ?? launched;
    this.browser = undefined;
    if (browser) await browser.close().catch(() => {});
  }
}

const sharedBrowsers = new Map<string, ChatGptSharedBrowser>();

function sharedBrowserForConfig(config: ResolvedBrowserConfig): ChatGptSharedBrowser {
  const key = JSON.stringify({
    chromeExecutablePath: config.chromeExecutablePath,
    headed: config.headed,
  });
  let shared = sharedBrowsers.get(key);
  if (!shared) {
    shared = new ChatGptSharedBrowser(config);
    sharedBrowsers.set(key, shared);
  }
  return shared;
}

export class ChatGptBrowserWorker {
  static forProvider(provider: CodexProviderConfig): ChatGptBrowserWorker {
    const config = resolveBrowserConfig(provider);
    // Compaction is routed with localToolsEnabled=false. It must not share the
    // serialized BrowserWorker tail owned by a long-lived local-tool turn:
    // Codex may wait for compaction while that interactive browser turn is
    // itself waiting for Codex, producing a circular wait.
    const lane = provider.chatgptWeb?.localToolsEnabled === false
      ? "read-only"
      : "interactive";
    const key = JSON.stringify({ lane, config });
    let worker = workers.get(key);
    if (!worker) {
      worker = new ChatGptBrowserWorker(config, sharedBrowserForConfig(config));
      workers.set(key, worker);
      console.info(
        `[chatgpt-web] browser worker created lane=${lane}`
        + ` parallelism=${activeParallelism}`
        + ` constrained=${activePollingProfile.constrained}`
        + ` responsePollMs=${activePollingProfile.responseMs}`
        + ` tracePollMs=${activePollingProfile.traceMs}`,
      );
    }
    return worker;
  }

  private context?: BrowserContext;
  private page?: Page;
  private tail: Promise<void> = Promise.resolve();
  private lastStorageStateJson?: string;

  private constructor(
    private readonly config: ResolvedBrowserConfig,
    private readonly sharedBrowser: ChatGptSharedBrowser,
  ) {}

  run(turn: BrowserTurn): Promise<string> {
    const run = this.tail.then(() => this.runExclusive(turn));
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  async close(): Promise<void> {
    const context = this.context;
    this.context = undefined;
    this.page = undefined;
    const closing = context?.close().catch(() => {});
    await Promise.allSettled([this.tail, closing]);
  }

  private discardContext(): void {
    const context = this.context;
    this.context = undefined;
    this.page = undefined;
    if (context) void context.close().catch(() => {});
  }

  private async runStage<T>(
    traceId: string,
    stage: string,
    timeoutMs: number,
    action: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const startedAt = performance.now();
    console.info(`[chatgpt-web] browser turn ${traceId} stage=${stage} started`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let aborted = false;
    let onAbort: (() => void) | undefined;
    if (signal?.aborted) {
      this.discardContext();
      throw new DOMException("ChatGPT web turn aborted", "AbortError");
    }
    try {
      const timeout = new Promise<never>((_, rejectTimeout) => {
        timer = setTimeout(() => {
          timedOut = true;
          rejectTimeout(new Error(`ChatGPT browser stage timed out: ${stage}`));
        }, timeoutMs);
      });
      const abort = signal ? new Promise<never>((_, rejectAbort) => {
        onAbort = () => {
          aborted = true;
          // Closing the isolated context is Playwright's cancellation primitive:
          // it rejects navigation, locator, and file-chooser operations promptly.
          this.discardContext();
          rejectAbort(new DOMException("ChatGPT web turn aborted", "AbortError"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }) : undefined;
      const actionPromise = Promise.resolve().then(action);
      // The browser-page stage can finish creating a context after the abort
      // won the race. Close that late context as soon as the action settles.
      void actionPromise.then(
        () => { if (timedOut || aborted) this.discardContext(); },
        () => { if (timedOut || aborted) this.discardContext(); },
      );
      const value = await Promise.race([actionPromise, timeout, ...(abort ? [abort] : [])]);
      console.info(`[chatgpt-web] browser turn ${traceId} stage=${stage} completed durationMs=${Math.round(performance.now() - startedAt)}`);
      return value;
    } catch (error) {
      console.error(`[chatgpt-web] browser turn ${traceId} stage=${stage} failed durationMs=${Math.round(performance.now() - startedAt)}: ${error instanceof Error ? error.message : String(error)}`);
      if (timedOut || aborted) this.discardContext();
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  private async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    if (!existsSync(this.config.storageStatePath) || !existsSync(loginVerificationMarkerPath(this.config.storageStatePath))) {
      throw new Error(`ChatGPT web login state is missing: ${this.config.storageStatePath}`);
    }
    if (!existsSync(this.config.chromeExecutablePath)) {
      throw new Error(`Configured Chrome executable does not exist: ${this.config.chromeExecutablePath}`);
    }
    if (this.context) {
      try {
        this.page = await this.context.newPage();
        return this.page;
      } catch {
        this.discardContext();
      }
    }
    const createContext = (browser: Browser) => browser.newContext({
      storageState: this.config.storageStatePath,
      // ChatGPT has several continuously animated surfaces while reasoning and
      // invoking tools. Prefer the platform's reduced-motion path so Chromium
      // spends less main-thread/GPU time animating UI the bridge never needs.
      reducedMotion: "reduce",
    });
    let browser = await this.sharedBrowser.get();
    try {
      this.context = await createContext(browser);
    } catch {
      // If the shared Chrome process itself became unhealthy, replace it once.
      // Other lanes already attached to it will observe the disconnect and
      // recreate their isolated context on their next turn.
      this.sharedBrowser.discard(browser);
      browser = await this.sharedBrowser.get();
      this.context = await createContext(browser);
    }
    this.page = await this.context.newPage();
    return this.page;
  }

  /**
   * A Codex turn owns one isolated Temporary Chat document. Reset the existing
   * page to about:blank before navigating it to the next turn instead of opening
   * a second page while the previous (potentially very large) transcript is
   * still resident. That overlap can briefly double renderer memory and freeze
   * low-memory Windows machines after long requests.
   *
   * The about:blank navigation creates a fresh document, so stale transcript and
   * autocomplete DOM cannot leak into the next @app lookup.
   */
  private async pageForNewTurn(): Promise<Page> {
    const previous = await this.ensurePage();
    if (previous.url() === "about:blank") return previous;
    try {
      await previous.goto("about:blank", { waitUntil: "commit", timeout: 15_000 });
      return previous;
    } catch {
      // A renderer can become unhealthy after a very large turn. If the cheap
      // in-place reset fails, discard this lane's isolated browser context
      // before creating a replacement so the old renderer is not kept alive.
      this.discardContext();
      return this.ensurePage();
    }
  }

  private async applyLowPowerPageStyle(page: Page): Promise<void> {
    // prefers-reduced-motion handles well-behaved components. This catches the
    // remaining decorative transitions/animations in the web app without
    // changing layout, interaction, or network behavior.
    await page.addStyleTag({ content: CHATGPT_LOW_POWER_STYLE }).catch(() => {});
  }

  /**
   * ChatGPT now has separate Chat and Work surfaces. This browser adapter must
   * always operate in regular Chat: Work has separate quotas/behavior and can
   * silently become the remembered/default surface.
   */
  private async ensureRegularChatSurface(page: Page): Promise<void> {
    const pageIsWork = async (): Promise<boolean> => {
      try {
        const url = new URL(page.url());
        if (url.searchParams.get("surface") === "work") return true;
      } catch {}

      const workQuota = page.getByText(/(?:out of|remaining).*Work usage|Work usage.*(?:reset|remaining)/i);
      const quotaVisible = await workQuota.evaluateAll(elements => elements.some(element => {
        const html = element as HTMLElement;
        const style = getComputedStyle(html);
        const rect = html.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && style.opacity !== "0"
          && rect.width > 0
          && rect.height > 0;
      })).catch(() => false);
      if (quotaVisible) return true;

      // Evaluate the whole top-level control set in one browser round-trip. The
      // previous per-element Playwright loop could make dozens of IPC calls on
      // every new turn, which is disproportionately expensive on older CPUs.
      return page.locator("button, [role='tab'], [role='radio']").evaluateAll(elements => elements.some(element => {
        const html = element as HTMLElement;
        const style = getComputedStyle(html);
        const rect = html.getBoundingClientRect();
        if (style.display === "none"
          || style.visibility === "hidden"
          || style.opacity === "0"
          || rect.width <= 0
          || rect.height <= 0) return false;
        const text = (html.innerText || html.textContent || "").replace(/\s+/g, " ").trim();
        const selected = html.getAttribute("aria-selected") === "true"
          || html.getAttribute("aria-pressed") === "true"
          || html.getAttribute("data-state") === "active"
          || html.getAttribute("data-state") === "checked";
        return text === "Work" && selected && rect.top >= 0 && rect.bottom <= 350;
      })).catch(() => false);
    };

    const temporaryChatIsPresent = (): boolean => {
      try {
        return new URL(page.url()).searchParams.get("temporary-chat") === "true";
      } catch {
        return false;
      }
    };

    const clickChatToggle = async (): Promise<boolean> => {
      const candidates = [
        page.getByRole("button", { name: "Chat", exact: true }),
        page.getByRole("tab", { name: "Chat", exact: true }),
        page.getByRole("radio", { name: "Chat", exact: true }),
        page.getByText("Chat", { exact: true }),
      ];

      for (const locator of candidates) {
        const count = await locator.count().catch(() => 0);
        for (let index = 0; index < count; index++) {
          const candidate = locator.nth(index);
          if (!await candidate.isVisible().catch(() => false)) continue;
          const usable = await candidate.evaluate(element => {
            const html = element as HTMLElement;
            const rect = html.getBoundingClientRect();
            const text = (html.innerText || html.textContent || "").replace(/\s+/g, " ").trim();
            // The Chat/Work switch is at the top of the product surface. This
            // avoids accidentally clicking chat text from a transcript/sidebar.
            return text === "Chat"
              && rect.width > 0
              && rect.height > 0
              && rect.top >= 0
              && rect.bottom <= 350;
          }).catch(() => false);
          if (!usable) continue;
          await candidate.click({ timeout: 5_000 }).catch(() => {});
          return true;
        }
      }
      return false;
    };

    // A URL can be rewritten by the SPA after navigation. Give it a few bounded
    // repair passes: correct Work -> Chat, then restore temporary-chat if the
    // surface switch dropped that query parameter.
    for (let pass = 0; pass < 3; pass++) {
      const work = await pageIsWork();
      const temporary = temporaryChatIsPresent();

      if (!work && temporary) {
        console.info(`[chatgpt-web] Chat surface confirmed url=${page.url()}`);
        return;
      }

      if (work) {
        console.info(`[chatgpt-web] Work surface detected; switching to regular Chat (url=${page.url()})`);
        if (!await clickChatToggle()) {
          throw new Error(`ChatGPT opened Work and the regular Chat toggle could not be selected (url=${page.url()})`);
        }

        const deadline = Date.now() + 8_000;
        while (Date.now() < deadline) {
          if (!await pageIsWork()) break;
          await page.waitForTimeout(activePollingProfile.uiMs);
        }
        if (await pageIsWork()) {
          throw new Error(`ChatGPT remained on Work after selecting Chat (url=${page.url()})`);
        }
      }

      if (!temporaryChatIsPresent()) {
        console.info("[chatgpt-web] restoring Temporary Chat after Chat/Work surface correction");
        await page.goto(CHATGPT_TEMPORARY_CHAT_URL, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
        await page.waitForTimeout(250);
      }
    }

    if (await pageIsWork()) {
      throw new Error(`ChatGPT redirected back to Work instead of regular Chat (url=${page.url()})`);
    }
    if (!temporaryChatIsPresent()) {
      throw new Error(`ChatGPT regular Chat opened without Temporary Chat isolation (url=${page.url()})`);
    }
  }

  /**
   * Temporary Chat now defaults to an Unpersonalized mode that hides custom
   * apps/plugins. Tool-capable turns must opt back into Personalized before the
   * connector lookup runs. This is deliberately idempotent: profiles that
   * already remember Personalized are detected and left untouched.
   */
  private async visibleTemporaryChatPersonalizationControl(
    page: Page,
  ): Promise<{ locator: Locator; state: ChatGptTemporaryChatPersonalizationState } | undefined> {
    const name = /^(?:Personalized|Unpersonalized)(?:\s+.*)?$/i;
    const candidates = [
      page.getByRole("button", { name }),
      page.getByRole("combobox", { name }),
      page.locator("button, [role='button'], [role='combobox'], [aria-haspopup='menu'], [aria-haspopup='listbox']")
        .filter({ hasText: /^\s*(?:Personalized|Unpersonalized)\s*$/i }),
    ];

    for (const locator of candidates) {
      const count = await locator.count().catch(() => 0);
      for (let index = count - 1; index >= Math.max(0, count - 30); index--) {
        const candidate = locator.nth(index);
        if (!await candidate.isVisible().catch(() => false)) continue;

        const usable = await candidate.evaluate(element => {
          const html = element as HTMLElement;
          if (html.closest([
            "nav",
            "aside",
            "section[data-testid^='conversation-turn-']",
            "[data-testid*='sidebar']",
          ].join(", "))) return false;

          const rect = html.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return false;
          if (rect.top >= 0 && rect.bottom <= 450) return true;

          const composer = document.querySelector<HTMLElement>([
            "#prompt-textarea",
            '[role="textbox"][aria-label="Chat with ChatGPT"]',
            '[contenteditable="true"][aria-label="Chat with ChatGPT"]',
          ].join(", "));
          if (!composer) return false;
          const composerRect = composer.getBoundingClientRect();
          const horizontal = Math.max(0, rect.left - composerRect.right, composerRect.left - rect.right);
          const vertical = Math.max(0, rect.top - composerRect.bottom, composerRect.top - rect.bottom);
          return Math.hypot(horizontal, vertical) <= 650;
        }).catch(() => false);
        if (!usable) continue;

        const labels = await Promise.all([
          candidate.innerText().catch(() => ""),
          candidate.getAttribute("aria-label").catch(() => null),
          candidate.getAttribute("title").catch(() => null),
        ]);
        const state = chatGptTemporaryChatPersonalizationState(labels);
        if (state !== "unknown") return { locator: candidate, state };
      }
    }
    return undefined;
  }

  private async visiblePersonalizedChoice(page: Page): Promise<Locator | undefined> {
    const candidates = [
      page.getByRole("menuitem", { name: "Personalized", exact: true }),
      page.getByRole("menuitemradio", { name: "Personalized", exact: true }),
      page.getByRole("option", { name: "Personalized", exact: true }),
      page.getByRole("radio", { name: "Personalized", exact: true }),
      page.getByRole("button", { name: "Personalized", exact: true }),
      page.locator("[role='menuitem'], [role='menuitemradio'], [role='option'], [role='radio'], button")
        .filter({ hasText: /^\s*Personalized\s*$/i }),
    ];

    for (const locator of candidates) {
      const count = await locator.count().catch(() => 0);
      for (let index = count - 1; index >= Math.max(0, count - 40); index--) {
        const candidate = locator.nth(index);
        if (!await candidate.isVisible().catch(() => false)) continue;
        const inPopup = await candidate.evaluate(element => {
          const html = element as HTMLElement;
          const popup = html.closest<HTMLElement>([
            "[role='listbox']",
            "[role='menu']",
            "[role='dialog']",
            "[popover]",
            "[data-radix-popper-content-wrapper]",
            "[data-floating-ui-portal]",
            "[data-state='open']",
          ].join(", "));
          if (popup) return true;

          let ancestor = html.parentElement;
          while (ancestor && ancestor !== document.body) {
            const style = getComputedStyle(ancestor);
            if ((style.position === "absolute" || style.position === "fixed")
              && ancestor.getBoundingClientRect().width > 0
              && ancestor.getBoundingClientRect().height > 0) return true;
            ancestor = ancestor.parentElement;
          }
          return false;
        }).catch(() => false);
        if (inPopup) return candidate;
      }
    }
    return undefined;
  }

  private async ensurePersonalizedTemporaryChat(page: Page): Promise<void> {
    const initial = await this.visibleTemporaryChatPersonalizationControl(page);
    if (!initial) {
      throw new Error(
        "ChatGPT Temporary Chat personalization control was not found; tool-capable turns require Personalized mode so plugins are available",
      );
    }
    if (initial.state === "personalized") {
      console.info("[chatgpt-web] Temporary Chat already uses Personalized mode");
      return;
    }

    console.info("[chatgpt-web] Temporary Chat is Unpersonalized; switching to Personalized so plugins are available");
    await page.keyboard.press("Escape").catch(() => {});
    await initial.locator.click({ timeout: 5_000 });

    const choiceDeadline = Date.now() + 10_000;
    let choice: Locator | undefined;
    while (Date.now() < choiceDeadline) {
      choice = await this.visiblePersonalizedChoice(page);
      if (choice) break;
      await page.waitForTimeout(activePollingProfile.uiMs);
    }
    if (!choice) {
      throw new Error("ChatGPT opened the Temporary Chat personalization menu but did not expose a Personalized option");
    }

    await choice.click({ timeout: 5_000 });
    const confirmationDeadline = Date.now() + 10_000;
    while (Date.now() < confirmationDeadline) {
      const current = await this.visibleTemporaryChatPersonalizationControl(page);
      if (current?.state === "personalized") {
        console.info("[chatgpt-web] Temporary Chat Personalized mode confirmed; plugin selection may begin");
        return;
      }
      await page.waitForTimeout(activePollingProfile.uiMs);
    }

    throw new Error("ChatGPT did not confirm Personalized mode for Temporary Chat");
  }

  private async selectModelAndEffort(
    page: Page,
    modelId: string,
    reasoning: string | undefined,
    capabilities: ChatGptWebCapabilities,
  ): Promise<ChatGptWebModelMode> {
    const mode = resolveChatGptWebModelMode(modelId, reasoning, capabilities);
    const currentEffort = page.getByRole("button", {
      name: /^(?:Instant(?:\s+5\.\d+)?|Medium|High|Extra High|Pro)$/,
    }).last();
    try {
      await currentEffort.waitFor({ state: "visible", timeout: 70_000 });
    } catch {
      throw new Error("ChatGPT rendered the composer but its model/effort control did not become ready");
    }
    if (chatGptEffortLabelsMatch(await currentEffort.innerText(), mode.uiEffortLabel)) return mode;
    await currentEffort.click();
    const effortChoiceName = mode.uiEffortLabel === "Instant"
      ? /^Instant(?:\s+5\.\d+)?$/
      : mode.uiEffortLabel;
    const effortChoice = page.getByRole("menuitem", { name: effortChoiceName, exact: true }).or(
      page.getByRole("menuitemradio", { name: effortChoiceName, exact: true }),
    ).last();
    try {
      await effortChoice.waitFor({ state: "visible", timeout: 20_000 });
    } catch {
      const choices = (await page.locator('[role="menuitem"], [role="menuitemradio"]').allInnerTexts().catch(() => []))
        .map(value => value.replace(/\s+/g, " ").trim())
        .filter(value => /^(?:Instant(?: 5\.\d+)?|Medium|High|Extra High|Pro)$/.test(value));
      throw new Error(
        `ChatGPT effort ${JSON.stringify(mode.uiEffortLabel)} is unavailable in the authenticated account UI`
        + (choices.length > 0 ? `; available: ${choices.join(", ")}` : ""),
      );
    }
    await effortChoice.click();
    try {
      const deadline = Date.now() + 40_000;
      while (Date.now() < deadline) {
        const visibleLabel = await currentEffort.innerText().catch(() => "");
        if (chatGptEffortLabelsMatch(visibleLabel, mode.uiEffortLabel)) return mode;
        await new Promise(resolveSleep => setTimeout(resolveSleep, activePollingProfile.uiMs));
      }
      throw new Error("effort control did not render the selected label");
    } catch {
      const visible = await page.getByRole("button", {
        name: /^(?:Instant(?:\s+5\.\d+)?|Medium|High|Extra High|Pro)$/,
      }).allInnerTexts().catch(() => []);
      throw new Error(
        `ChatGPT did not confirm effort ${JSON.stringify(mode.uiEffortLabel)}`
        + (visible.length > 0 ? `; visible effort control: ${visible.at(-1)!.replace(/\s+/g, " ").trim()}` : ""),
      );
    }
  }

  /**
   * Read only the user-authored prompt from the composer. ChatGPT renders the
   * selected connector as an inline, non-text mention pill; remove every known
   * pill representation before comparing the composer contents with `prompt`.
   */
  private async attachedPromptText(page: Page): Promise<string> {
    const composer = page.getByRole("textbox", { name: "Chat with ChatGPT" });
    return composer.evaluate((element, appName) => {
      const normalizedAppName = appName.replace(/\s+/g, " ").trim();
      const connectorSelector = [
        "[data-inline-selection-pill]",
        "[data-inline-selection-pill-cursor-target]",
        "[data-testid*='mention']",
        "[data-testid*='connector']",
        "[data-testid*='plugin']",
        "a[role='link']",
        "[contenteditable='false']",
      ].join(", ");
      const connectorNames = (part: HTMLElement): string[] => {
        const withoutDecoration = part.cloneNode(true) as HTMLElement;
        withoutDecoration.querySelectorAll<HTMLElement>([
          "[data-testid*='icon']",
          '[aria-hidden="true"]',
          "svg",
          "img",
        ].join(", ")).forEach(icon => icon.remove());
        return [
          part.getAttribute("aria-label") ?? "",
          part.getAttribute("title") ?? "",
          part.innerText ?? "",
          part.textContent ?? "",
          withoutDecoration.innerText ?? "",
          withoutDecoration.textContent ?? "",
        ].map(value => value.replace(/\s+/g, " ").trim().replace(/^@\s*/, ""));
      };
      const isConnectorPart = (part: HTMLElement): boolean =>
        part.matches(connectorSelector)
        && connectorNames(part).some(name => name === normalizedAppName);
      const blockTags = new Set(["ADDRESS", "ARTICLE", "BLOCKQUOTE", "DIV", "LI", "P", "PRE"]);
      const readNode = (node: Node, isRoot = false): string => {
        if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
        if (!(node instanceof HTMLElement)) return "";
        if (node.tagName === "BR") return "\n";
        // Skip only the small connector subtree instead of cloning the entire
        // potentially multi-hundred-kilobyte composer on every verification.
        if (!isRoot && isConnectorPart(node)) return "";
        const value = [...node.childNodes].map(child => readNode(child)).join("");
        return !isRoot && blockTags.has(node.tagName) ? `${value}\n` : value;
      };
      return readNode(element, true).replace(/\n$/, "").trimStart();
    }, this.config.appName, { timeout: 20_000 });
  }

  /**
   * Cheap submission probe. While the prompt is still present this exits on
   * the first non-whitespace text node instead of reconstructing the complete
   * transported context merely to learn that the composer has not cleared.
   */
  private async composerHasUserText(composer: Locator): Promise<boolean> {
    return composer.evaluate((element, appName) => {
      const normalize = (value: string): string =>
        value.replace(/\s+/g, " ").trim().replace(/^@\s*/, "").toLowerCase();
      const target = normalize(appName);
      const connectorSelector = [
        "[data-inline-selection-pill]",
        "[data-inline-selection-pill-cursor-target]",
        "[data-testid*='mention']",
        "[data-testid*='connector']",
        "[data-testid*='plugin']",
        "a[role='link']",
        "[contenteditable='false']",
      ].join(", ");
      const isConnectorPart = (part: HTMLElement): boolean => {
        if (!part.matches(connectorSelector)) return false;
        return [
          part.getAttribute("aria-label") ?? "",
          part.getAttribute("title") ?? "",
          part.innerText ?? "",
          part.textContent ?? "",
        ].some(value => normalize(value) === target);
      };
      const hasUserText = (node: Node, isRoot = false): boolean => {
        if (node.nodeType === Node.TEXT_NODE) return /\S/.test(node.textContent ?? "");
        if (!(node instanceof HTMLElement)) return false;
        if (!isRoot && isConnectorPart(node)) return false;
        for (const child of node.childNodes) {
          if (hasUserText(child)) return true;
        }
        return false;
      };
      return hasUserText(element, true);
    }, this.config.appName).catch(() => true);
  }

  private async assertPromptAttached(page: Page, prompt: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    let observed = "";
    while (Date.now() < deadline) {
      observed = await this.attachedPromptText(page);
      if (browserComposerTextMatches(prompt, observed)) return;
      await new Promise(resolveSleep => setTimeout(resolveSleep, activePollingProfile.uiMs));
    }
    const normalizedPrompt = normalizeBrowserComposerText(prompt);
    const normalizedObserved = normalizeBrowserComposerText(observed);
    let commonPrefix = 0;
    while (commonPrefix < normalizedPrompt.length
      && normalizedPrompt[commonPrefix] === normalizedObserved[commonPrefix]) commonPrefix += 1;
    throw new Error(
      `ChatGPT composer did not preserve the complete prompt (expectedChars=${prompt.length}, actualChars=${observed.length}, `
      + `normalizedExpectedChars=${normalizedPrompt.length}, normalizedActualChars=${normalizedObserved.length}, `
      + `commonPrefixChars=${commonPrefix})`,
    );
  }

  /** Return true when ChatGPT has already converted @appName into an inline pill. */
  private async connectorIsSelected(page: Page, composer: Locator): Promise<boolean> {
    return composer.evaluate((composerElement, appName) => {
      const composerHtml = composerElement as HTMLElement;
      const normalizedExactName = (value: string): string =>
        value.replace(/\s+/g, " ").trim().replace(/^@\s*/, "");
      const exactTarget = normalizedExactName(appName);
      const normalizeName = (value: string): string =>
        value.replace(/\s+/g, " ").trim().replace(/^@\s*/, "").toLowerCase();
      const target = normalizeName(appName);
      const visibleElement = (value: HTMLElement): boolean => {
        if (typeof value.checkVisibility === "function") {
          return value.checkVisibility({
            checkOpacity: true,
            checkVisibilityCSS: true,
            contentVisibilityAuto: true,
          });
        }
        const style = getComputedStyle(value);
        const rect = value.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && style.opacity !== "0"
          && rect.width > 0
          && rect.height > 0;
      };
      const gap = (left: DOMRect, right: DOMRect): number => {
        const horizontal = Math.max(0, left.left - right.right, right.left - left.right);
        const vertical = Math.max(0, left.top - right.bottom, right.top - left.bottom);
        return Math.hypot(horizontal, vertical);
      };
      const candidateNames = (part: HTMLElement): string[] => {
        const withoutDecoration = part.cloneNode(true) as HTMLElement;
        withoutDecoration.querySelectorAll<HTMLElement>([
          "[data-testid*='icon']",
          '[aria-hidden="true"]',
          "svg",
          "img",
        ].join(", ")).forEach(icon => icon.remove());
        return [
          part.getAttribute("aria-label") ?? "",
          part.getAttribute("title") ?? "",
          part.innerText ?? "",
          part.textContent ?? "",
          withoutDecoration.innerText ?? "",
          withoutDecoration.textContent ?? "",
        ].filter(Boolean);
      };

      // Detect the common inline-pill representation in one renderer pass.
      // The previous Playwright locator/count/isVisible/evaluate loop crossed
      // the browser boundary repeatedly for each candidate, which made connector
      // setup surprisingly CPU-heavy on low-core Windows machines.
      const composerCandidateSelector = [
        "[data-inline-selection-pill]",
        "[data-inline-selection-pill-cursor-target]",
        "[data-testid*='mention']",
        "[data-testid*='connector']",
        "[data-testid*='plugin']",
        "a[role='link']",
        "[contenteditable='false']",
        "[aria-label]",
        "[title]",
      ].join(", ");
      const candidates = new Set<HTMLElement>([
        ...composerHtml.querySelectorAll<HTMLElement>(composerCandidateSelector),
        ...document.querySelectorAll<HTMLElement>(
          "[data-inline-selection-pill], [data-inline-selection-pill-cursor-target]",
        ),
      ]);
      for (const candidate of candidates) {
        if (!visibleElement(candidate)) continue;
        const rect = candidate.getBoundingClientRect();
        const testId = candidate.getAttribute("data-testid")?.toLowerCase() ?? "";
        const knownPill = candidate.matches("[data-inline-selection-pill], [data-inline-selection-pill-cursor-target]")
          || testId.includes("mention")
          || testId.includes("connector")
          || testId.includes("plugin");
        if ((rect.width <= 0 || rect.height <= 0) && !knownPill) continue;
        if (candidateNames(candidate).some(name => normalizedExactName(name) === exactTarget)) return true;
      }

      // Current ChatGPT Plugins shell can represent a committed connector as a
      // label next to data-testid="plugins-button" instead of an inline mention
      // under the contenteditable. Scope this fallback to the smallest visible
      // ancestor shared by the active composer and a nearby Plugins button.
      const excludedSelector = [
        "[role='listbox']",
        "[role='menu']",
        "[role='dialog']",
        "[popover]",
        "[data-radix-popper-content-wrapper]",
        "[data-floating-ui-portal]",
        "[data-testid*='autocomplete']",
        "[data-testid*='mention-menu']",
        "[data-testid*='connector-menu']",
        "[data-testid*='plugin-menu']",
        "nav",
        "aside",
        "section[data-testid^='conversation-turn-']",
        "[data-testid*='sidebar']",
      ].join(", ");

      const composerRect = composerHtml.getBoundingClientRect();
      const pluginButtons = [...document.querySelectorAll<HTMLElement>(
        "[data-testid='plugins-button'], [data-testid*='plugins-button']",
      )].filter(visibleElement);

      for (const pluginsButton of pluginButtons) {
        if (gap(pluginsButton.getBoundingClientRect(), composerRect) > 400) continue;

        let shell: HTMLElement | null = pluginsButton.parentElement;
        while (shell && shell !== document.body && !shell.contains(composerHtml)) {
          shell = shell.parentElement;
        }
        if (!shell || shell === document.body || shell === document.documentElement || !visibleElement(shell)) continue;

        const shellRect = shell.getBoundingClientRect();
        if (shellRect.height > Math.max(600, composerRect.height + 450)) continue;

        const parts = shell.querySelectorAll<HTMLElement>([
          "span",
          "button",
          "a",
          "[data-inline-selection-pill]",
          "[data-inline-selection-pill-cursor-target]",
          "[data-testid*='plugin']",
          "[data-testid*='connector']",
          "[contenteditable='false']",
          "[aria-label]",
          "[title]",
        ].join(", "));
        for (const part of parts) {
          if (!visibleElement(part) || part === pluginsButton) continue;
          if (part.closest(excludedSelector)) continue;
          if (gap(part.getBoundingClientRect(), composerRect) > 400) continue;

          let ancestor = part.parentElement;
          let floating = false;
          while (ancestor && ancestor !== shell) {
            const position = getComputedStyle(ancestor).position;
            if (position === "absolute" || position === "fixed") {
              floating = true;
              break;
            }
            ancestor = ancestor.parentElement;
          }
          if (floating) continue;

          if (candidateNames(part).some(name => normalizeName(name) === target)) return true;
        }
      }
      return false;
    }, this.config.appName).catch(() => false);
  }
  private async waitForConnectorSelected(page: Page, composer: Locator, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.connectorIsSelected(page, composer)) return true;
      await new Promise(resolveSleep => setTimeout(resolveSleep, activePollingProfile.uiMs));
    }
    return false;
  }

  /**
   * Locate the current autocomplete row without depending on one ARIA role.
   * ChatGPT has used group, option, menuitem, button, link, and test-id-backed
   * rows for connector suggestions across UI revisions.
   */
  private async visibleConnectorSuggestion(page: Page): Promise<Locator | undefined> {
    const candidates: Array<{ locator: Locator; accessibleNameMatched: boolean }> = [
      { locator: page.getByRole("option", { name: this.config.appName, exact: true }), accessibleNameMatched: true },
      { locator: page.getByRole("menuitem", { name: this.config.appName, exact: true }), accessibleNameMatched: true },
      { locator: page.getByRole("button", { name: this.config.appName, exact: true }), accessibleNameMatched: true },
      { locator: page.getByRole("link", { name: this.config.appName, exact: true }), accessibleNameMatched: true },
      { locator: page.getByRole("group").filter({ hasText: this.config.appName }), accessibleNameMatched: false },
      { locator: page.locator([
        "[role='option']",
        "[role='menuitem']",
        "[role='group']",
        "[role='listitem']",
        "button",
        "a",
        "[tabindex]:not([tabindex='-1'])",
        "[data-testid*='mention']",
        "[data-testid*='autocomplete']",
        "[data-testid*='connector']",
        "[data-testid*='plugin']",
        "[aria-label]",
        "[title]",
      ].join(", ")), accessibleNameMatched: false },
    ];

    for (const { locator, accessibleNameMatched } of candidates) {
      const count = await locator.count().catch(() => 0);
      // A connector popup is small. Capping broad CSS scans prevents unrelated
      // application DOM from making autocomplete probing unbounded.
      for (let index = count - 1; index >= Math.max(0, count - 100); index--) {
        const candidate = locator.nth(index);
        const visible = await candidate.isVisible().catch(() => false);
        if (!visible) continue;
        const state = await candidate.evaluate(element => {
          const html = element as HTMLElement;
          const ownRole = html.getAttribute("role")?.toLowerCase() ?? "";
          const row = html.closest<HTMLElement>("[role='group'], [role='listitem']");
          const scope = (["group", "listitem"].includes(ownRole) ? html : row) ?? html;
          const composer = document.querySelector<HTMLElement>([
            "#prompt-textarea",
            '[role="textbox"][aria-label="Chat with ChatGPT"]',
            '[contenteditable="true"][aria-label="Chat with ChatGPT"]',
          ].join(", "));
          const visibleElement = (value: HTMLElement): boolean => {
            const style = getComputedStyle(value);
            const rect = value.getBoundingClientRect();
            return style.display !== "none"
              && style.visibility !== "hidden"
              && style.opacity !== "0"
              && rect.width > 0
              && rect.height > 0;
          };
          const popupSelector = [
            "[role='listbox']",
            "[role='menu']",
            "[role='dialog']",
            "[popover]",
            "[data-radix-popper-content-wrapper]",
            "[data-floating-ui-portal]",
            "[data-testid*='autocomplete']",
            "[data-testid*='mention-menu']",
            "[data-testid*='connector-menu']",
            "[data-testid*='plugin-menu']",
          ].join(", ");
          let popup = html.closest<HTMLElement>(popupSelector);
          // Some ChatGPT revisions expose a positioned autocomplete without a
          // semantic popup role. Treat only a visible floating ancestor as the
          // popup in that case.
          if (!popup) {
            let ancestor = html.parentElement;
            while (ancestor && ancestor !== document.body) {
              const position = getComputedStyle(ancestor).position;
              if ((position === "absolute" || position === "fixed") && visibleElement(ancestor)) {
                popup = ancestor;
                break;
              }
              ancestor = ancestor.parentElement;
            }
          }
          const testId = `${html.getAttribute("data-testid") ?? ""} ${scope.getAttribute("data-testid") ?? ""}`.toLowerCase();
          const markedSuggestion = testId.includes("mention")
            || testId.includes("autocomplete")
            || testId.includes("connector")
            || testId.includes("plugin")
            || (["group", "listitem"].includes(ownRole) && html.tabIndex >= 0);
          const suggestionRole = ["option", "menuitem", "button", "link"].includes(ownRole)
            || html.matches("button, a");
          const rect = (popup ?? html).getBoundingClientRect();
          const composerRect = composer?.getBoundingClientRect();
          const horizontalGap = composerRect
            ? Math.max(0, composerRect.left - rect.right, rect.left - composerRect.right)
            : Number.POSITIVE_INFINITY;
          const verticalGap = composerRect
            ? Math.max(0, composerRect.top - rect.bottom, rect.top - composerRect.bottom)
            : Number.POSITIVE_INFINITY;
          const containsExcludedRegion = scope.querySelector([
            "nav",
            "aside",
            "section[data-testid^='conversation-turn-']",
            "[data-testid*='sidebar']",
          ].join(", ")) !== null;
          return {
            names: [
              html.getAttribute("aria-label") ?? "",
              html.getAttribute("title") ?? "",
              html.innerText ?? "",
              html.textContent ?? "",
              scope.getAttribute("aria-label") ?? "",
              scope.getAttribute("title") ?? "",
              scope.innerText ?? "",
              scope.textContent ?? "",
            ].filter(Boolean),
            containsComposer: composer ? scope.contains(composer) : false,
            insideComposer: composer ? composer.contains(scope) : false,
            excludedRegion: containsExcludedRegion || scope.closest([
              "nav",
              "aside",
              "section[data-testid^='conversation-turn-']",
              "[data-testid*='sidebar']",
            ].join(", ")) !== null,
            suggestionRole,
            markedSuggestion,
            inPopup: popup !== null && visibleElement(popup),
            nearComposer: horizontalGap <= 600 && verticalGap <= 600,
            actionable: suggestionRole || markedSuggestion || html.tabIndex >= 0,
          };
        }).catch(() => undefined);
        if (state && chatGptConnectorSuggestionIsUsable(
          { ...state, visible },
          this.config.appName,
          accessibleNameMatched,
        )) return candidate;
      }
    }
    return undefined;
  }

  private async waitForConnectorResolution(
    page: Page,
    composer: Locator,
    timeoutMs: number,
  ): Promise<{ selected: true } | { suggestion: Locator } | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.connectorIsSelected(page, composer)) return { selected: true };
      const candidate = await this.visibleConnectorSuggestion(page);
      if (candidate) return { suggestion: candidate };
      await new Promise(resolveSleep => setTimeout(resolveSleep, activePollingProfile.uiMs));
    }
    // Close the race where ChatGPT commits the plugin at the polling deadline.
    if (await this.connectorIsSelected(page, composer)) return { selected: true };
    return undefined;
  }
  /**
   * Locate Codex Native inside the popup opened by ChatGPT's Plugins button.
   * This path is required by ChatGPT builds that no longer expose @connector
   * autocomplete at all.
   */
  private async visiblePluginsPickerConnector(page: Page, composer: Locator): Promise<Locator | undefined> {
    const candidates: Array<{ locator: Locator; accessibleNameMatched: boolean }> = [
      { locator: page.getByRole("menuitem", { name: this.config.appName, exact: true }), accessibleNameMatched: true },
      { locator: page.getByRole("menuitemradio", { name: this.config.appName, exact: true }), accessibleNameMatched: true },
      { locator: page.getByRole("option", { name: this.config.appName, exact: true }), accessibleNameMatched: true },
      { locator: page.getByRole("button", { name: this.config.appName, exact: true }), accessibleNameMatched: true },
      { locator: page.getByRole("link", { name: this.config.appName, exact: true }), accessibleNameMatched: true },
      { locator: page.getByRole("menuitem").filter({ hasText: this.config.appName }), accessibleNameMatched: false },
      { locator: page.getByRole("option").filter({ hasText: this.config.appName }), accessibleNameMatched: false },
      { locator: page.locator("button, a, [role='listitem']").filter({ hasText: this.config.appName }), accessibleNameMatched: false },
      { locator: page.getByText(this.config.appName, { exact: true }), accessibleNameMatched: false },
    ];

    for (const { locator, accessibleNameMatched } of candidates) {
      const count = await locator.count().catch(() => 0);
      for (let index = count - 1; index >= Math.max(0, count - 50); index--) {
        const candidate = locator.nth(index);
        const visible = await candidate.isVisible().catch(() => false);
        if (!visible) continue;

        const names = await candidate.evaluate(connectorCandidateNames).catch(() => [] as string[]);
        if (!accessibleNameMatched
          && !names.some(name => connectorNameMatches(name, this.config.appName))) {
          continue;
        }

        const state = await candidate.evaluate(element => {
          const html = element as HTMLElement;
          const visibleElement = (value: HTMLElement): boolean => {
            const style = getComputedStyle(value);
            const rect = value.getBoundingClientRect();
            return style.display !== "none"
              && style.visibility !== "hidden"
              && style.opacity !== "0"
              && rect.width > 0
              && rect.height > 0;
          };
          const composer = document.querySelector<HTMLElement>([
            "#prompt-textarea",
            '[role="textbox"][aria-label="Chat with ChatGPT"]',
            '[contenteditable="true"][aria-label="Chat with ChatGPT"]',
          ].join(", "));
          const popupSelector = [
            "[role='listbox']",
            "[role='menu']",
            "[role='dialog']",
            "[popover]",
            "[data-radix-popper-content-wrapper]",
            "[data-floating-ui-portal]",
            "[data-testid*='plugin-menu']",
            "[data-testid*='connector-menu']",
            "[data-testid*='picker']",
            "[data-testid*='popover']",
            "[data-state='open']",
          ].join(", ");

          let popup = html.closest<HTMLElement>(popupSelector);
          if (!popup) {
            let ancestor = html.parentElement;
            while (ancestor && ancestor !== document.body) {
              const style = getComputedStyle(ancestor);
              if ((style.position === "absolute" || style.position === "fixed")
                && visibleElement(ancestor)) {
                popup = ancestor;
                break;
              }
              ancestor = ancestor.parentElement;
            }
          }

          const pluginsButton = html.closest("[data-testid='plugins-button'], [data-testid*='plugins-button']");
          const excluded = html.closest([
            "nav",
            "aside",
            "section[data-testid^='conversation-turn-']",
            "[data-testid*='sidebar']",
          ].join(", ")) !== null;
          const rect = (popup ?? html).getBoundingClientRect();
          const composerRect = composer?.getBoundingClientRect();
          const horizontalGap = composerRect
            ? Math.max(0, composerRect.left - rect.right, rect.left - composerRect.right)
            : Number.POSITIVE_INFINITY;
          const verticalGap = composerRect
            ? Math.max(0, composerRect.top - rect.bottom, rect.top - composerRect.bottom)
            : Number.POSITIVE_INFINITY;

          return {
            inPopup: popup !== null && visibleElement(popup),
            isPluginsButton: pluginsButton !== null,
            excluded,
            containsComposer: composer ? html.contains(composer) : false,
            insideComposer: composer ? composer.contains(html) : false,
            nearComposer: horizontalGap <= 900 && verticalGap <= 900,
          };
        }).catch(() => undefined);

        if (!state
          || !state.inPopup
          || state.isPluginsButton
          || state.excluded
          || state.containsComposer
          || state.insideComposer
          || !state.nearComposer) {
          continue;
        }
        return candidate;
      }
    }
    return undefined;
  }

  /**
   * Prefer ChatGPT's explicit Plugins picker. The @mention path is retained
   * only as a compatibility fallback for older UI revisions.
   */
  private async selectConnectorViaPluginsButton(page: Page, composer: Locator): Promise<boolean> {
    if (await this.connectorIsSelected(page, composer)) return true;

    const buttons = page.locator(
      "[data-testid='plugins-button'], [data-testid*='plugins-button']",
    );
    const count = await buttons.count().catch(() => 0);
    for (let index = count - 1; index >= 0; index--) {
      const pluginsButton = buttons.nth(index);
      if (!await pluginsButton.isVisible().catch(() => false)) continue;

      const nearComposer = await pluginsButton.evaluate(button => {
        const composer = document.querySelector<HTMLElement>([
          "#prompt-textarea",
          '[role="textbox"][aria-label="Chat with ChatGPT"]',
          '[contenteditable="true"][aria-label="Chat with ChatGPT"]',
        ].join(", "));
        if (!composer) return false;
        const left = (button as HTMLElement).getBoundingClientRect();
        const right = composer.getBoundingClientRect();
        const horizontal = Math.max(0, left.left - right.right, right.left - left.right);
        const vertical = Math.max(0, left.top - right.bottom, right.top - left.bottom);
        return Math.hypot(horizontal, vertical) <= 500;
      }).catch(() => false);
      if (!nearComposer) continue;

      await page.keyboard.press("Escape").catch(() => {});
      await composer.fill("");
      await pluginsButton.click({ timeout: 5_000 }).catch(() => {});
      if (await this.waitForConnectorSelected(page, composer, 1_000)) return true;

      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        const connector = await this.visiblePluginsPickerConnector(page, composer);
        if (connector) {
          await connector.click({ timeout: 5_000 }).catch(() => {});
          if (await this.waitForConnectorSelected(page, composer, 5_000)) return true;

          console.info(
            `[chatgpt-web] Plugins picker clicked ${JSON.stringify(this.config.appName)} but committed connector state was not detected; visible connector UI=${await this.connectorSelectionDiagnostic(page)}`,
          );

          // Some revisions keep the picker open while updating composer state.
          // Close it and probe the committed shell one more time.
          await page.keyboard.press("Escape").catch(() => {});
          if (await this.waitForConnectorSelected(page, composer, 1_500)) return true;
          break;
        }
        await new Promise(resolveSleep => setTimeout(resolveSleep, activePollingProfile.uiMs));
      }

      console.info(
        `[chatgpt-web] Plugins picker did not expose a usable ${JSON.stringify(this.config.appName)} item; visible connector UI=${await this.connectorSelectionDiagnostic(page)}`,
      );
      await page.keyboard.press("Escape").catch(() => {});
    }
    return false;
  }

  /**
   * Reproduce the connector-selection sequence that works manually in the
   * current ChatGPT UI: type @Codex Native, wait for its popup row, click that
   * row, then verify committed connector state before any Codex context is
   * inserted into the composer.
   */
  private async visibleMentionConnectorPopupTarget(page: Page, composer: Locator): Promise<Locator | undefined> {
    const candidates: Locator[] = [
      page.getByRole("option", { name: this.config.appName, exact: true }),
      page.getByRole("menuitem", { name: this.config.appName, exact: true }),
      page.getByRole("menuitemradio", { name: this.config.appName, exact: true }),
      page.getByRole("button", { name: this.config.appName, exact: true }),
      page.getByRole("link", { name: this.config.appName, exact: true }),
      page.getByText(this.config.appName, { exact: true }),
    ];

    for (const locator of candidates) {
      const count = await locator.count().catch(() => 0);
      for (let index = count - 1; index >= Math.max(0, count - 60); index--) {
        const candidate = locator.nth(index);
        if (!await candidate.isVisible().catch(() => false)) continue;

        const usable = await candidate.evaluate((element, appName) => {
          const html = element as HTMLElement;
          const normalizeName = (value: string): string =>
            value.replace(/\s+/g, " ").trim().replace(/^@\s*/, "").toLowerCase();
          const target = normalizeName(appName);
          const visible = (value: HTMLElement): boolean => {
            const style = getComputedStyle(value);
            const rect = value.getBoundingClientRect();
            return style.display !== "none"
              && style.visibility !== "hidden"
              && style.opacity !== "0"
              && rect.width > 0
              && rect.height > 0;
          };
          const composerElement = document.querySelector<HTMLElement>([
            "#prompt-textarea",
            '[role="textbox"][aria-label="Chat with ChatGPT"]',
            '[contenteditable="true"][aria-label="Chat with ChatGPT"]',
          ].join(", "));
          if (!composerElement || composerElement.contains(html)) return false;
          if (html.closest([
            "nav",
            "aside",
            "section[data-testid^='conversation-turn-']",
            "[data-testid*='sidebar']",
          ].join(", "))) return false;

          const ownNames = [
            html.getAttribute("aria-label") ?? "",
            html.getAttribute("title") ?? "",
            html.innerText ?? "",
            html.textContent ?? "",
          ].map(normalizeName).filter(Boolean);
          if (!ownNames.some(name => name === target)) return false;

          const popupSelector = [
            "[role='listbox']",
            "[role='menu']",
            "[role='dialog']",
            "[popover]",
            "[data-radix-popper-content-wrapper]",
            "[data-floating-ui-portal]",
            "[data-testid*='autocomplete']",
            "[data-testid*='mention-menu']",
            "[data-testid*='connector-menu']",
            "[data-testid*='plugin-menu']",
            "[data-testid*='picker']",
          ].join(", ");

          let popup = html.closest<HTMLElement>(popupSelector);
          if (!popup) {
            let ancestor = html.parentElement;
            while (ancestor && ancestor !== document.body) {
              const style = getComputedStyle(ancestor);
              if ((style.position === "absolute" || style.position === "fixed") && visible(ancestor)) {
                popup = ancestor;
                break;
              }
              ancestor = ancestor.parentElement;
            }
          }
          if (!popup || !visible(popup)) return false;

          const rect = popup.getBoundingClientRect();
          const composerRect = composerElement.getBoundingClientRect();
          const horizontalGap = Math.max(0, composerRect.left - rect.right, rect.left - composerRect.right);
          const verticalGap = Math.max(0, composerRect.top - rect.bottom, rect.top - composerRect.bottom);
          return horizontalGap <= 900 && verticalGap <= 900;
        }, this.config.appName).catch(() => false);

        if (usable) return candidate;
      }
    }
    return undefined;
  }

  private async clickMentionConnectorPopupTarget(page: Page, target: Locator): Promise<boolean> {
    // First use a normal Playwright click so ChatGPT receives the same pointer
    // sequence as a user click. If a wrapper intercepts it, click the visible
    // label's center as a bounded manual-equivalent fallback.
    try {
      await target.click({ timeout: 4_000 });
      return true;
    } catch {}

    const box = await target.boundingBox().catch(() => null);
    if (!box || box.width <= 0 || box.height <= 0) return false;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    return true;
  }

  private async waitForManualMentionSelection(page: Page, composer: Locator, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let clicked = false;
    while (Date.now() < deadline) {
      if (await this.connectorIsSelected(page, composer)) return true;

      const target = await this.visibleMentionConnectorPopupTarget(page, composer);
      if (target && !clicked) {
        console.info(`[chatgpt-web] connector automation: ${this.config.appName} popup row detected; clicking it`);
        clicked = await this.clickMentionConnectorPopupTarget(page, target);
        if (clicked) {
          const selected = await this.waitForConnectorSelected(page, composer, 6_000);
          if (selected) return true;
        }
      }
      await page.waitForTimeout(activePollingProfile.uiMs);
    }
    return this.connectorIsSelected(page, composer);
  }

  private async connectorSelectionDiagnostic(page: Page): Promise<string> {
    const visible = await page.locator([
      "[role='listbox']",
      "[role='option']",
      "[role='menu']",
      "[role='menuitem']",
      "[role='group']",
      "[role='listitem']",
      "[data-testid*='mention']",
      "[data-testid*='autocomplete']",
      "[data-testid*='connector']",
      "[data-testid*='plugin']",
      "[data-inline-selection-pill]",
    ].join(", ")).evaluateAll(elements => elements
      .filter(element => {
        const candidate = element as HTMLElement;
        const style = getComputedStyle(candidate);
        const rect = candidate.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && style.opacity !== "0"
          && rect.width > 0
          && rect.height > 0;
      })
      .slice(-40)
      .map(element => {
        const candidate = element as HTMLElement;
        return {
          tag: candidate.tagName.toLowerCase(),
          role: candidate.getAttribute("role"),
          testId: candidate.getAttribute("data-testid"),
          ariaLabel: candidate.getAttribute("aria-label"),
          title: candidate.getAttribute("title"),
          text: (candidate.innerText || candidate.textContent || "").replace(/\s+/g, " ").trim().slice(0, 300),
        };
      })).catch(() => [] as Array<Record<string, string | null>>);
    return redactChatGptUiDiagnostic(JSON.stringify(visible));
  }

  private async selectConnector(page: Page, composer: Locator): Promise<void> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      await page.keyboard.press("Escape").catch(() => {});
      await composer.fill("");
      await composer.focus();

      // IMPORTANT: this deliberately mirrors the sequence confirmed to work
      // manually on the user's current ChatGPT build. Do not open Plugins first.
      await page.keyboard.type(`@${this.config.appName}`, { delay: 25 });
      console.info(`[chatgpt-web] connector automation: typed @${this.config.appName}; waiting for popup selection before context insertion`);

      if (await this.waitForManualMentionSelection(page, composer, 15_000)) {
        console.info(`[chatgpt-web] connector automation: ${this.config.appName} committed; context insertion may begin`);
        return;
      }

      // Keep the older generalized suggestion detector only as a fallback for
      // minor DOM revisions. It is never allowed to cause raw @mention submit.
      const suggestion = await this.visibleConnectorSuggestion(page);
      if (suggestion) {
        await suggestion.click({ timeout: 4_000 }).catch(() => {});
        if (await this.waitForConnectorSelected(page, composer, 5_000)) {
          console.info(`[chatgpt-web] connector automation: ${this.config.appName} committed through fallback suggestion detector`);
          return;
        }
      }

      await page.keyboard.press("Escape").catch(() => {});
      if (attempt < 2) await page.waitForTimeout(400);
    }

    const diagnostic = await this.connectorSelectionDiagnostic(page);
    await composer.fill("").catch(() => {});
    throw new Error(
      `ChatGPT could not select connector ${JSON.stringify(this.config.appName)}`
      + "; bridge typed the @mention but could not click/confirm its popup row before context insertion"
      + (diagnostic !== "[]" ? `; visible connector UI=${diagnostic}` : ""),
    );
  }
  private async attachPrompt(page: Page, prompt: string, localTools: boolean): Promise<void> {
    const composer = page.getByRole("textbox", { name: "Chat with ChatGPT" });
    await composer.waitFor({ state: "visible", timeout: 20_000 });
    if (!localTools) {
      await composer.fill(prompt);
      await this.assertPromptAttached(page, prompt);
      return;
    }

    // selectConnector() must finish the @mention -> popup click -> committed
    // plugin handshake before the very large transported Codex context is put
    // into the contenteditable. This is the ordering that works manually.
    await this.selectConnector(page, composer);
    if (!await this.connectorIsSelected(page, composer)) {
      throw new Error(
        `ChatGPT connector ${JSON.stringify(this.config.appName)} was not committed before Codex context insertion`,
      );
    }

    console.info(`[chatgpt-web] connector automation: inserting Codex context after committed plugin (chars=${prompt.length})`);
    await composer.focus();
    await page.keyboard.press("End");
    await page.keyboard.insertText(` ${prompt}`);
    await this.assertPromptAttached(page, prompt);
    console.info("[chatgpt-web] connector automation: Codex context insertion verified");
  }
  private async attachFiles(
    page: Page,
    prompt: CompiledChatGptWebPrompt,
    signal?: AbortSignal,
  ): Promise<void> {
    const files = chatGptPromptFilePayloads(prompt);
    if (files.length === 0) return;
    if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    const removeControls = page.locator(CHATGPT_ATTACHMENT_REMOVE_CONTROL_SELECTOR);
    const existing = await removeControls.count();
    const input = page.locator('input[data-testid="upload-photos-input"]');
    await input.waitFor({ state: "attached", timeout: CHATGPT_ATTACHMENT_INPUT_TIMEOUT_MS });
    if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    const send = page.getByTestId("send-button");
    const deadline = Date.now() + CHATGPT_ATTACHMENT_UPLOAD_TIMEOUT_MS;
    const network = new ChatGptAttachmentNetworkTracker(page);
    const readiness = new ChatGptAttachmentReadinessTracker();
    let lastAttachedCount = existing;
    let lastPendingUi = false;
    let lastUploadedUiCount = 0;
    let lastSendEnabled = false;
    try {
      await input.setInputFiles(files);
      while (Date.now() < deadline) {
        if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
        lastAttachedCount = await removeControls.count().catch(() => existing);
        const ui = lastAttachedCount >= existing + files.length
          ? await this.promptAttachmentUiState(removeControls, existing, files.length).catch(() => ({
              pending: true,
              uploadedCount: 0,
            }))
          : { pending: true, uploadedCount: 0 };
        lastPendingUi = ui.pending;
        lastUploadedUiCount = ui.uploadedCount;
        lastSendEnabled = await send.isVisible().catch(() => false)
          && await send.isEnabled().catch(() => false);
        const alerts = await this.promptAttachmentAlerts(page);
        if (alerts.length > 0) {
          throw new Error(`ChatGPT rejected a prompt attachment: ${alerts.join(" | ")}`);
        }
        const upload = network.snapshot();
        if (upload.failed > 0
          && upload.pending === 0
          && Date.now() - upload.lastActivityAt >= CHATGPT_ATTACHMENT_FAILURE_GRACE_MS) {
          throw new Error(
            `ChatGPT prompt attachment upload failed (${upload.failed} failed request${upload.failed === 1 ? "" : "s"})`,
          );
        }
        if (readiness.update({
          attachedCount: lastAttachedCount - existing,
          expectedCount: files.length,
          sendEnabled: lastSendEnabled,
          pendingUi: lastPendingUi,
          uploadedUiCount: lastUploadedUiCount,
          uploadRequestsSeen: upload.seen,
          uploadRequestsPending: upload.pending,
          uploadRequestsFailed: upload.failed,
          successfulUploads: upload.successfulUploads,
          uploadActivitySequence: upload.activitySequence,
        })) {
          console.info(
            `[chatgpt-web] prompt attachments ready (count=${files.length}, uploadRequests=${upload.seen}, successfulUploads=${upload.successfulUploads}, uploadedUi=${lastUploadedUiCount})`,
          );
          return;
        }
        await new Promise<void>((resolveSleep, rejectSleep) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const onAbort = () => {
            if (timer) clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            rejectSleep(new DOMException("ChatGPT web turn aborted", "AbortError"));
          };
          timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolveSleep();
          }, activePollingProfile.uiMs);
          signal?.addEventListener("abort", onAbort, { once: true });
          if (signal?.aborted) onAbort();
        });
      }
      const upload = network.snapshot();
      throw new Error(
        "ChatGPT did not finish uploading all prompt attachments"
        + ` (accepted=${Math.max(0, lastAttachedCount - existing)}/${files.length}`
        + `, pendingUi=${lastPendingUi}, uploadedUi=${lastUploadedUiCount}, sendEnabled=${lastSendEnabled}`
        + `, uploadRequests=${upload.seen}, successfulUploads=${upload.successfulUploads}`
        + `, pendingRequests=${upload.pending}, failedRequests=${upload.failed})`,
      );
    } finally {
      network.stop();
    }
  }

  private async promptAttachmentUiState(
    removeControls: Locator,
    start: number,
    count: number,
  ): Promise<{ pending: boolean; uploadedCount: number }> {
    const observations = await removeControls.evaluateAll((controls, range) => {
      const visible = (element: Element): boolean => {
        const html = element as HTMLElement;
        const style = getComputedStyle(html);
        const rect = html.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const explicitStatusText = (element: Element): string => (
        `${element.getAttribute("aria-label") ?? ""} ${element.textContent ?? ""}`
          .replace(/\s+/g, " ")
          .trim()
      );
      return controls.slice(range.start, range.start + range.count).map(control => {
        // Text from the composer or prompt is never a status signal. Inspect
        // its descriptor as a non-status node alongside explicit descendants;
        // the host-side classifier rejects that ambient prose.
        const scope = control.closest(range.cardSelector) ?? control.parentElement;
        if (!scope) return { pendingBySelector: false, uploadedBySelector: false, statusTextNodes: [] };
        const pendingNodes = [
          ...(scope.matches(range.pendingSelector) ? [scope] : []),
          ...scope.querySelectorAll(range.pendingSelector),
        ];
        const statusNodes = [
          ...(scope.matches(range.statusSelector) ? [scope] : []),
          ...scope.querySelectorAll(range.statusSelector),
        ];
        const uploadedNodes = [
          ...(scope.matches(range.uploadedSelector) ? [scope] : []),
          ...scope.querySelectorAll(range.uploadedSelector),
        ];
        const statusCandidates = [...new Set([scope, ...statusNodes])];
        return {
          pendingBySelector: pendingNodes.some(visible),
          uploadedBySelector: uploadedNodes.some(visible),
          statusTextNodes: statusCandidates.filter(visible).map(node => ({
            text: explicitStatusText(node),
            role: node.getAttribute("role"),
            ariaLive: node.getAttribute("aria-live"),
            testId: node.getAttribute("data-testid"),
          })),
        };
      });
    }, {
      start,
      count,
      cardSelector: CHATGPT_ATTACHMENT_CARD_SELECTOR,
      pendingSelector: CHATGPT_ATTACHMENT_PENDING_SELECTOR,
      uploadedSelector: CHATGPT_ATTACHMENT_UPLOADED_SELECTOR,
      statusSelector: CHATGPT_ATTACHMENT_STATUS_SELECTOR,
    });
    let pending = false;
    let uploadedCount = 0;
    for (const observation of observations) {
      const textKinds = observation.statusTextNodes.map(chatGptAttachmentStatusTextKind);
      if (observation.pendingBySelector || textKinds.includes("pending")) pending = true;
      if (observation.uploadedBySelector || textKinds.includes("uploaded")) uploadedCount += 1;
    }
    return { pending, uploadedCount };
  }

  private async promptAttachmentAlerts(page: Page): Promise<string[]> {
    const alerts = await page.locator('[role="alert"]').allInnerTexts().catch(() => []);
    return alerts
      .map(text => text.replace(/\s+/g, " ").trim())
      .filter(text => Boolean(text) && (
        /\b(?:upload|attachment|file|image)\b/i.test(text)
        || /\b(?:too large|too many|unsupported format)\b/i.test(text)
      ));
  }

  private stopControl(page: Page): Locator {
    return page.getByRole("button", { name: /^Stop (?:answering|generating)$/i }).or(
      page.getByTestId("stop-button"),
    ).or(page.getByRole("button", { name: "Answer now", exact: true })).last();
  }

  private async submissionState(
    page: Page,
    expectedPrompt: string,
    initialUserTurns: number,
    initialAssistantTurns: number,
  ): Promise<ChatGptSubmissionState> {
    const userTurns = page.locator('[data-testid^="conversation-turn-"][data-turn="user"]');
    const assistantTurns = page.locator('[data-testid^="conversation-turn-"][data-turn="assistant"]');
    const composer = page.getByRole("textbox", { name: "Chat with ChatGPT" });
    const composerPresent = await composer.count().catch(() => 0) > 0;
    const composerHasUserText = composerPresent
      ? await this.composerHasUserText(composer)
      : true;
    return {
      initialUserTurns,
      initialAssistantTurns,
      userTurns: await userTurns.count().catch(() => initialUserTurns),
      assistantTurns: await assistantTurns.count().catch(() => initialAssistantTurns),
      running: await this.stopControl(page).isVisible().catch(() => false),
      promptCleared: expectedPrompt.length > 0 && composerPresent && !composerHasUserText,
    };
  }

  private async waitForSubmissionEvidence(
    page: Page,
    expectedPrompt: string,
    initialUserTurns: number,
    initialAssistantTurns: number,
    timeoutMs: number,
  ): Promise<ChatGptSubmissionState> {
    const deadline = Date.now() + timeoutMs;
    let state = await this.submissionState(page, expectedPrompt, initialUserTurns, initialAssistantTurns);
    while (!chatGptSubmissionWasObserved(state) && Date.now() < deadline) {
      await new Promise(resolveSleep => setTimeout(resolveSleep, activePollingProfile.uiMs));
      state = await this.submissionState(page, expectedPrompt, initialUserTurns, initialAssistantTurns);
    }
    return state;
  }

  private async submitPrompt(
    page: Page,
    prompt: string,
    localTools: boolean,
    initialUserTurns: number,
    initialAssistantTurns: number,
  ): Promise<void> {
    const composer = page.getByRole("textbox", { name: "Chat with ChatGPT" });
    if (localTools && !await this.connectorIsSelected(page, composer)) {
      throw new Error(
        `ChatGPT connector ${JSON.stringify(this.config.appName)} was not selected immediately before submission; refusing to send a raw @mention`,
      );
    }
    await this.assertPromptAttached(page, prompt);

    const send = page.getByTestId("send-button");
    const readyDeadline = Date.now() + 10_000;
    while (Date.now() < readyDeadline) {
      if (await send.isVisible().catch(() => false) && await send.isEnabled().catch(() => false)) break;
      await new Promise(resolveSleep => setTimeout(resolveSleep, activePollingProfile.uiMs));
    }
    if (!await send.isVisible().catch(() => false) || !await send.isEnabled().catch(() => false)) {
      throw new Error("ChatGPT composer preserved the prompt but its Send button did not become actionable");
    }
    if (localTools && !await this.connectorIsSelected(page, composer)) {
      throw new Error(
        `ChatGPT connector ${JSON.stringify(this.config.appName)} disappeared while the composer was becoming ready; refusing to send a raw @mention`,
      );
    }

    const clickErrors: string[] = [];
    const clickSend = async (): Promise<void> => {
      try {
        await send.click({ timeout: 5_000 });
      } catch (error) {
        clickErrors.push(error instanceof Error ? error.message : String(error));
      }
    };

    await clickSend();
    let state = await this.waitForSubmissionEvidence(
      page,
      prompt,
      initialUserTurns,
      initialAssistantTurns,
      5_000,
    );
    if (chatGptSubmissionWasObserved(state)) return;

    const observedPrompt = await this.attachedPromptText(page).catch(() => undefined);
    const connectorStillSelected = !localTools || await this.connectorIsSelected(page, composer);
    const safeToRetry = observedPrompt !== undefined
      && browserComposerTextMatches(prompt, observedPrompt)
      && connectorStillSelected
      && await send.isVisible().catch(() => false)
      && await send.isEnabled().catch(() => false);
    let retried = false;
    if (safeToRetry) {
      retried = true;
      await clickSend();
    }
    state = await this.waitForSubmissionEvidence(
      page,
      prompt,
      initialUserTurns,
      initialAssistantTurns,
      10_000,
    );
    if (chatGptSubmissionWasObserved(state)) return;

    const finalPrompt = await this.attachedPromptText(page).catch(() => undefined);
    const diagnostic = redactChatGptUiDiagnostic(JSON.stringify({
      retried,
      safeToRetry,
      clickErrors: clickErrors.map(value => value.slice(0, 500)),
      initialUserTurns,
      initialAssistantTurns,
      userTurns: state.userTurns,
      assistantTurns: state.assistantTurns,
      running: state.running,
      promptCleared: state.promptCleared,
      composerPresent: finalPrompt !== undefined,
      composerChars: finalPrompt?.length,
      sendVisible: await send.isVisible().catch(() => false),
      sendEnabled: await send.isEnabled().catch(() => false),
      connectorSelected: localTools ? await this.connectorIsSelected(page, composer) : undefined,
    }));
    throw new Error(
      "ChatGPT did not confirm message submission: the composer did not clear, no new user or assistant turn appeared, and no Stop control became visible"
      + `; ui=${diagnostic}`,
    );
  }

  private async recoverMessageDeliveryTimeout(
    page: Page,
    attempt: number,
  ): Promise<boolean> {
    const timeoutMessage = page.getByText(
      /Message delivery timed out\. Please try again\./i,
    ).last();
    if (!await timeoutMessage.isVisible().catch(() => false)) return false;

    if (attempt >= MAX_CHATGPT_DELIVERY_TIMEOUT_RECOVERIES) {
      throw new Error(
        "ChatGPT message delivery repeatedly timed out after "
        + String(attempt)
        + " automatic recoveries",
      );
    }

    const retry = page.getByRole("button", { name: "Retry", exact: true }).last();
    if (!await retry.isVisible().catch(() => false)) {
      throw new Error(
        "ChatGPT reported a message delivery timeout but did not expose its Retry button",
      );
    }

    console.warn(
      "[chatgpt-web] ChatGPT message delivery timed out; clicking Retry automatically "
      + "(recovery "
      + String(attempt + 1)
      + "/"
      + String(MAX_CHATGPT_DELIVERY_TIMEOUT_RECOVERIES)
      + ")",
    );

    await retry.click({ timeout: 5_000 });

    const recoveryDeadline = Date.now() + 20_000;
    while (Date.now() < recoveryDeadline) {
      const timeoutStillVisible = await timeoutMessage.isVisible().catch(() => false);
      const retryStillVisible = await retry.isVisible().catch(() => false);
      const stopVisible = await page.getByRole("button", { name: "Stop answering" })
        .isVisible()
        .catch(() => false);
      if (!timeoutStillVisible && (!retryStillVisible || stopVisible)) {
        console.info("[chatgpt-web] ChatGPT delivery Retry was accepted; browser turn is active again");
        return true;
      }
      await page.waitForTimeout(activePollingProfile.uiMs);
    }

    throw new Error("ChatGPT Retry did not clear the message delivery timeout state");
  }

  private async handleToolConfirmation(page: Page): Promise<boolean> {
    const heading = page.getByText(`Allow ChatGPT to use ${this.config.appName}?`, { exact: true }).last();
    if (!await heading.isVisible().catch(() => false)) return false;
    if (!this.config.autoApproveToolCalls) {
      throw new Error(
        `ChatGPT is waiting for confirmation to use ${this.config.appName}; set chatgptWeb.autoApproveToolCalls=true to authorize per-call "Allow once" clicks`,
      );
    }
    const allowOnce = page.getByRole("button", { name: "Allow once", exact: true }).last();
    await allowOnce.waitFor({ state: "visible", timeout: 10_000 });
    await allowOnce.click();
    return true;
  }

  private async responseDomSnapshot(
    page: Page,
    responseIndex: number,
    scanRecoverySignals: boolean,
    scanTraceBlocks: boolean,
    pendingToolCount = 0,
  ): Promise<ChatGptResponseDomSnapshot> {
    const snapshot = await page.evaluate(({ maxTraceCandidates, responseIndex, scanRecoverySignals, scanTraceBlocks, pendingToolCount }) => {
      const visible = (candidate: HTMLElement): boolean => {
        if (typeof candidate.checkVisibility === "function") {
          return candidate.checkVisibility({
            checkOpacity: true,
            checkVisibilityCSS: true,
            contentVisibilityAuto: true,
          });
        }
        const style = getComputedStyle(candidate);
        const rect = candidate.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && style.opacity !== "0"
          && rect.width > 0
          && rect.height > 0;
      };
      const stopControls = document.querySelectorAll<HTMLElement>([
        'button[data-testid="stop-button"]',
        'button[aria-label="Stop answering"]',
        'button[aria-label="Stop generating"]',
      ].join(", "));
      // Responsive layouts can leave a hidden stale Stop button before the
      // visible current one. Inspect every match, and recognize ChatGPT's
      // long-reasoning "Answer now" control as equivalent liveness evidence.
      let running = [...stopControls].some(visible)
        || [...document.querySelectorAll<HTMLElement>("button")].some(candidate => (
          visible(candidate)
          && (candidate.textContent ?? "").replace(/\s+/g, " ").trim() === "Answer now"
        ));
      let deliveryTimeoutPresent = false;
      let toolConfirmationPresent = false;
      // Recovery states are rare and page-wide control scans are costly on long
      // transcripts. Probe them less frequently than response progress.
      if (scanRecoverySignals) {
        for (const candidate of document.querySelectorAll<HTMLElement>("button, [role='alert'], [role='dialog'], [role='status']")) {
          const text = (candidate.textContent || "").replace(/\s+/g, " ").trim();
          if (!deliveryTimeoutPresent
            && /Message delivery timed out\. Please try again\./i.test(text)
            && visible(candidate)) {
            deliveryTimeoutPresent = true;
          }
          if (!toolConfirmationPresent
            && /Allow ChatGPT to use .+\?/i.test(text)
            && visible(candidate)) {
            toolConfirmationPresent = true;
          }
          if (deliveryTimeoutPresent && toolConfirmationPresent) break;
        }
      }

      const root = document.querySelectorAll<HTMLElement>(
        '[data-testid^="conversation-turn-"][data-turn="assistant"]',
      )[responseIndex];
      if (!root) {
        return {
          responsePresent: false,
          running,
          deliveryTimeoutPresent,
          toolConfirmationPresent,
          completionSignature: "",
          visibleText: "",
          visibleTextLength: 0,
          completionActionPresent: false,
          traceBlocks: [],
        };
      }

      if (!running) {
        running = [...root.querySelectorAll<HTMLElement>([
          '[aria-busy="true"]',
          "[data-streaming-response-status]",
        ].join(", "))].some(visible);
      }

      let rendered: HTMLElement | undefined;
      for (const candidate of root.querySelectorAll<HTMLElement>(".markdown")) rendered = candidate;
      // ChatGPT may keep the response-actions row hidden until hover or move it
      // behind responsive UI on smaller displays. DOM presence is the stable
      // completion signal; requiring the Copy button to be visibly laid out can
      // deadlock a finished turn on slower/smaller machines.
      const completionActionPresent = root.querySelector<HTMLElement>([
        'button[aria-label="Copy response"]',
        'button[data-testid="copy-turn-action-button"]',
      ].join(', ')) !== null;
      let traceBlocks: ChatGptVisibleTraceBlock[] = [];
      if (scanTraceBlocks) {
        const candidates = new Map<HTMLElement, "markdown" | "status">();
        const streamingContainers: HTMLElement[] = [];
        // Trace extraction is intentionally decoupled from the correctness poll.
        // Layout/visibility work is expensive on 2c/4t machines, while visible
        // commentary does not need sub-second freshness. Most polls now stop
        // after reading the tiny completion state above.
        root.querySelectorAll<HTMLElement>([
          ".markdown",
          "button",
          '[role="status"]',
          '[aria-busy="true"]',
          '[data-testid*="cot"]',
          '[data-testid*="reason"]',
          '[data-testid*="thought"]',
          "[data-streaming-response-status]",
        ].join(", ")).forEach(candidate => {
          if (candidate.hasAttribute("data-streaming-response-status")) {
            streamingContainers.push(candidate);
            return;
          }
          if (candidate.matches(".markdown")) {
            candidates.set(candidate, "markdown");
            return;
          }
          if (candidate.closest('[aria-label="Response actions"]')) return;
          const semantic = candidate.closest<HTMLElement>("button") ?? candidate;
          if (!candidates.has(semantic)) candidates.set(semantic, "status");
        });
        for (const container of streamingContainers) {
          let containsKnownCandidate = false;
          for (const candidate of candidates.keys()) {
            if (container.contains(candidate)) {
              containsKnownCandidate = true;
              break;
            }
          }
          if (!containsKnownCandidate) candidates.set(container, "status");
        }
        traceBlocks = [...candidates]
          // Long tool turns can accumulate hundreds of old trace controls. They
          // were observed on earlier polls, so avoid re-running layout/innerText
          // work across the entire historical DOM on every pass.
          .slice(-maxTraceCandidates)
          .filter(([candidate]) => visible(candidate))
          .map(([candidate, kind]) => ({
            kind,
            // The trailing Markdown root is the growing final answer. The trace
            // tracker intentionally never emits it, so do not serialize its full
            // text across the Playwright boundary on every poll. Keep an empty
            // sentinel so tracker ordering/"last markdown" semantics stay exact.
            text: candidate === rendered && pendingToolCount === 0 ? "" : (candidate.textContent ?? "").trim(),
            finalAnswer: candidate === rendered,
          }))
          .filter(block => block.finalAnswer || block.text.length > 0)
          .filter((block, index, blocks) => block.finalAnswer || (
            blocks.findIndex(other => !other.finalAnswer && other.kind === block.kind && other.text === block.text) === index
          ))
          .map(({ kind, text }) => ({ kind, text }));
      }
      // Final-answer text/HTML is large and grows monotonically. It is only
      // consumed once the response action is present, so defer all three large
      // DOM serializations until that condition holds. This removes the main
      // O(response-size × poll-count) IPC/GC cost on long requests.
      const completionText = completionActionPresent ? (rendered?.textContent ?? "").trim() : "";
      const completionSignature = completionText
        ? `${completionText.length}:${completionText.slice(0, 96)}:${completionText.slice(-192)}`
        : "";
      const visibleText = completionText.length <= 512 ? completionText : "";
      return {
        responsePresent: true,
        running,
        deliveryTimeoutPresent,
        toolConfirmationPresent,
        completionSignature,
        visibleText,
        visibleTextLength: completionText.length,
        completionActionPresent,
        traceBlocks,
      };
    }, {
      maxTraceCandidates: MAX_CHATGPT_TRACE_CANDIDATES,
      responseIndex,
      scanRecoverySignals,
      scanTraceBlocks,
      pendingToolCount,
    }).then(value => ({ ...value, probeSucceeded: true } satisfies ChatGptResponseDomSnapshot))
      .catch(() => absentResponseDomSnapshot(false));
    snapshot.traceBlocks = snapshot.traceBlocks.filter(block => !isChatGptTraceControl(block));
    return snapshot;
  }

  private async finalResponseHtml(page: Page, responseIndex: number): Promise<string | undefined> {
    return page.evaluate(responseIndex => {
      const root = document.querySelectorAll<HTMLElement>(
        '[data-testid^="conversation-turn-"][data-turn="assistant"]',
      )[responseIndex];
      if (!root) return undefined;
      const markdown = root.querySelectorAll<HTMLElement>(".markdown");
      return markdown.length > 0 ? markdown[markdown.length - 1]!.innerHTML : "";
    }, responseIndex).catch(() => undefined);
  }

  private async stalledTurnDiagnostic(page: Page, responseTurn: Locator): Promise<string> {
    const responseState = await responseTurn.count()
      ? await responseTurn.evaluate(element => {
        const root = element as HTMLElement;
        const descriptors = [...root.querySelectorAll<HTMLElement>("[role], [data-testid], button, [aria-label]")]
          .filter(candidate => {
            const style = getComputedStyle(candidate);
            return style.visibility !== "hidden" && style.display !== "none";
          })
          .slice(-80)
          .map(candidate => ({
            tag: candidate.tagName.toLowerCase(),
            role: candidate.getAttribute("role"),
            testId: candidate.getAttribute("data-testid"),
            ariaLabel: candidate.getAttribute("aria-label"),
            title: candidate.getAttribute("title"),
            text: (candidate.innerText ?? candidate.textContent ?? "").trim().slice(0, 500),
          }));
        return {
          text: (root.innerText ?? root.textContent ?? "").trim().slice(0, 2_000),
          descriptors,
        };
      })
      : { text: "", descriptors: [] };
    const overlays = await page.locator('[role="dialog"], [role="alert"], [role="status"]').evaluateAll(elements => (
      elements
        .filter(element => {
          const candidate = element as HTMLElement;
          const style = getComputedStyle(candidate);
          return style.visibility !== "hidden" && style.display !== "none";
        })
        .slice(-30)
        .map(element => {
          const candidate = element as HTMLElement;
          return {
            role: candidate.getAttribute("role"),
            testId: candidate.getAttribute("data-testid"),
            ariaLabel: candidate.getAttribute("aria-label"),
            text: (candidate.innerText ?? candidate.textContent ?? "").trim().slice(0, 1_000),
          };
        })
    )).catch(() => [] as Array<Record<string, string | null>>);
    return redactChatGptUiDiagnostic(JSON.stringify({ response: responseState, overlays }));
  }

  private async runExclusive(turn: BrowserTurn): Promise<string> {
    if (turn.abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    const prepared = await turn.prepare();
    let rendererTelemetry: ChatGptRendererTelemetry | undefined;
    let eventStream: ChatGptBrowserEventStream | undefined;
    const diagnostics = new ChatGptStreamDiagnostics(turn.traceId);
    try {
      if (turn.abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      const estimatedInputTokens = estimateCompiledChatGptWebInputTokens(prepared, turn.modelId);
      const inactivityBudgetMs = this.config.turnTimeoutMs;
      let deadline = Date.now() + inactivityBudgetMs;
      let schedulerGapExtensionRemainingMs = CHATGPT_MAX_SCHEDULER_GAP_EXTENSION_MS;
      const recordActivity = () => {
        deadline = Date.now() + inactivityBudgetMs;
        schedulerGapExtensionRemainingMs = CHATGPT_MAX_SCHEDULER_GAP_EXTENSION_MS;
      };
      const traceSources = new Map<string, { source: "dom" | "sse"; at: number; text: string }>();
      const emitTrace = (trace: ChatGptVisibleTraceEvent, source: "dom" | "sse") => {
        diagnostics.count(`${source}_${trace.kind}_observed`);
        const owner = traceSources.get(trace.kind);
        // Prefer the active source, but do not lock an entire 24h turn to a
        // network stream that can end/reconnect or a DOM block that can remount.
        if (owner && owner.source !== source) {
          if (owner.text === trace.text || Date.now() - owner.at < 10_000) return;
        }
        // SSE continuations are fragments: trimming each one joins words and
        // destroys whitespace at chunk boundaries. DOM blocks are whole text.
        const text = trace.continuation ? trace.text : stripChatGptTransportMarkers(trace.text);
        if (!text) return;
        traceSources.set(trace.kind, { source, at: Date.now(), text: trace.text });
        recordActivity();
        if (trace.kind === "commentary") turn.onCommentary?.(text, trace.continuation === true);
        else turn.onReasoningSummary?.(text, trace.continuation === true);
        diagnostics.count(`forwarded_${trace.kind}_chars`, text.length);
      };
      const page = await this.runStage(
        turn.traceId,
        "browser_page",
        browserStageTimeouts.browserPage,
        () => this.pageForNewTurn(),
        turn.abortSignal,
      );
      console.info(
        `[chatgpt-web] browser turn ${turn.traceId} opened (transport=inline, promptChars=${prepared.text.length}, estimatedInputTokens=${estimatedInputTokens}, images=${prepared.images.length})`,
      );
      await this.runStage(turn.traceId, "temporary_chat_navigation", browserStageTimeouts.navigation, () => (
        page.goto(CHATGPT_TEMPORARY_CHAT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 }).then(() => undefined)
      ), turn.abortSignal);
      await this.runStage(turn.traceId, "chat_surface_selection", browserStageTimeouts.navigation, () => (
        this.ensureRegularChatSurface(page)
      ), turn.abortSignal);
      await this.runStage(turn.traceId, "page_style", browserStageTimeouts.pageStyle, () => (
        this.applyLowPowerPageStyle(page)
      ), turn.abortSignal);
      const composer = page.getByRole("textbox", { name: "Chat with ChatGPT" });
      try {
        await this.runStage(turn.traceId, "composer_ready", browserStageTimeouts.composerReady, () => (
          composer.waitFor({ state: "visible", timeout: 30_000 })
        ), turn.abortSignal);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        const loginButtonVisible = await page.getByRole("button", { name: "Log in", exact: true })
          .isVisible()
          .catch(() => false);
        if (loginButtonVisible || isGoogleAccountSignInUrl(page.url())) {
          // A verification marker means "this stored state was authenticated"
          // rather than merely "a JSON file exists". Once the browser proves
          // the state is signed out, remove that marker so GUI/setup status
          // correctly requests a fresh normal-Chrome login.
          rmSync(loginVerificationMarkerPath(this.config.storageStatePath), { force: true });
          throw new Error(chatGptReauthenticationMessage(page.url()));
        }
        throw new Error("ChatGPT Temporary Chat did not produce a usable composer");
      }
      await this.runStage(turn.traceId, "session_verification", browserStageTimeouts.sessionVerification, async () => {
        await assertAuthenticatedChatGptPage(page);
        await assertTemporaryChatPage(page);
      }, turn.abortSignal);
      const mode = await this.runStage(turn.traceId, "effort_selection", browserStageTimeouts.effortSelection, () => (
        this.selectModelAndEffort(page, turn.modelId, turn.reasoning, turn.capabilities)
      ), turn.abortSignal);
      if (mode.localTools) {
        await this.runStage(
          turn.traceId,
          "personalization_selection",
          browserStageTimeouts.personalizationSelection,
          () => this.ensurePersonalizedTemporaryChat(page),
          turn.abortSignal,
        );
        if (chatGptRendererTelemetryEnabled()) {
          rendererTelemetry = new ChatGptRendererTelemetry(page, turn.traceId);
        }
        recordActivity();
        console.info("[chatgpt-web] tool-capable browser turn inactivity deadline=disabled");
      }
      await this.runStage(turn.traceId, "prompt_attachment", browserStageTimeouts.promptAttachment, () => (
        this.attachPrompt(page, prepared.text, mode.localTools)
      ), turn.abortSignal);
      await this.runStage(turn.traceId, "file_attachment", browserStageTimeouts.fileAttachment, () => (
        this.attachFiles(page, prepared, turn.abortSignal)
      ), turn.abortSignal);
      const userTurns = page.locator('[data-testid^="conversation-turn-"][data-turn="user"]');
      const responseTurns = page.locator('[data-testid^="conversation-turn-"][data-turn="assistant"]');
      eventStream = new ChatGptBrowserEventStream(delta => {
        if (turn.abortSignal?.aborted) return;
        if (delta.kind === "final") {
          recordActivity();
          // Hold provisional network text until browser completion is proven.
          // A Responses round may still yield a tool after its text, and a
          // partially decoded body must never replace the final rendered answer.
        } else emitTrace({ ...delta, kind: delta.kind }, "sse");
      }, diagnostics);
      await eventStream.start(page);
      let initialUserTurnCount = 0;
      let initialResponseTurnCount = 0;
      await this.runStage(turn.traceId, "send", browserStageTimeouts.send, async () => {
        [initialUserTurnCount, initialResponseTurnCount] = await Promise.all([
          userTurns.count(),
          responseTurns.count(),
        ]);
        await this.submitPrompt(
          page,
          prepared.text,
          mode.localTools,
          initialUserTurnCount,
          initialResponseTurnCount,
        );
      }, turn.abortSignal);
      const responseTurn = responseTurns.nth(initialResponseTurnCount);
      // Setup stages have their own bounded deadlines. Start the turn's
      // inactivity budget from the successful send, not from browser startup.
      recordActivity();

      let lastHeartbeat = 0;
      let finalText = "";
      let sawRunning = false;
      let loggedCompletionWait = false;
      let loggedInitialToolDomWait = false;
      let deliveryTimeoutRecoveries = 0;
      let sentAt = Date.now();
      let visibleTrace = new ChatGptVisibleTraceTracker();
      let markdownStream = new ChatGptMarkdownStream(stripChatGptTransportMarkers);
      let completionTracker = new ChatGptCompletionTracker();
      let previousPendingToolCount = 0;
      let previousRunning = false;
      let completionBlockedUntil = 0;
      let lastLoopAt = Date.now();
      let nextRecoverySignalScanAt = 0;
      let nextTraceScanAt = 0;
      let domHealthTracker = new ChatGptTurnDomHealthTracker(
        CHATGPT_RESPONSE_DOM_GRACE_MS,
        CHATGPT_EMPTY_RESPONSE_GRACE_MS,
        mode.localTools,
      );
      const waitForActivity = async (pendingToolCount: number, timeoutMs: number): Promise<void> => {
        if (mode.localTools && turn.waitForPendingToolCountChange) {
          await turn.waitForPendingToolCountChange(pendingToolCount, timeoutMs);
          return;
        }
        await new Promise(resolveSleep => setTimeout(resolveSleep, timeoutMs));
      };
      for (;;) {
        const loopNow = Date.now();
        const loopGapMs = loopNow - lastLoopAt;
        if (loopNow < lastLoopAt) {
          completionTracker.reset();
        } else {
          const gapExtensionMs = chatGptSchedulerGapExtension(
            loopGapMs,
            schedulerGapExtensionRemainingMs,
          );
          if (gapExtensionMs > 0) {
            // Preserve up to one hour across Windows sleep/CPU starvation, but
            // consume a finite allowance so recurrent slow renderer failures
            // cannot evade the browser-only outer inactivity deadline
            // indefinitely.
            deadline += gapExtensionMs;
            schedulerGapExtensionRemainingMs -= gapExtensionMs;
            completionTracker.reset();
          }
        }
        lastLoopAt = loopNow;
        if (turn.abortSignal?.aborted) {
          const stop = page.getByRole("button", { name: "Stop answering" });
          if (await stop.isVisible().catch(() => false)) await stop.click().catch(() => {});
          throw new DOMException("ChatGPT web turn aborted", "AbortError");
        }

        if (chatGptTurnInactivityExpired(mode.localTools, Date.now(), deadline)) {
          throw new Error("ChatGPT web turn made no observable progress before its inactivity deadline");
        }
        if (Date.now() - lastHeartbeat >= 10_000) {
          turn.onHeartbeat?.();
          lastHeartbeat = Date.now();
          diagnostics.report();
        }
        const pendingToolCount = mode.localTools
          ? Math.max(0, turn.pendingToolCount?.() ?? 0)
          : 0;
        if (pendingToolCount > 0) {
          completionTracker.reset();
          if (previousPendingToolCount === 0 || Date.now() >= nextTraceScanAt) {
            // A tool invocation can arrive immediately after a short Markdown
            // progress message. The normal pending-tool fast path used to skip
            // DOM/trace inspection entirely, so that commentary was never
            // surfaced to Codex before the tool cell. Capture exactly one trace
            // snapshot on the 0 -> pending transition. While a tool is pending,
            // the trailing Markdown root cannot be a completed final answer, so
            // the tracker may safely classify it as commentary.
            const traceSnapshot = await this.responseDomSnapshot(
              page,
              initialResponseTurnCount,
              false,
              true,
              pendingToolCount,
            );
            nextTraceScanAt = Date.now() + activePollingProfile.traceMs;
            if (traceSnapshot.responsePresent) {
              const transitionTrace = visibleTrace.observe(
                traceSnapshot.traceBlocks,
                traceSnapshot.completionActionPresent,
                Date.now(),
                pendingToolCount,
              );
              if (transitionTrace.length > 0) recordActivity();
              for (const trace of transitionTrace) {
                emitTrace(trace, "dom");
              }
            }
          }
          if (pendingToolCount !== previousPendingToolCount) recordActivity();
          await rendererTelemetry?.sample(
            previousPendingToolCount > 0 ? "tool-wait" : "tool-wait-start",
            pendingToolCount,
            previousPendingToolCount === 0,
          );
          previousPendingToolCount = pendingToolCount;
          // ChatGPT cannot make substantive progress until these local results
          // arrive. Avoid the expensive trace/layout snapshot entirely while
          // blocked. The broker wakes us immediately when the count changes;
          // the long timeout is only a fallback for old/non-evented runtimes.
          await waitForActivity(
            pendingToolCount,
            chatGptResponsePollInterval(pendingToolCount, activePollingProfile.responseMs),
          );
          continue;
        }
        if (previousPendingToolCount > 0) {
          await rendererTelemetry?.sample("tool-wait-end", 0, true);
          previousPendingToolCount = 0;
          completionTracker.reset();
          completionBlockedUntil = Date.now() + CHATGPT_POST_TOOL_COMPLETION_GRACE_MS;
          recordActivity();
        }

        const now = Date.now();
        const scanRecoverySignals = now >= nextRecoverySignalScanAt;
        if (scanRecoverySignals) nextRecoverySignalScanAt = now + activePollingProfile.recoveryMs;
        const scanTraceBlocks = now >= nextTraceScanAt;
        if (scanTraceBlocks) nextTraceScanAt = now + activePollingProfile.traceMs;
        const snapshot = await this.responseDomSnapshot(
          page,
          initialResponseTurnCount,
          scanRecoverySignals,
          scanTraceBlocks,
        );
        if (mode.localTools
          && snapshot.deliveryTimeoutPresent
          && await this.recoverMessageDeliveryTimeout(page, deliveryTimeoutRecoveries)) {
          deliveryTimeoutRecoveries += 1;
          finalText = "";
          sawRunning = false;
          previousRunning = false;
          loggedCompletionWait = false;
          loggedInitialToolDomWait = false;
          sentAt = Date.now();
          visibleTrace = new ChatGptVisibleTraceTracker();
          markdownStream = new ChatGptMarkdownStream(stripChatGptTransportMarkers);
          completionTracker = new ChatGptCompletionTracker();
          domHealthTracker = new ChatGptTurnDomHealthTracker(
            CHATGPT_RESPONSE_DOM_GRACE_MS,
            CHATGPT_EMPTY_RESPONSE_GRACE_MS,
            true,
          );
          recordActivity();
          await waitForActivity(0, activePollingProfile.responseMs);
          continue;
        }
        if (mode.localTools && snapshot.toolConfirmationPresent && await this.handleToolConfirmation(page)) {
          completionTracker.reset();
          recordActivity();
          await waitForActivity(0, activePollingProfile.responseMs);
          continue;
        }

        const running = snapshot.running;
        if (running) {
          sawRunning = true;
        }
        // A transition into or out of the browser's active-generation state is
        // observable progress. Merely polling the same stale control is not.
        if (snapshot.probeSucceeded && running !== previousRunning) {
          recordActivity();
          previousRunning = running;
        }
        if (snapshot.responsePresent) {
          const newTrace = visibleTrace.observe(snapshot.traceBlocks, snapshot.completionActionPresent);
          if (newTrace.length > 0) recordActivity();
          for (const trace of newTrace) {
            emitTrace(trace, "dom");
          }
          const domError = domHealthTracker.update({
            responsePresent: snapshot.responsePresent,
            running,
            currentText: snapshot.visibleTextLength > 0 ? "present" : "",
            completionActionPresent: snapshot.completionActionPresent || eventStream.decoder.finalComplete,
            probeSucceeded: snapshot.probeSucceeded,
          });
          if (domError) throw new Error(domError);
          const completionState = {
            responsePresent: snapshot.responsePresent,
            running,
            currentText: snapshot.completionSignature,
            completionActionPresent: snapshot.completionActionPresent || eventStream.decoder.finalComplete,
          };
          let completionReady = false;
          if (Date.now() >= completionBlockedUntil) {
            completionReady = completionTracker.update(completionState);
          } else {
            completionTracker.reset();
          }
          if (completionReady) {
            // A tool can queue while the awaited DOM snapshot is running. Never
            // turn the stale pre-tool action row into end_turn=true.
            const pendingBeforeFinalize = mode.localTools
              ? Math.max(0, turn.pendingToolCount?.() ?? 0)
              : 0;
            if (pendingBeforeFinalize > 0) {
              completionTracker.reset();
              previousPendingToolCount = pendingBeforeFinalize;
              continue;
            }
            if (snapshot.visibleText === "api_tool unavailable") {
              throw new Error("ChatGPT selected mode rejected the Codex Native MCP tool (api_tool unavailable)");
            }
            const finalHtml = await this.finalResponseHtml(page, initialResponseTurnCount);
            const pendingAfterFinalize = mode.localTools
              ? Math.max(0, turn.pendingToolCount?.() ?? 0)
              : 0;
            if (pendingAfterFinalize > 0) {
              completionTracker.reset();
              previousPendingToolCount = pendingAfterFinalize;
              continue;
            }
            // The response root may remount between the lightweight snapshot
            // and final serialization. Retry instead of turning that race into
            // a fatal empty-answer error.
            if (finalHtml === undefined) {
              completionTracker.reset();
              await waitForActivity(0, activePollingProfile.responseMs);
              continue;
            }
            if (mode.localTools && turn.hasBoundTurn && !turn.hasBoundTurn()) {
              throw new Error(
                `ChatGPT completed without binding connector ${JSON.stringify(this.config.appName)} to the active Codex environment. `
                + "No native connection was established. Verify that this connector uses this desktop's tunnel and refresh its tools while the session is running.",
              );
            }
            const final = markdownStream.finish(finalHtml);
            if (!final.markdown && snapshot.visibleTextLength > 0) {
              throw new Error("ChatGPT completed with visible text that could not be serialized as Markdown");
            }
            if (final.delta) {
              turn.onTextDelta(final.delta);
              diagnostics.count("forwarded_final_chars", final.delta.length);
              diagnostics.count("dom_final_answers");
            }
            finalText = final.markdown;
            break;
          }
          if (!loggedCompletionWait && Date.now() - sentAt >= 30_000) {
            loggedCompletionWait = true;
            const diagnostic = await this.stalledTurnDiagnostic(page, responseTurn).catch(error => JSON.stringify({
              diagnosticError: error instanceof Error ? error.message : String(error),
            }));
            console.warn(
              `[chatgpt-web] waiting for completed-turn evidence (running=${running}, sawRunning=${sawRunning}, textChars=${snapshot.visibleTextLength}, completionActionPresent=${snapshot.completionActionPresent}, ui=${diagnostic})`,
            );
          }
        } else {
          const domError = domHealthTracker.update({
            responsePresent: false,
            running,
            currentText: "",
            completionActionPresent: false,
            probeSucceeded: snapshot.probeSucceeded,
          });
          if (domError) throw new Error(domError);

          if (mode.localTools
            && !loggedInitialToolDomWait
            && Date.now() - sentAt >= CHATGPT_RESPONSE_DOM_GRACE_MS) {
            loggedInitialToolDomWait = true;
            console.info(
              "[chatgpt-web] browser turn "
              + turn.traceId
              + " is still active before first assistant DOM; allowing Codex Native tool phase to continue",
            );
          }
        }
        const nextPendingToolCount = mode.localTools
          ? Math.max(0, turn.pendingToolCount?.() ?? 0)
          : 0;
        await waitForActivity(
          nextPendingToolCount,
          chatGptResponsePollInterval(nextPendingToolCount, activePollingProfile.responseMs),
        );
      }

      if (this.context) {
        const state = await this.context.storageState();
        const stateJson = `${JSON.stringify(state)}\n`;
        if (stateJson !== this.lastStorageStateJson) {
          atomicWriteFile(this.config.storageStatePath, stateJson);
          this.lastStorageStateJson = stateJson;
        }
      }
      console.info(`[chatgpt-web] browser turn ${turn.traceId} completed (markdownChars=${finalText.length})`);
      return finalText;
    } finally {
      await eventStream?.close();
      diagnostics.report(true);
      await rendererTelemetry?.close();
      prepared.release();
    }
  }
}

export async function closeChatGptBrowserWorkers(): Promise<void> {
  const active = [...new Set(workers.values())];
  workers.clear();
  await Promise.all(active.map(worker => worker.close()));
  const browsers = [...new Set(sharedBrowsers.values())];
  sharedBrowsers.clear();
  await Promise.all(browsers.map(browser => browser.close()));
}
