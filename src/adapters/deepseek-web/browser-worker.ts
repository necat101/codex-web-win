import { existsSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { atomicWriteFile, defaultChromeExecutable, expandUserPath } from "../../config";
import { deepSeekLoginVerificationMarkerPath } from "../../deepseek-browser-login";
import {
  assertAuthenticatedDeepSeekPage,
  DEEPSEEK_COMPOSER_SELECTOR,
  DEEPSEEK_HOME_URL,
  deepSeekComposer,
  deepSeekSecurityChallenge,
  deepSeekSignInUrl,
} from "../../deepseek-session";
import type { DeepSeekWebAdapterMode } from "../../deepseek-web-models";
import { childProcessEnvironment } from "../../process";
import type { CodexProviderConfig } from "../../types";
import { browserComposerTextMatches, normalizeBrowserComposerText } from "../composer-text";
import { chatGptHtmlToMarkdown } from "../chatgpt-web/markdown";

const workers = new Map<string, DeepSeekBrowserWorker>();

export const DEFAULT_DEEPSEEK_TURN_TIMEOUT_MS = 2 * 60 * 60_000;
export const DEEPSEEK_BROWSER_LAUNCH_TIMEOUT_MS = 60_000;
export const DEEPSEEK_RESPONSE_POLL_MS = 100;
export const DEEPSEEK_RETRY_COOLDOWN_MS = 2_000;
// DeepSeek can briefly expose its normal response actions between generation
// phases. Treat those controls as useful evidence, but never as a 300 ms
// fast-path to completion: doing so can hand the turn back to Codex while the
// browser is about to resume rendering the same response.
export const DEEPSEEK_COMPLETION_STABLE_MS = 1_500;
export const DEEPSEEK_COMPLETION_FALLBACK_STABLE_MS = 2_500;
export const DEEPSEEK_MAX_COMPLETION_OBSERVATION_GAP_MS = 3_500;
export const DEEPSEEK_RESPONSE_DOM_GRACE_MS = 60_000;
export const DEEPSEEK_RUNNING_WITHOUT_RESPONSE_GRACE_MS = 10 * 60_000;
export const DEEPSEEK_UNCHANGED_RUNNING_RESPONSE_GRACE_MS = 10 * 60_000;
export const DEEPSEEK_EMPTY_RESPONSE_GRACE_MS = 15_000;
export const DEEPSEEK_DOM_PROBE_GRACE_MS = 60_000;
export const DEEPSEEK_WATCHDOG_OBSERVATION_GAP_MS = 10_000;
export const DEEPSEEK_REPLAY_TTL_MS = 10 * 60_000;
export const DEEPSEEK_MAX_RETRY_CLICKS = 3;

export interface DeepSeekBrowserTurn {
  traceId: string;
  mode: DeepSeekWebAdapterMode;
  prompt: string;
  conversationKey?: string;
  continuationPrompt?: string;
  continueFromTraceId?: string;
  followUpPrompt?: string;
  abortSignal?: AbortSignal;
  onHeartbeat?: () => void;
  onTextDelta: (delta: string) => void;
}

export interface DeepSeekBrowserResult {
  markdown: string;
  rawText: string;
  inputText: string;
}

interface ResolvedDeepSeekBrowserConfig {
  storageStatePath: string;
  chromeExecutablePath: string;
  turnTimeoutMs: number;
  headed: boolean;
}

export interface DeepSeekResponseSnapshot {
  probeSucceeded: boolean;
  responsePresent: boolean;
  running: boolean;
  retryActionPresent: boolean;
  completionActionPresent: boolean;
  composerReady: boolean;
  finalHtml: string;
  finalText: string;
  /**
   * Renderer-faithful text used for tool-call parsing. Unlike innerText, this
   * keeps DeepSeek tool wrapper tags when the browser turns them into real DOM
   * elements instead of displaying the markup literally.
   */
  finalRawText?: string;
  /** DOM position of the latest assistant response, used to distinguish a new
   * continuation bubble even when DeepSeek repeats byte-identical text. */
  responseIdentity?: string;
  finalTextLength: number;
  activitySignature: string;
  blockedText?: string;
}

/**
 * A continuation must produce observable new assistant content before its
 * completion tracker is allowed to settle. Merely seeing the running control is
 * not sufficient: that control can disappear during a renderer handoff while
 * the DOM still points at the previous assistant response.
 */
export function deepSeekContinuationResponseChanged(
  baseline: DeepSeekResponseSnapshot,
  current: DeepSeekResponseSnapshot,
): boolean {
  return current.responsePresent && (
    current.responseIdentity !== baseline.responseIdentity
    || current.finalHtml !== baseline.finalHtml
    || current.finalText !== baseline.finalText
    || current.finalRawText !== baseline.finalRawText
  );
}

/**
 * Once Enter has been pressed, a transport/UI failure is never safe to retry
 * automatically: DeepSeek may have accepted the prompt even if the harness did
 * not observe the acknowledgement. Preserve that fact across adapter layers so
 * Codex cannot turn one ambiguous submission into a duplicate-send loop.
 */
export class DeepSeekBrowserTurnFailure extends Error {
  readonly submissionAttempted: boolean;

  constructor(message: string, submissionAttempted: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = "DeepSeekBrowserTurnFailure";
    this.submissionAttempted = submissionAttempted;
  }
}

export class DeepSeekCompletionTracker {
  private candidate?: { signature: string; since: number; explicit: boolean };
  private lastObservedAt?: number;

  constructor(
    private readonly stableMs = DEEPSEEK_COMPLETION_STABLE_MS,
    private readonly maxObservationGapMs = DEEPSEEK_MAX_COMPLETION_OBSERVATION_GAP_MS,
    private readonly fallbackStableMs = DEEPSEEK_COMPLETION_FALLBACK_STABLE_MS,
  ) {}

  reset(): void {
    this.candidate = undefined;
    this.lastObservedAt = undefined;
  }

  update(state: DeepSeekResponseSnapshot, now = Date.now()): boolean {
    if (this.lastObservedAt !== undefined
      && (now < this.lastObservedAt || now - this.lastObservedAt >= this.maxObservationGapMs)) {
      this.candidate = undefined;
    }
    this.lastObservedAt = now;

    const eligible = state.probeSucceeded
      && state.responsePresent
      && !state.running
      && !state.retryActionPresent
      && state.composerReady
      && state.finalTextLength > 0;
    if (!eligible) {
      this.candidate = undefined;
      return false;
    }

    const signature = state.activitySignature;
    const explicit = state.completionActionPresent;
    if (this.candidate?.signature !== signature || this.candidate.explicit !== explicit) {
      this.candidate = { signature, since: now, explicit };
      return false;
    }
    return now - this.candidate.since >= (explicit ? this.stableMs : this.fallbackStableMs);
  }
}

/**
 * Bound DeepSeek's in-page busy recovery without ever resubmitting the user's
 * prompt. A click is consumed only after the visible Retry control accepted a
 * click; once exhausted, the browser turn fails through the normal post-submit
 * non-retryable path instead of clicking forever.
 */
export class DeepSeekRetryClickBudget {
  private clicks = 0;

  constructor(readonly limit = DEEPSEEK_MAX_RETRY_CLICKS) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError("DeepSeek Retry click limit must be a positive integer");
    }
  }

  get used(): number {
    return this.clicks;
  }

  get exhausted(): boolean {
    return this.clicks >= this.limit;
  }

  recordClick(): number {
    if (this.exhausted) throw new Error("DeepSeek Retry click budget is exhausted");
    this.clicks += 1;
    return this.clicks;
  }
}

export class DeepSeekTurnDomHealthTracker {
  private sawResponse = false;
  private missingResponseSince?: number;
  private runningWithoutResponseSince?: number;
  private runningResponseCandidate?: { text: string; rawText: string; since: number };
  private emptyCompletionSince?: number;
  private probeFailureSince?: number;
  private lastObservedAt?: number;

  constructor(
    private readonly missingResponseMs = DEEPSEEK_RESPONSE_DOM_GRACE_MS,
    private readonly emptyCompletionMs = DEEPSEEK_EMPTY_RESPONSE_GRACE_MS,
    private readonly probeFailureMs = DEEPSEEK_DOM_PROBE_GRACE_MS,
    private readonly maxObservationGapMs = DEEPSEEK_WATCHDOG_OBSERVATION_GAP_MS,
    private readonly runningWithoutResponseMs = DEEPSEEK_RUNNING_WITHOUT_RESPONSE_GRACE_MS,
    private readonly unchangedRunningResponseMs = DEEPSEEK_UNCHANGED_RUNNING_RESPONSE_GRACE_MS,
  ) {}

  update(state: DeepSeekResponseSnapshot, now = Date.now()): string | undefined {
    if (this.lastObservedAt !== undefined
      && (now < this.lastObservedAt || now - this.lastObservedAt >= this.maxObservationGapMs)) {
      this.missingResponseSince = undefined;
      this.runningWithoutResponseSince = undefined;
      this.runningResponseCandidate = undefined;
      this.emptyCompletionSince = undefined;
      this.probeFailureSince = undefined;
    }
    this.lastObservedAt = now;

    if (!state.probeSucceeded) {
      this.probeFailureSince ??= now;
      if (now - this.probeFailureSince >= this.probeFailureMs) {
        return "DeepSeek Web response DOM could not be inspected continuously";
      }
      return undefined;
    }
    this.probeFailureSince = undefined;

    if (state.responsePresent) {
      this.sawResponse = true;
      this.missingResponseSince = undefined;
      this.runningWithoutResponseSince = undefined;
    } else if (state.running) {
      this.missingResponseSince = undefined;
      this.runningWithoutResponseSince ??= now;
      if (now - this.runningWithoutResponseSince >= this.runningWithoutResponseMs) {
        return "DeepSeek Web remained active without a readable response DOM beyond the recovery window";
      }
    } else {
      this.runningWithoutResponseSince = undefined;
      this.missingResponseSince ??= now;
      if (now - this.missingResponseSince >= this.missingResponseMs) {
        return this.sawResponse
          ? "DeepSeek Web response DOM disappeared while the browser turn was active"
          : "DeepSeek Web did not create a response DOM after the message was sent";
      }
    }

    if (state.responsePresent && state.running) {
      // Track literal assistant output rather than the broader DOM activity
      // signature. Spinner/control churn is not semantic progress and must not
      // keep a frozen partial response alive indefinitely.
      const rawText = state.finalRawText ?? "";
      if (this.runningResponseCandidate?.text !== state.finalText
        || this.runningResponseCandidate.rawText !== rawText) {
        this.runningResponseCandidate = { text: state.finalText, rawText, since: now };
      } else if (now - this.runningResponseCandidate.since >= this.unchangedRunningResponseMs) {
        return "DeepSeek Web remained active with an unchanged partial response beyond the recovery window";
      }
    } else {
      this.runningResponseCandidate = undefined;
    }

    const emptyCompletion = state.responsePresent
      && !state.running
      && state.completionActionPresent
      && state.finalTextLength === 0;
    if (!emptyCompletion) {
      this.emptyCompletionSince = undefined;
    } else {
      this.emptyCompletionSince ??= now;
      if (now - this.emptyCompletionSince >= this.emptyCompletionMs) {
        return "DeepSeek Web completed without a readable final answer";
      }
    }
    return undefined;
  }
}

function resolvedConfig(provider: CodexProviderConfig): ResolvedDeepSeekBrowserConfig {
  const config = provider.deepseekWeb;
  if (!config?.enabled) throw new Error("DeepSeek Web is not enabled");
  if (!config.storageStatePath) throw new Error("DeepSeek Web storage state path is missing");
  return {
    storageStatePath: expandUserPath(config.storageStatePath),
    chromeExecutablePath: expandUserPath(config.chromeExecutablePath ?? defaultChromeExecutable()),
    turnTimeoutMs: config.turnTimeoutMs ?? DEFAULT_DEEPSEEK_TURN_TIMEOUT_MS,
    headed: config.headed ?? true,
  };
}

function abortError(): DOMException {
  return new DOMException("DeepSeek Web turn aborted", "AbortError");
}

export class DeepSeekBrowserWorker {
  private readonly config: ResolvedDeepSeekBrowserConfig;
  private browser?: Browser;
  private sessionContext?: BrowserContext;
  private sessionPage?: Page;
  private activeContext?: BrowserContext;
  private readonly cancelledContexts = new WeakSet<BrowserContext>();
  private readonly inFlight = new Map<string, Promise<DeepSeekBrowserResult>>();
  private readonly recentOutcomes = new Map<string, {
    expiresAt: number;
    answer?: DeepSeekBrowserResult;
    error?: unknown;
  }>();
  private conversationTraceId?: string;
  private conversationKey?: string;
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(provider: CodexProviderConfig) {
    this.config = resolvedConfig(provider);
  }

  static forProvider(provider: CodexProviderConfig): DeepSeekBrowserWorker {
    const config = resolvedConfig(provider);
    const key = JSON.stringify(config);
    let worker = workers.get(key);
    if (!worker) {
      worker = new DeepSeekBrowserWorker(provider);
      workers.set(key, worker);
    }
    return worker;
  }

  run(turn: DeepSeekBrowserTurn): Promise<DeepSeekBrowserResult> {
    if (this.closed) return Promise.reject(new Error("DeepSeek Web browser worker is closed"));
    const now = Date.now();
    for (const [traceId, outcome] of this.recentOutcomes) {
      if (outcome.expiresAt <= now) this.recentOutcomes.delete(traceId);
    }
    const cached = this.recentOutcomes.get(turn.traceId);
    if (cached) {
      if (cached.error !== undefined) return Promise.reject(cached.error);
      const answer = cached.answer ?? { markdown: "", rawText: "", inputText: turn.prompt };
      if (answer.markdown) turn.onTextDelta(answer.markdown);
      return Promise.resolve(answer);
    }
    const existing = this.inFlight.get(turn.traceId);
    if (existing) {
      return existing.then(answer => {
        if (answer.markdown) turn.onTextDelta(answer.markdown);
        return answer;
      });
    }
    const result = this.tail.then(() => {
      if (this.closed) throw new Error("DeepSeek Web browser worker is closed");
      return this.runExclusive(turn);
    });
    this.inFlight.set(turn.traceId, result);
    void result.then(
      answer => {
        if (this.inFlight.get(turn.traceId) === result) this.inFlight.delete(turn.traceId);
        this.recentOutcomes.set(turn.traceId, {
          expiresAt: Date.now() + DEEPSEEK_REPLAY_TTL_MS,
          answer,
        });
      },
      error => {
        if (this.inFlight.get(turn.traceId) === result) this.inFlight.delete(turn.traceId);
        if (error instanceof DeepSeekBrowserTurnFailure && error.submissionAttempted) {
          this.recentOutcomes.set(turn.traceId, {
            expiresAt: Date.now() + DEEPSEEK_REPLAY_TTL_MS,
            error,
          });
        }
      },
    );
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async close(): Promise<void> {
    if (this.closed) {
      await this.tail.catch(() => {});
      return;
    }
    this.closed = true;
    const activeContext = this.activeContext;
    const sessionContext = this.sessionContext;
    this.activeContext = undefined;
    this.sessionContext = undefined;
    this.sessionPage = undefined;
    this.conversationTraceId = undefined;
    this.conversationKey = undefined;
    const context = activeContext ?? sessionContext;
    if (context) {
      this.cancelledContexts.add(context);
      await context.close().catch(() => {});
    }
    await this.tail.catch(() => {});
    this.inFlight.clear();
    this.recentOutcomes.clear();
    const browser = this.browser;
    this.browser = undefined;
    if (browser) await browser.close().catch(() => {});
  }

  cancelActive(): boolean {
    const context = this.activeContext;
    if (!context) return false;
    this.cancelledContexts.add(context);
    this.activeContext = undefined;
    if (this.sessionContext === context) {
      this.sessionContext = undefined;
      this.sessionPage = undefined;
      this.conversationTraceId = undefined;
      this.conversationKey = undefined;
    }
    void context.close().catch(() => {});
    return true;
  }

  activeCount(): number {
    return this.activeContext ? 1 : 0;
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    this.browser = undefined;
    this.sessionContext = undefined;
    this.sessionPage = undefined;
    this.conversationTraceId = undefined;
    this.conversationKey = undefined;
    if (!existsSync(this.config.chromeExecutablePath)) {
      throw new Error(`Google Chrome was not found at ${this.config.chromeExecutablePath}`);
    }
    this.browser = await chromium.launch({
      executablePath: this.config.chromeExecutablePath,
      headless: !this.config.headed,
      env: childProcessEnvironment(),
      timeout: DEEPSEEK_BROWSER_LAUNCH_TIMEOUT_MS,
      ignoreDefaultArgs: ["--password-store=basic", "--use-mock-keychain"],
      args: ["--no-first-run", "--no-default-browser-check"],
    });
    return this.browser;
  }

  private async ensureSession(): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
    const browser = await this.ensureBrowser();
    if (this.sessionContext && this.sessionPage && !this.sessionPage.isClosed()) {
      return { browser, context: this.sessionContext, page: this.sessionPage };
    }
    if (this.sessionContext) await this.sessionContext.close().catch(() => {});
    const context = await browser.newContext({ storageState: this.config.storageStatePath });
    const page = await context.newPage();
    this.sessionContext = context;
    this.sessionPage = page;
    return { browser, context, page };
  }

  private discardSession(context: BrowserContext): void {
    if (this.sessionContext !== context) return;
    this.sessionContext = undefined;
    this.sessionPage = undefined;
    this.conversationTraceId = undefined;
    this.conversationKey = undefined;
  }

  private assertStoredLogin(): void {
    if (!existsSync(this.config.storageStatePath)
      || !existsSync(deepSeekLoginVerificationMarkerPath(this.config.storageStatePath))) {
      throw new Error(
        `DeepSeek Web login state is missing: ${this.config.storageStatePath}. Run codex-chatgpt-web deepseek-login.`,
      );
    }
  }

  private async assertNotBlocked(page: Page, navigationStatus?: number): Promise<void> {
    if (navigationStatus === 403) {
      throw new Error("DeepSeek Web returned HTTP 403/WAF blocked; the harness will not bypass that access control");
    }
    const blocked = await deepSeekSecurityChallenge(page);
    if (blocked && !deepSeekSignInUrl(page.url())) {
      throw new Error(`DeepSeek Web is blocked by an interactive security check: ${blocked}`);
    }
  }

  private async selectMode(page: Page, mode: DeepSeekWebAdapterMode): Promise<void> {
    const desired = mode === "expert" ? "Expert" : "Instant";
    const desiredPattern = mode === "expert"
      ? /^Expert(?:\s+Mode)?$/i
      : /^Instant(?:\s+Mode)?$/i;
    const findDesired = async () => {
      const radios = page.locator('div[role="radio"]');
      const count = await radios.count();
      for (let index = 0; index < count; index++) {
        const radio = radios.nth(index);
        if (!await radio.isVisible().catch(() => false)) continue;
        const fields = [
          await radio.getAttribute("aria-label").catch(() => null),
          await radio.getAttribute("title").catch(() => null),
          await radio.innerText().catch(() => ""),
        ];
        if (fields.some(field => desiredPattern.test((field ?? "").replace(/\s+/g, " ").trim()))) {
          return radio;
        }
      }
      return undefined;
    };

    const discoveryDeadline = Date.now() + 30_000;
    let target = await findDesired();
    while (!target && Date.now() < discoveryDeadline) {
      await page.waitForTimeout(250);
      target = await findDesired();
    }
    if (!target) throw new Error(`DeepSeek Web UI contract drift: visible ${desired} mode radio was not found`);
    if (await target.getAttribute("aria-checked") === "true") return;
    await target.click({ timeout: 15_000 });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const current = await findDesired();
      if (current && await current.getAttribute("aria-checked").catch(() => null) === "true") return;
      await page.waitForTimeout(250);
    }
    throw new Error(`DeepSeek Web did not confirm ${desired} mode selection`);
  }

  private async assertFreshChat(page: Page): Promise<void> {
    await page.waitForTimeout(500);
    const messageCount = await page.locator(".ds-message").count();
    if (messageCount > 0) {
      throw new Error(
        `DeepSeek Web UI contract drift: expected a fresh chat but found ${messageCount} existing message(s)`,
      );
    }
  }

  private async insertPrompt(page: Page, prompt: string): Promise<void> {
    const composer = deepSeekComposer(page);
    await composer.waitFor({ state: "visible", timeout: 40_000 });
    await composer.fill("");
    await composer.focus();
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send("Input.insertText", { text: prompt });
    } finally {
      await cdp.detach().catch(() => {});
    }
    const actual = await composer.evaluate(element => {
      if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) return element.value;
      return element.textContent ?? "";
    });
    if (!browserComposerTextMatches(prompt, actual)) {
      const normalizedActual = normalizeBrowserComposerText(actual);
      const normalizedPrompt = normalizeBrowserComposerText(prompt);
      throw new Error(
        `DeepSeek Web composer rejected part of the prompt (${actual.length}/${prompt.length} characters inserted; `
        + `${normalizedActual.length}/${normalizedPrompt.length} after browser line-ending normalization)`,
      );
    }
  }

  private async submitPrompt(page: Page, prompt: string, requireFreshEvidence = false): Promise<void> {
    const composer = deepSeekComposer(page);
    const initialUrl = page.url();
    await composer.press("Enter");
    const normalizedPrompt = prompt.replace(/\s+/g, " ").trim();
    const leading = normalizedPrompt.slice(0, 120);
    const trailing = normalizedPrompt.slice(-120);
    const deadline = Date.now() + 40_000;
    let confirmedSince: number | undefined;
    while (Date.now() < deadline) {
      const evidence = await page.evaluate(({ composerSelector, leading, trailing, expectedLength, initialUrl }) => {
        const visible = (element: Element): boolean => {
          const candidate = element as HTMLElement;
          const style = getComputedStyle(candidate);
          const rect = candidate.getBoundingClientRect();
          return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
        };
        const composer = [...document.querySelectorAll<HTMLElement>(composerSelector)].find(visible);
        const composerValue = composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement
          ? composer.value
          : composer?.textContent ?? "";
        const cleared = Boolean(composer) && composerValue.length === 0;
        const messages = [...document.querySelectorAll<HTMLElement>(".ds-message")].filter(visible);
        const userBubble = messages.some(message => {
          const text = (message.innerText ?? message.textContent ?? "").replace(/\s+/g, " ").trim();
          return text.length >= Math.min(expectedLength, leading.length + trailing.length)
            && text.includes(leading)
            && text.includes(trailing);
        });
        const responsePresent = messages.some(message => (
          [...message.querySelectorAll<HTMLElement>(".ds-markdown")].some(visible)
        ));
        let running = false;
        let shell = composer?.parentElement;
        for (let depth = 0; shell && depth < 6 && shell !== document.body; depth++, shell = shell.parentElement) {
          const controls = [...shell.querySelectorAll<HTMLElement>('button, [role="button"], [aria-label], [title]')]
            .filter(visible);
          if (controls.some(control => {
            const fields = [
              control.getAttribute("aria-label"),
              control.getAttribute("title"),
              control.innerText,
              control.textContent,
            ].filter((value): value is string => Boolean(value));
            return fields.some(field => /\bstop(?:\s+generating)?\b/i.test(field.replace(/\s+/g, " ").trim()));
          })) {
            running = true;
            break;
          }
        }
        const chatRoute = location.href !== initialUrl
          && location.hostname === "chat.deepseek.com"
          && !/(?:^|\/)sign_in(?:\/|$)/.test(location.pathname);
        return { cleared, userBubble, responsePresent, running, chatRoute };
      }, {
        composerSelector: DEEPSEEK_COMPOSER_SELECTOR,
        leading,
        trailing,
        expectedLength: normalizedPrompt.length,
        initialUrl,
      }).catch(() => ({
        cleared: false,
        userBubble: false,
        responsePresent: false,
        running: false,
        chatRoute: false,
      }));
      const acceptedEvidence = evidence.userBubble
        || evidence.running
        || (!requireFreshEvidence && (evidence.responsePresent || evidence.chatRoute));
      if (evidence.cleared && acceptedEvidence) {
        confirmedSince ??= Date.now();
        if (Date.now() - confirmedSince >= 500) return;
      } else {
        confirmedSince = undefined;
      }
      await page.waitForTimeout(250);
    }
    throw new Error(
      "DeepSeek Web submission could not be confirmed; the harness did not retry to avoid duplicating the prompt",
    );
  }

  private async responseSnapshot(page: Page): Promise<DeepSeekResponseSnapshot> {
    try {
      const snapshot = await page.evaluate(({ composerSelector, responseSelector, assistantSelector }) => {
        const visible = (element: Element): boolean => {
          const candidate = element as HTMLElement;
          const style = getComputedStyle(candidate);
          const rect = candidate.getBoundingClientRect();
          return style.visibility !== "hidden"
            && style.display !== "none"
            && rect.width > 0
            && rect.height > 0;
        };
        const controlFields = (element: Element): string[] => {
          const candidate = element as HTMLElement;
          return [
            candidate.getAttribute("aria-label"),
            candidate.getAttribute("title"),
            candidate.getAttribute("data-testid"),
            candidate.innerText,
            candidate.textContent,
          ].filter((value): value is string => Boolean(value))
            .map(value => value.replace(/\s+/g, " ").trim())
            .filter(Boolean);
        };
        const isThinking = (node: Element): boolean => Boolean(
          node.matches(".ds-markdown--think")
            || node.closest('.ds-think-content, [class*="think" i]'),
        );
        const isToolMarkupElement = (node: Element): boolean => {
          const tag = node.tagName.toLowerCase();
          return tag === "request_tool"
            || tag === "tool_calls"
            || tag === "invoke"
            || tag === "parameter"
            || tag === "argument"
            || tag === "arg"
            || tag.includes("dsml");
        };
        const containsToolMarkup = (node: Element): boolean => (
          isToolMarkupElement(node)
          || [...node.querySelectorAll("*")].some(isToolMarkupElement)
        );
        const serializeRawResponse = (node: Node): string => {
          if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
          if (!(node instanceof Element)) return "";
          if (isToolMarkupElement(node)) {
            const tag = node.tagName.toLowerCase();
            const attributes = [...node.attributes]
              .map(attribute => ` ${attribute.name}="${attribute.value.replace(/"/g, "&quot;")}"`)
              .join("");
            const body = [...node.childNodes].map(serializeRawResponse).join("");
            return `<${tag}${attributes}>${body}</${tag}>`;
          }
          const body = [...node.childNodes].map(serializeRawResponse).join("");
          return /^(?:p|div|pre|section|article|li|ul|ol|blockquote|br)$/i.test(node.tagName)
            ? `${body}\n`
            : body;
        };
        const messages = [...document.querySelectorAll<HTMLElement>(".ds-message")].filter(visible);
        const responseRoots = messages.filter(message => (
          [...message.querySelectorAll<HTMLElement>(responseSelector)].some(node => !isThinking(node))
          || containsToolMarkup(message)
        ));
        const root = responseRoots.at(-1);
        let markdownNodes = root
          ? [...root.querySelectorAll<HTMLElement>(responseSelector)].filter(node => {
              if (isThinking(node)) return false;
              return !node.parentElement?.closest(responseSelector);
            })
          : [];
        if (markdownNodes.length === 0) {
          // `.ds-message` has changed independently of `.ds-markdown` before.
          // Treat the rendered answer itself as authoritative rather than making
          // the legacy message wrapper a hard dependency.
          const globalMarkdown = [...document.querySelectorAll<HTMLElement>(responseSelector)]
            .filter(node => visible(node) && !isThinking(node));
          const topLevelMarkdown = globalMarkdown.filter(node => !node.parentElement?.closest(responseSelector));
          const latestMarkdown = (topLevelMarkdown.length > 0 ? topLevelMarkdown : globalMarkdown).at(-1);
          if (latestMarkdown) markdownNodes = [latestMarkdown];
        }
        if (markdownNodes.length === 0) {
          // Last-resort semantic fallback for a DeepSeek class-name migration.
          // Fresh-chat isolation means the last visible assistant-like region is
          // safe to inspect without accidentally selecting an older response.
          const composer = [...document.querySelectorAll<HTMLElement>(composerSelector)].find(visible);
          const assistantCandidates = [...document.querySelectorAll<HTMLElement>(assistantSelector)]
            .filter(node => {
              if (!visible(node) || isThinking(node) || node === composer || node.contains(composer ?? null)) return false;
              return (node.innerText ?? node.textContent ?? "").trim().length > 0;
            });
          const leafCandidates = assistantCandidates.filter(candidate => (
            !assistantCandidates.some(other => other !== candidate && candidate.contains(other))
          ));
          const latestAssistant = (leafCandidates.length > 0 ? leafCandidates : assistantCandidates).at(-1);
          if (latestAssistant) markdownNodes = [latestAssistant];
        }
        const toolMarkupNodes = root
          ? [...root.querySelectorAll<HTMLElement>("*")].filter(node => (
              isToolMarkupElement(node)
              && !(() => {
                let parent = node.parentElement;
                while (parent && parent !== root) {
                  if (isToolMarkupElement(parent)) return true;
                  parent = parent.parentElement;
                }
                return false;
              })()
              && !markdownNodes.some(markdown => markdown.contains(node))
            ))
          : [];
        const responseNodes = [...markdownNodes, ...toolMarkupNodes].sort((left, right) => {
          if (left === right) return 0;
          return left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
        });
        const finalHtml = markdownNodes.map(node => node.outerHTML).join("\n");
        const finalText = markdownNodes
          .map(node => node.innerText ?? node.textContent ?? "")
          .join("\n")
          .trim();
        const finalRawText = responseNodes
          .map(serializeRawResponse)
          .join("\n")
          .trim();
        const rootMessageIndex = root ? messages.indexOf(root) : -1;
        const fallbackNode = root ? undefined : markdownNodes.at(-1);
        const fallbackResponseIndex = fallbackNode
          ? [...document.querySelectorAll<HTMLElement>(responseSelector)].indexOf(fallbackNode)
          : -1;
        const responseIdentity = root
          ? `message:${rootMessageIndex}:assistant:${responseRoots.length}`
          : fallbackNode ? `markdown:${fallbackResponseIndex}` : "";
        // DeepSeek may visually hide Copy/Regenerate controls until the answer
        // is hovered. They remain semantically attached to the response root,
        // so visibility is not required for this completion signal.
        const responseAnchor = root ?? markdownNodes.at(-1);
        // Server-busy responses do not always render a normal `.ds-markdown`
        // answer. Detect their Retry/Try again action independently so the
        // recovery path still works when there is no readable response body.
        const retryActionPresent = [...document.querySelectorAll<HTMLElement>(
          'button, [role="button"], [aria-label], [title], [data-testid]',
        )].filter(visible).some(control => (
          controlFields(control).some(field => /^(?:retry|try again)(?:\s+(?:response|answer))?$/i.test(field))
        ));
        let completionActionPresent = false;
        let controlScope: HTMLElement | null | undefined = responseAnchor;
        for (let depth = 0; controlScope && depth < 6 && controlScope !== document.body; depth++, controlScope = controlScope.parentElement) {
          // Do not climb into a shared chat container where controls from an old
          // response could be mistaken for completion actions on the latest one.
          if (controlScope.querySelectorAll(".ds-message").length > 1) break;
          const responseControls = [...controlScope.querySelectorAll<HTMLElement>(
            'button, [role="button"], [aria-label], [title], [data-testid]',
          )];
          if (responseControls.some(control => (
            controlFields(control).some(field => /^(?:copy|regenerate|rewrite|re-?answer)(?:\s+(?:response|answer))?$/i.test(field))
          ))) {
            completionActionPresent = true;
          }
          if (retryActionPresent && completionActionPresent) break;
        }
        const composer = [...document.querySelectorAll<HTMLElement>(composerSelector)].find(visible);
        const running = [...document.querySelectorAll<HTMLElement>(
          'button, [role="button"], [aria-label], [title], [data-testid]',
        )].filter(visible).some(control => (
          controlFields(control).some(field => /\b(?:stop|cancel)(?:\s+(?:generating|generation|response))?\b/i.test(field))
        ));
        const composerReady = Boolean(composer
          && visible(composer)
          && !(composer as HTMLTextAreaElement).disabled
          && !(composer as HTMLTextAreaElement).readOnly
          && composer.getAttribute("aria-disabled") !== "true");
        const activitySignature = [
          finalText.length,
          finalText.slice(-512),
          finalRawText.length,
          finalRawText.slice(-512),
          finalHtml.length,
          finalHtml.slice(-512),
          running ? "running" : "idle",
          retryActionPresent ? "retry" : "no-retry",
          completionActionPresent ? "actions" : "no-actions",
        ].join(":");
        return {
          probeSucceeded: true,
          responsePresent: responseNodes.length > 0,
          running,
          retryActionPresent,
          completionActionPresent,
          composerReady,
          finalHtml,
          finalText,
          finalRawText,
          responseIdentity,
          finalTextLength: Math.max(finalText.length, finalRawText.length),
          activitySignature,
        } satisfies DeepSeekResponseSnapshot;
      }, {
        composerSelector: DEEPSEEK_COMPOSER_SELECTOR,
        responseSelector: ".ds-markdown",
        assistantSelector: [
          '[data-message-author-role="assistant"]',
          '[data-role="assistant"]',
          '[data-testid*="assistant" i]',
          '[class*="assistant" i][class*="message" i]',
          '[class*="answer" i][class*="content" i]',
          '[class*="markdown" i]',
        ].join(", "),
      });
      const blockedText = await deepSeekSecurityChallenge(page);
      return blockedText ? { ...snapshot, blockedText } : snapshot;
    } catch {
      return {
        probeSucceeded: false,
        responsePresent: false,
        running: false,
        retryActionPresent: false,
        completionActionPresent: false,
        composerReady: false,
        finalHtml: "",
        finalText: "",
        finalTextLength: 0,
        activitySignature: "",
      };
    }
  }

  private async clickRetryAction(page: Page): Promise<boolean> {
    return page.evaluate(() => {
      const visible = (element: Element): boolean => {
        const candidate = element as HTMLElement;
        const style = getComputedStyle(candidate);
        const rect = candidate.getBoundingClientRect();
        return style.visibility !== "hidden"
          && style.display !== "none"
          && rect.width > 0
          && rect.height > 0;
      };
      const fields = (element: Element): string[] => {
        const candidate = element as HTMLElement;
        return [
          candidate.getAttribute("aria-label"),
          candidate.getAttribute("title"),
          candidate.getAttribute("data-testid"),
          candidate.innerText,
          candidate.textContent,
        ].filter((value): value is string => Boolean(value))
          .map(value => value.replace(/\s+/g, " ").trim())
          .filter(Boolean);
      };
      const controls = [...document.querySelectorAll<HTMLElement>(
        'button, [role="button"], [aria-label], [title], [data-testid]',
      )].filter(control => (
        visible(control)
        && !control.hasAttribute("disabled")
        && control.getAttribute("aria-disabled") !== "true"
        && fields(control).some(field => /^(?:retry|try again)(?:\s+(?:response|answer))?$/i.test(field))
      ));
      const retry = controls.at(-1);
      if (!retry) return false;
      retry.click();
      return true;
    }).catch(() => false);
  }

  private async runExclusive(turn: DeepSeekBrowserTurn): Promise<DeepSeekBrowserResult> {
    if (turn.abortSignal?.aborted) throw abortError();
    this.assertStoredLogin();
    const { browser, context, page } = await this.ensureSession();
    this.activeContext = context;
    let completed = false;
    let submissionAttempted = false;
    const onAbort = () => {
      this.cancelledContexts.add(context);
      this.discardSession(context);
      void context.close().catch(() => {});
    };
    turn.abortSignal?.addEventListener("abort", onAbort, { once: true });
    try {
      let activePrompt = turn.prompt;
      const exactToolContinuation = Boolean(
        turn.continueFromTraceId
        && turn.followUpPrompt
        && this.conversationTraceId === turn.continueFromTraceId
      );
      const sameConversationContinuation = Boolean(
        turn.conversationKey
        && turn.continuationPrompt
        && this.conversationKey === turn.conversationKey,
      );
      let continuing = Boolean(
        !deepSeekSignInUrl(page.url())
        && (exactToolContinuation || sameConversationContinuation),
      );
      let continuationBaseline: DeepSeekResponseSnapshot | undefined;

      if (continuing) {
        await this.assertNotBlocked(page);
        await assertAuthenticatedDeepSeekPage(page);
        continuationBaseline = await this.responseSnapshot(page);
        if (!continuationBaseline.probeSucceeded || !continuationBaseline.responsePresent) {
          continuing = false;
          continuationBaseline = undefined;
        } else {
          activePrompt = exactToolContinuation ? turn.followUpPrompt! : turn.continuationPrompt!;
        }
      }

      if (!continuing) {
        const navigation = await page.goto(DEEPSEEK_HOME_URL, {
          waitUntil: "domcontentloaded",
          timeout: 70_000,
        });
        this.conversationTraceId = undefined;
        this.conversationKey = undefined;
        await this.assertNotBlocked(page, navigation?.status());
        await assertAuthenticatedDeepSeekPage(page);
        await this.selectMode(page, turn.mode);
        await this.assertFreshChat(page);
      }

      await this.insertPrompt(page, activePrompt);
      // Pressing Enter crosses the no-duplicate boundary. Even if the UI does
      // not subsequently expose a user bubble, DeepSeek may already have
      // accepted the request.
      submissionAttempted = true;
      await this.submitPrompt(page, activePrompt, continuing);

      console.info(
        `[deepseek-web] browser turn ${turn.traceId} submitted mode=${turn.mode} promptChars=${activePrompt.length} continuation=${continuing}`,
      );
      const completion = new DeepSeekCompletionTracker();
      const domHealth = new DeepSeekTurnDomHealthTracker();
      const retryBudget = new DeepSeekRetryClickBudget();
      let lastActivitySignature = "";
      let inactivityDeadline = Date.now() + this.config.turnTimeoutMs;
      let lastHeartbeat = 0;
      let followUpResponseObserved = !continuing;
      let nextRetryAt = 0;

      while (true) {
        if (turn.abortSignal?.aborted) throw abortError();
        if (page.isClosed() || !browser.isConnected()) {
          throw new Error("DeepSeek Web browser page closed unexpectedly during the turn");
        }
        const now = Date.now();
        const snapshot = await this.responseSnapshot(page);
        if (snapshot.blockedText) {
          throw new Error(`DeepSeek Web entered a security challenge: ${snapshot.blockedText}`);
        }
        if (deepSeekSignInUrl(page.url())) {
          throw new Error("DeepSeek Web login expired during the turn");
        }
        if (snapshot.retryActionPresent) {
          completion.reset();
          if (now >= nextRetryAt) {
            if (retryBudget.exhausted) {
              throw new Error(
                `DeepSeek Web remained busy after ${retryBudget.limit} Retry attempts`,
              );
            }
            if (await this.clickRetryAction(page)) {
              const retryAttempt = retryBudget.recordClick();
              nextRetryAt = now + DEEPSEEK_RETRY_COOLDOWN_MS;
              inactivityDeadline = now + this.config.turnTimeoutMs;
              console.info(
                `[deepseek-web] browser turn ${turn.traceId} clicked DeepSeek Retry after busy response attempt=${retryAttempt}/${retryBudget.limit}`,
              );
              await page.waitForTimeout(DEEPSEEK_RESPONSE_POLL_MS);
              continue;
            }
          }
        }
        const domFailure = domHealth.update(snapshot, now);
        if (domFailure) throw new Error(domFailure);
        if (snapshot.activitySignature && snapshot.activitySignature !== lastActivitySignature) {
          lastActivitySignature = snapshot.activitySignature;
          inactivityDeadline = now + this.config.turnTimeoutMs;
        }
        if (continuing && continuationBaseline && !followUpResponseObserved) {
          followUpResponseObserved = deepSeekContinuationResponseChanged(
            continuationBaseline,
            snapshot,
          );
          if (!followUpResponseObserved) completion.reset();
        }
        if (followUpResponseObserved && completion.update(snapshot, now)) {
          const markdown = chatGptHtmlToMarkdown(snapshot.finalHtml).trim();
          const rawText = snapshot.finalRawText?.trim() || snapshot.finalText.trim();
          if (!markdown && !rawText) throw new Error("DeepSeek Web completed without a readable final response");
          const final = markdown || rawText;
          turn.onTextDelta(final);
          completed = true;
          this.conversationTraceId = turn.traceId;
          this.conversationKey = turn.conversationKey;
          console.info(
            `[deepseek-web] browser turn ${turn.traceId} completed markdownChars=${final.length}`,
          );
          return { markdown: final, rawText: rawText || final, inputText: activePrompt };
        }
        if (now >= inactivityDeadline) {
          throw new Error(
            `DeepSeek Web produced no observable progress for ${Math.round(this.config.turnTimeoutMs / 60_000)} minutes`,
          );
        }
        if (now - lastHeartbeat >= 2_000) {
          lastHeartbeat = now;
          turn.onHeartbeat?.();
        }
        await page.waitForTimeout(DEEPSEEK_RESPONSE_POLL_MS);
      }
    } catch (error) {
      if (submissionAttempted) {
        this.conversationTraceId = undefined;
        this.conversationKey = undefined;
      }
      if (page.isClosed() || !browser.isConnected()) {
        this.discardSession(context);
        await context.close().catch(() => {});
      }
      if (error instanceof DeepSeekBrowserTurnFailure) throw error;
      if (submissionAttempted) {
        const cancelled = turn.abortSignal?.aborted || this.cancelledContexts.has(context);
        const message = cancelled
          ? "the Codex request was cancelled after DeepSeek may have accepted the prompt"
          : error instanceof Error ? error.message : String(error);
        throw new DeepSeekBrowserTurnFailure(
          `DeepSeek Web failed after submission was attempted; automatic retry is disabled to avoid duplicate prompts: ${message}`,
          true,
          error instanceof Error ? { cause: error } : undefined,
        );
      }
      if (turn.abortSignal?.aborted || this.cancelledContexts.has(context)) throw abortError();
      throw error;
    } finally {
      turn.abortSignal?.removeEventListener("abort", onAbort);
      if (completed && !page.isClosed() && !deepSeekSignInUrl(page.url())) {
        const state = await context.storageState().catch(() => undefined);
        if (state) atomicWriteFile(this.config.storageStatePath, `${JSON.stringify(state)}\n`);
      }
      this.cancelledContexts.delete(context);
      if (this.activeContext === context) this.activeContext = undefined;
    }
  }
}

export function activeDeepSeekBrowserTurns(): number {
  return [...workers.values()].reduce((total, worker) => total + worker.activeCount(), 0);
}

export function cancelDeepSeekBrowserTurns(): number {
  let cancelled = 0;
  for (const worker of workers.values()) {
    if (worker.cancelActive()) cancelled++;
  }
  return cancelled;
}

export async function closeDeepSeekBrowserWorkers(): Promise<void> {
  const all = [...workers.values()];
  workers.clear();
  await Promise.all(all.map(worker => worker.close()));
}
