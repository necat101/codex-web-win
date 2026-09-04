import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { AdapterEvent, CodexParsedRequest } from "../../types";
import type { BrokerToolRequest } from "./turn-broker";
import { extractChatGptTurnIdentity } from "./environment";

const MAX_ACTIVE_ROUND_EVENTS = 100_000;
const MAX_ACTIVE_ROUND_BYTES = 16 * 1024 * 1024;

export type ChatGptBrowserOutcome =
  | { type: "final"; answer: string }
  | { type: "error"; error: Error };

export interface ChatGptTraceEvent {
  kind: "reasoning" | "commentary";
  text: string;
  continuation?: boolean;
}

interface TraceWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class ChatGptTraceFeed {
  private queued: ChatGptTraceEvent[] = [];
  private readonly waiters = new Set<TraceWaiter>();

  push(event: ChatGptTraceEvent): void {
    const normalized = event.continuation ? event.text : event.text.trim();
    if (!normalized) return;
    const normalizedEvent = { ...event, text: normalized };
    this.queued.push(normalizedEvent);
    const waiter = this.waiters.values().next().value as TraceWaiter | undefined;
    if (!waiter) return;
    this.waiters.delete(waiter);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.resolve();
  }

  drain(): ChatGptTraceEvent[] {
    const queued = this.queued;
    this.queued = [];
    return queued;
  }

  wait(signal?: AbortSignal): Promise<void> {
    if (this.queued.length > 0) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(new DOMException("trace wait aborted", "AbortError"));
    return new Promise<void>((resolveWait, rejectWait) => {
      const waiter: TraceWaiter = { resolve: resolveWait, reject: rejectWait, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          this.waiters.delete(waiter);
          rejectWait(new DOMException("trace wait aborted", "AbortError"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.add(waiter);
    });
  }

  /** Compatibility helper. Adapter streaming uses notification-only `wait` so abort races cannot consume an event. */
  async next(signal?: AbortSignal): Promise<ChatGptTraceEvent> {
    await this.wait(signal);
    const queued = this.queued.shift();
    if (queued === undefined) throw new Error("ChatGPT trace notification arrived without a queued event");
    return queued;
  }
}

interface TextWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface HeartbeatWaiter {
  after: number;
  resolve: (sequence: number) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** Monotonic browser-loop liveness notifications; observations are non-destructive. */
export class ChatGptHeartbeatFeed {
  private sequence = 0;
  private readonly waiters = new Set<HeartbeatWaiter>();

  pulse(): void {
    this.sequence += 1;
    for (const waiter of [...this.waiters]) {
      if (waiter.after >= this.sequence) continue;
      this.waiters.delete(waiter);
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(this.sequence);
    }
  }

  value(): number {
    return this.sequence;
  }

  wait(after: number, signal?: AbortSignal): Promise<number> {
    if (this.sequence > after) return Promise.resolve(this.sequence);
    if (signal?.aborted) return Promise.reject(new DOMException("heartbeat wait aborted", "AbortError"));
    return new Promise<number>((resolveWait, rejectWait) => {
      const waiter: HeartbeatWaiter = { after, resolve: resolveWait, reject: rejectWait, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          this.waiters.delete(waiter);
          rejectWait(new DOMException("heartbeat wait aborted", "AbortError"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.add(waiter);
      if (this.sequence > after) {
        this.waiters.delete(waiter);
        if (signal && waiter.onAbort) signal.removeEventListener("abort", waiter.onAbort);
        resolveWait(this.sequence);
      }
    });
  }
}

/** Append-only browser Markdown feed. Waiters are notifications; `drain` owns consumption. */
export class ChatGptTextFeed {
  private queued: string[] = [];
  private readonly waiters = new Set<TextWaiter>();
  private readonly textChunks: string[] = [];
  private cachedText?: string;

  push(delta: string): void {
    if (!delta) return;
    // Keep deltas as chunks while the browser is streaming. Repeatedly doing
    // `text += delta` makes a long answer form an ever-growing string/rope that
    // eventually has to be flattened; joining once at settlement is cheaper and
    // keeps peak copying lower on memory-constrained machines.
    this.textChunks.push(delta);
    this.cachedText = undefined;
    this.queued.push(delta);
    const waiter = this.waiters.values().next().value as TextWaiter | undefined;
    if (!waiter) return;
    this.waiters.delete(waiter);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.resolve();
  }

  drain(): string[] {
    const queued = this.queued;
    this.queued = [];
    return queued;
  }

  value(): string {
    return this.cachedText ??= this.textChunks.join("");
  }

  wait(signal?: AbortSignal): Promise<void> {
    if (this.queued.length > 0) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(new DOMException("text wait aborted", "AbortError"));
    return new Promise<void>((resolveWait, rejectWait) => {
      const waiter: TextWaiter = { resolve: resolveWait, reject: rejectWait, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          this.waiters.delete(waiter);
          rejectWait(new DOMException("text wait aborted", "AbortError"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.add(waiter);
    });
  }
}

interface ChatGptTurnRuntimeBase {
  browser: Promise<string>;
  heartbeat: ChatGptHeartbeatFeed;
  trace: ChatGptTraceFeed;
  text: ChatGptTextFeed;
  cancel: () => void;
}

export type ChatGptTurnRuntime =
  | (ChatGptTurnRuntimeBase & { mode: "tools"; token: Promise<string> })
  | (ChatGptTurnRuntimeBase & { mode: "read-only" });

export function chatGptTurnExecutionKey(parsed: CodexParsedRequest): string {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.turnId && !parsed._compactionRequest) {
    throw new Error("ChatGPT web requires native Codex turn_id metadata for browser-session replay");
  }
  // Compaction is an independent summarizer exchange. Some Codex compact
  // transports omit turn_id, and a v2 compaction subrequest may reuse the parent
  // turn id. Give it a distinct deterministic key so it never reattaches to an
  // in-flight browser/tool session for the real task turn.
  const payload = parsed._compactionRequest
    ? {
        compaction: true,
        threadId: identity.threadId,
        turnId: identity.turnId,
        requestHash: createHash("sha256").update(JSON.stringify(parsed._rawBody ?? {})).digest("hex"),
      }
    : {
        threadId: identity.threadId,
        turnId: identity.turnId,
        contextCompactionEpoch: parsed._contextCompactionEpoch ?? null,
      };
  return createHash("sha256").update(JSON.stringify({
    modelId: parsed.modelId,
    reasoning: parsed.options.reasoning,
    payload,
  })).digest("hex");
}

/**
 * Stable identity for every browser runtime that belongs to one native Codex
 * turn. Context compaction intentionally changes the execution key so the
 * compacted history starts in a fresh ChatGPT conversation, but it must not
 * create a second live runtime behind the first one on the serialized browser
 * lane.
 */
export function chatGptTurnExecutionFamilyKey(parsed: CodexParsedRequest): string {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.turnId && !parsed._compactionRequest) {
    throw new Error("ChatGPT web requires native Codex turn_id metadata for browser-session replay");
  }
  const payload = parsed._compactionRequest
    ? {
        compaction: true,
        threadId: identity.threadId,
        turnId: identity.turnId,
        requestHash: createHash("sha256").update(JSON.stringify(parsed._rawBody ?? {})).digest("hex"),
      }
    : {
        threadId: identity.threadId,
        turnId: identity.turnId,
      };
  return createHash("sha256").update(JSON.stringify({
    modelId: parsed.modelId,
    reasoning: parsed.options.reasoning,
    payload,
  })).digest("hex");
}

export class ChatGptTurnSession {
  readonly browserOutcome: Promise<ChatGptBrowserOutcome>;
  private readonly outstandingById = new Map<string, BrokerToolRequest>();
  private readonly deliveredResultIds = new Set<string>();
  private stagedToolBatch?: BrokerToolRequest[];
  private outstandingReasoning: string[] = [];
  private finalReasoning: string[] = [];
  private outstandingPrelude: AdapterEvent[] = [];
  private finalPrelude: AdapterEvent[] = [];
  private activeRound?: { events: AdapterEvent[]; reasoning: string[]; bytes: number };
  private settledBrowserOutcome?: ChatGptBrowserOutcome;
  private tail: Promise<void> = Promise.resolve();

  constructor(readonly runtime: ChatGptTurnRuntime, readonly createdAt = Date.now()) {
    this.browserOutcome = runtime.browser
      .then(answer => ({ type: "final", answer }) as ChatGptBrowserOutcome)
      .catch(error => ({ type: "error", error: error instanceof Error ? error : new Error(String(error)) }) as ChatGptBrowserOutcome)
      .then(outcome => {
      this.settledBrowserOutcome = outcome;
      return outcome;
    });
  }

  runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  outstanding(): BrokerToolRequest[] {
    return [...this.outstandingById.values()];
  }

  settledOutcome(): ChatGptBrowserOutcome | undefined {
    return this.settledBrowserOutcome;
  }

  isActive(): boolean {
    return this.settledBrowserOutcome === undefined;
  }

  /**
   * Begin one provider round, or resume the journal left by a detached HTTP/SSE request.
   * Returns true only for a new round so one-shot prelude events are not appended twice.
   */
  beginActiveRound(): boolean {
    if (this.activeRound) return false;
    this.activeRound = { events: [], reasoning: [], bytes: 0 };
    return true;
  }

  appendActiveRoundEvent(event: AdapterEvent, reasoning?: string): void {
    if (!this.activeRound) throw new Error("cannot append an event before beginning the ChatGPT provider round");
    const eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
    const reasoningBytes = reasoning ? Buffer.byteLength(reasoning, "utf8") : 0;
    const nextBytes = this.activeRound.bytes + eventBytes + reasoningBytes;
    if (this.activeRound.events.length >= MAX_ACTIVE_ROUND_EVENTS || nextBytes > MAX_ACTIVE_ROUND_BYTES) {
      throw new Error("ChatGPT browser replay journal exceeded its bounded 16 MiB/100000-event limit");
    }
    this.activeRound.events.push(event);
    if (reasoning !== undefined) this.activeRound.reasoning.push(reasoning);
    this.activeRound.bytes = nextBytes;
  }

  eventsForActiveRoundReplay(): AdapterEvent[] {
    return [...(this.activeRound?.events ?? [])];
  }

  reasoningForActiveRoundReplay(): string[] {
    return [...(this.activeRound?.reasoning ?? [])];
  }

  clearActiveRound(): void {
    this.activeRound = undefined;
  }

  stageToolBatch(requests: BrokerToolRequest[]): void {
    if (this.stagedToolBatch || this.outstandingById.size > 0) {
      throw new Error("cannot stage a ChatGPT tool batch while another batch is pending");
    }
    this.stagedToolBatch = [...requests];
  }

  stagedTools(): BrokerToolRequest[] {
    return [...(this.stagedToolBatch ?? [])];
  }

  takeStagedToolBatch(): BrokerToolRequest[] {
    const requests = this.stagedToolBatch;
    if (!requests) throw new Error("ChatGPT tool batch was delivered without being staged");
    this.stagedToolBatch = undefined;
    return requests;
  }

  setOutstanding(requests: BrokerToolRequest[], reasoning: string[] = [], prelude: AdapterEvent[] = []): void {
    if (this.outstandingById.size > 0) throw new Error("cannot emit a new ChatGPT tool batch while the previous batch is unresolved");
    for (const request of requests) {
      if (this.deliveredResultIds.has(request.callId) || this.outstandingById.has(request.callId)) {
        throw new Error(`duplicate ChatGPT bridge tool call id: ${request.callId}`);
      }
      this.outstandingById.set(request.callId, request);
    }
    this.outstandingReasoning = [...reasoning];
    this.outstandingPrelude = [...prelude];
  }

  hasOutstanding(callId: string): boolean {
    return this.outstandingById.has(callId);
  }

  markResultDelivered(callId: string): void {
    if (!this.outstandingById.delete(callId)) throw new Error(`ChatGPT bridge tool result does not match an outstanding call: ${callId}`);
    this.deliveredResultIds.add(callId);
    if (this.outstandingById.size === 0) {
      this.outstandingReasoning = [];
      this.outstandingPrelude = [];
    }
  }

  reasoningForOutstandingReplay(): string[] {
    return [...this.outstandingReasoning];
  }

  eventsForOutstandingReplay(): AdapterEvent[] {
    return [...this.outstandingPrelude];
  }

  setFinalReasoning(reasoning: string[]): void {
    this.finalReasoning = [...reasoning];
  }

  reasoningForFinalReplay(): string[] {
    return [...this.finalReasoning];
  }

  setFinalEvents(events: AdapterEvent[]): void {
    this.finalPrelude = [...events];
  }

  eventsForFinalReplay(): AdapterEvent[] {
    return [...this.finalPrelude];
  }

  cancel(): void {
    this.runtime.cancel();
  }
}

export class ChatGptTurnSessions {
  private readonly entries = new Map<string, ChatGptTurnSession>();
  private readonly familyByKey = new Map<string, string>();
  private readonly currentKeyByFamily = new Map<string, string>();
  private readonly retiredAtByKey = new Map<string, number>();

  constructor(
    private readonly settledRetentionMs = 4 * 60 * 60_000,
    private readonly maxEntries = 256,
    private readonly now: () => number = Date.now,
  ) {}

  getOrCreate(
    key: string,
    start: () => ChatGptTurnRuntime,
    familyKey = key,
  ): ChatGptTurnSession {
    this.prune();
    const existing = this.entries.get(key);
    if (existing) {
      const existingFamily = this.familyByKey.get(key);
      if (existingFamily !== undefined && existingFamily !== familyKey) {
        throw new Error("ChatGPT web execution key was reused across different native turn families");
      }
      this.familyByKey.set(key, familyKey);
      this.currentKeyByFamily.set(familyKey, key);
      return existing;
    }
    if (this.retiredAtByKey.has(key)) {
      throw new Error("ChatGPT web request belongs to a retired pre-compaction browser epoch");
    }

    // A context-compaction epoch has a new execution key but the same logical
    // native turn family. The old browser run can be waiting forever for a tool
    // result that Codex replaced with compacted history. Cancel it before
    // starting the fresh run so the singleton worker's serialized tail is
    // released and the stale broker capabilities are revoked.
    const previousKey = this.currentKeyByFamily.get(familyKey);
    if (previousKey !== undefined && previousKey !== key) {
      console.info("[chatgpt-web] replacing superseded browser runtime at native context-compaction boundary");
      this.retire(previousKey);
      this.delete(previousKey, true);
    }

    if (this.entries.size >= this.maxEntries) throw new Error(`ChatGPT web session registry is full (${this.maxEntries} entries)`);
    const session = new ChatGptTurnSession(start(), this.now());
    this.entries.set(key, session);
    this.familyByKey.set(key, familyKey);
    this.currentKeyByFamily.set(familyKey, key);
    return session;
  }

  clear(): number {
    const cancelled = this.entries.size;
    for (const session of this.entries.values()) session.cancel();
    this.entries.clear();
    this.familyByKey.clear();
    this.currentKeyByFamily.clear();
    this.retiredAtByKey.clear();
    return cancelled;
  }

  activeCount(): number {
    this.prune();
    let active = 0;
    for (const session of this.entries.values()) if (session.isActive()) active += 1;
    return active;
  }

  private prune(): void {
    const cutoff = this.now() - this.settledRetentionMs;
    for (const [key, retiredAt] of this.retiredAtByKey) {
      if (retiredAt < cutoff) this.retiredAtByKey.delete(key);
    }
    for (const [key, session] of this.entries) {
      // This is replay/cache retention only. Active sessions are never aged
      // out and can end only through their own completion or explicit cancel.
      if (session.createdAt >= cutoff || session.isActive()) continue;
      this.delete(key, true);
    }
  }

  private retire(key: string): void {
    // Refresh insertion order if an already-known key is encountered, then
    // keep the tombstone set bounded independently from the active registry.
    this.retiredAtByKey.delete(key);
    this.retiredAtByKey.set(key, this.now());
    const maxRetiredEntries = Math.max(16, this.maxEntries * 4);
    while (this.retiredAtByKey.size > maxRetiredEntries) {
      const oldest = this.retiredAtByKey.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.retiredAtByKey.delete(oldest);
    }
  }

  private delete(key: string, cancel: boolean): void {
    const session = this.entries.get(key);
    if (!session) return;
    if (cancel) session.cancel();
    this.entries.delete(key);
    const familyKey = this.familyByKey.get(key);
    this.familyByKey.delete(key);
    if (familyKey !== undefined && this.currentKeyByFamily.get(familyKey) === key) {
      this.currentKeyByFamily.delete(familyKey);
    }
  }
}

export const chatGptTurnSessions = new ChatGptTurnSessions();
