import { describe, expect, test } from "bun:test";
import {
  CHATGPT_LOW_POWER_STYLE,
  CHATGPT_LOW_RESOURCE_LAUNCH_ARGS,
  CHATGPT_MAX_SCHEDULER_GAP_EXTENSION_MS,
  CHATGPT_CONSTRAINED_PARALLELISM,
  CHATGPT_COMPLETION_OBSERVATION_GAP_MS,
  CHATGPT_DOM_PROBE_GRACE_MS,
  CHATGPT_POST_TOOL_COMPLETION_GRACE_MS,
  CHATGPT_RESPONSE_DOM_GRACE_MS,
  CHATGPT_RUNNING_WITHOUT_RESPONSE_GRACE_MS,
  CHATGPT_RECOVERY_SIGNAL_POLL_MS,
  CHATGPT_RESPONSE_POLL_MS,
  CHATGPT_RENDERER_TELEMETRY_MS,
  CHATGPT_RESTORE_BACKGROUND_THROTTLING_ARGS,
  CHATGPT_TOOL_WAIT_POLL_MS,
  CHATGPT_TRACE_POLL_MS,
  CHATGPT_UI_POLL_MS,
  chatGptTurnIsComplete,
  chatGptPollingProfile,
  chatGptRendererTelemetryEnabled,
  chatGptResponsePollInterval,
  chatGptSchedulerGapExtension,
  ChatGptBrowserWorker,
  ChatGptCompletionTracker,
  ChatGptTurnDomHealthTracker,
  ChatGptVisibleTraceTracker,
  closeChatGptBrowserWorkers,
} from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptHeartbeatFeed, ChatGptTextFeed } from "../src/adapters/chatgpt-web/turn-execution";

describe("ChatGPT browser worker memory reuse", () => {
  test("restores Chromium background throttling during browser automation", () => {
    expect(CHATGPT_RESTORE_BACKGROUND_THROTTLING_ARGS).toEqual([
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
    ]);
  });

  test("disables remote image rendering without request interception", () => {
    expect(CHATGPT_LOW_RESOURCE_LAUNCH_ARGS).toEqual([
      "--blink-settings=imagesEnabled=false",
    ]);
  });

  test("backs off DOM polling while Codex Native tool results are pending", () => {
    expect(chatGptResponsePollInterval(0)).toBe(CHATGPT_RESPONSE_POLL_MS);
    expect(chatGptResponsePollInterval(1)).toBe(CHATGPT_TOOL_WAIT_POLL_MS);
    expect(chatGptResponsePollInterval(8)).toBe(CHATGPT_TOOL_WAIT_POLL_MS);
  });

  test("keeps setup polling and renderer telemetry low-frequency on constrained CPUs", () => {
    expect(CHATGPT_CONSTRAINED_PARALLELISM).toBe(4);
    expect(CHATGPT_UI_POLL_MS).toBe(500);
    expect(CHATGPT_RESPONSE_POLL_MS).toBe(1_250);
    expect(CHATGPT_TOOL_WAIT_POLL_MS).toBe(15_000);
    expect(CHATGPT_TRACE_POLL_MS).toBe(4_000);
    expect(CHATGPT_RENDERER_TELEMETRY_MS).toBe(15_000);
    expect(CHATGPT_RECOVERY_SIGNAL_POLL_MS).toBe(2_500);
    expect(chatGptRendererTelemetryEnabled({})).toBe(false);
    expect(chatGptRendererTelemetryEnabled({ CODEX_CHATGPT_WEB_RENDERER_TELEMETRY: "1" })).toBe(true);

    expect(chatGptPollingProfile(4)).toEqual({
      constrained: true,
      responseMs: 1_800,
      uiMs: 750,
      traceMs: 6_000,
      recoveryMs: 4_000,
    });
    expect(chatGptPollingProfile(8)).toEqual({
      constrained: false,
      responseMs: CHATGPT_RESPONSE_POLL_MS,
      uiMs: CHATGPT_UI_POLL_MS,
      traceMs: CHATGPT_TRACE_POLL_MS,
      recoveryMs: CHATGPT_RECOVERY_SIGNAL_POLL_MS,
    });
  });

  test("forces decorative browser motion down to near-zero durations", () => {
    expect(CHATGPT_LOW_POWER_STYLE).toContain("animation-duration: 0.001ms");
    expect(CHATGPT_LOW_POWER_STYLE).toContain("transition-duration: 0.001ms");
    expect(CHATGPT_LOW_POWER_STYLE).toContain("scroll-behavior: auto");
  });

  test("resets the existing page in place before the next turn", async () => {
    const navigations: Array<{ url: string; waitUntil?: string; timeout?: number }> = [];
    const page = {
      url: () => "https://chatgpt.com/?temporary-chat=true",
      goto: async (url: string, options?: { waitUntil?: string; timeout?: number }) => {
        navigations.push({ url, ...options });
        return null;
      },
    };
    const worker = Object.create(ChatGptBrowserWorker.prototype) as ChatGptBrowserWorker & Record<string, unknown>;
    (worker as any).ensurePage = async () => page;
    (worker as any).discardBrowser = () => {
      throw new Error("healthy page should not discard the browser");
    };

    const result = await (worker as any).pageForNewTurn();

    expect(result).toBe(page);
    expect(navigations).toEqual([
      { url: "about:blank", waitUntil: "commit", timeout: 15_000 },
    ]);
  });

  test("shares one Chrome process across isolated interactive and compaction lanes", async () => {
    const provider = {
      chatgptWeb: {
        storageStatePath: "./test-storage-state.json",
        chromeExecutablePath: "./test-chrome.exe",
        headed: true,
        localToolsEnabled: true,
      },
    } as any;
    const interactive = ChatGptBrowserWorker.forProvider(provider);
    const readOnly = ChatGptBrowserWorker.forProvider({
      ...provider,
      chatgptWeb: { ...provider.chatgptWeb, localToolsEnabled: false },
    });

    expect(interactive).not.toBe(readOnly);
    expect((interactive as any).sharedBrowser).toBe((readOnly as any).sharedBrowser);
    await closeChatGptBrowserWorkers();
  });

  test("keeps streamed answer chunks exact until the final value is requested", () => {
    const feed = new ChatGptTextFeed();
    for (let index = 0; index < 10_000; index++) feed.push(`chunk-${index};`);

    const expected = Array.from({ length: 10_000 }, (_, index) => `chunk-${index};`).join("");
    expect(feed.value()).toBe(expected);
    expect(feed.value()).toBe(expected);
    expect(feed.drain().join("")).toBe(expected);
    expect(feed.value()).toBe(expected);
  });

  test("keeps earlier commentary when the final-answer trace block is an empty sentinel", () => {
    const tracker = new ChatGptVisibleTraceTracker(0);
    const events = tracker.observe([
      { kind: "markdown", text: "Finished inspecting the files." },
      { kind: "status", text: "Checking types" },
      { kind: "markdown", text: "" },
    ], false, 1);

    expect(events).toEqual([
      { kind: "commentary", text: "Finished inspecting the files." },
    ]);
  });

  test("accepts current-turn response actions once generation is no longer running", () => {
    expect(chatGptTurnIsComplete({
      responsePresent: true,
      running: false,
      currentText: "Finished answer",
      completionActionPresent: true,
    })).toBe(true);

    expect(chatGptTurnIsComplete({
      responsePresent: true,
      running: true,
      currentText: "Finished answer",
      completionActionPresent: true,
    })).toBe(false);
  });

  test("still requires stable current-turn completion evidence", () => {
    const tracker = new ChatGptCompletionTracker(750);
    const complete = {
      responsePresent: true,
      running: false,
      currentText: "Finished answer",
      completionActionPresent: true,
    };

    expect(tracker.update(complete, 1_000)).toBe(false);
    expect(tracker.update(complete, 1_749)).toBe(false);
    expect(tracker.update(complete, 1_750)).toBe(true);
    expect(tracker.update({ ...complete, completionActionPresent: false }, 2_000)).toBe(false);
  });

  test("does not age stale completion evidence across a tool wait or sleep gap", () => {
    const tracker = new ChatGptCompletionTracker(750, CHATGPT_COMPLETION_OBSERVATION_GAP_MS);
    const complete = {
      responsePresent: true,
      running: false,
      currentText: "Intermediate commentary",
      completionActionPresent: true,
    };

    expect(tracker.update(complete, 1_000)).toBe(false);
    tracker.reset(); // pending tool transition
    expect(tracker.update(complete, 121_000)).toBe(false);
    expect(tracker.update(complete, 121_750)).toBe(true);

    expect(tracker.update(complete, 200_000)).toBe(false); // unobserved gap resets stability
    expect(CHATGPT_POST_TOOL_COMPLETION_GRACE_MS).toBeGreaterThan(750);
  });

  test("keeps missing assistant DOM recoverable while ChatGPT is visibly running", () => {
    const tracker = new ChatGptTurnDomHealthTracker(30_000, 10_000, false, 30_000, 60_000);
    const missing = {
      responsePresent: false,
      running: true,
      currentText: "",
      completionActionPresent: false,
      probeSucceeded: true,
    };

    expect(tracker.update(missing, 0)).toBeUndefined();
    expect(tracker.update(missing, 30_000)).toBeUndefined();
    expect(tracker.update(missing, 120_000)).toBeUndefined();

    const stopped = { ...missing, running: false };
    expect(tracker.update(stopped, 121_000)).toBeUndefined();
    expect(tracker.update(stopped, 150_999)).toBeUndefined();
    expect(tracker.update(stopped, 151_000)).toContain("did not create a response DOM");
  });

  test("does not kill a running turn when an observed response DOM remounts", () => {
    const tracker = new ChatGptTurnDomHealthTracker(30_000, 10_000, false, 30_000, 60_000);
    const present = {
      responsePresent: true,
      running: true,
      currentText: "present",
      completionActionPresent: false,
      probeSucceeded: true,
    };
    expect(tracker.update(present, 0)).toBeUndefined();
    expect(tracker.update({ ...present, responsePresent: false, currentText: "" }, 30_000)).toBeUndefined();
    expect(tracker.update({ ...present, responsePresent: false, currentText: "" }, 120_000)).toBeUndefined();
  });

  test("bounds a continuously missing response DOM even when a stale running control remains", () => {
    const tracker = new ChatGptTurnDomHealthTracker(30_000, 10_000, false, 30_000, 60_000, 120_000);
    const missingButRunning = {
      responsePresent: false,
      running: true,
      currentText: "",
      completionActionPresent: false,
      probeSucceeded: true,
    };

    expect(tracker.update(missingButRunning, 0)).toBeUndefined();
    expect(tracker.update(missingButRunning, 30_000)).toBeUndefined();
    expect(tracker.update(missingButRunning, 60_000)).toBeUndefined();
    expect(tracker.update(missingButRunning, 90_000)).toBeUndefined();
    expect(tracker.update(missingButRunning, 120_000)).toContain("without a response DOM");
    expect(CHATGPT_RUNNING_WITHOUT_RESPONSE_GRACE_MS).toBeGreaterThan(CHATGPT_RESPONSE_DOM_GRACE_MS);
  });

  test("requires continuously observed DOM and probe failure time", () => {
    const tracker = new ChatGptTurnDomHealthTracker(30_000, 10_000, false, 30_000, 20_000);
    const missing = {
      responsePresent: false,
      running: false,
      currentText: "",
      completionActionPresent: false,
      probeSucceeded: true,
    };
    expect(tracker.update(missing, 0)).toBeUndefined();
    expect(tracker.update(missing, 10_000)).toBeUndefined();
    // Simulates sleep/resume: the large observation gap starts a fresh grace.
    expect(tracker.update(missing, 120_000)).toBeUndefined();

    const failedProbe = { ...missing, probeSucceeded: false };
    expect(tracker.update(failedProbe, 121_000)).toBeUndefined();
    expect(tracker.update(failedProbe, 131_000)).toBeUndefined();
    expect(tracker.update(failedProbe, 140_000)).toBeUndefined();
    expect(tracker.update(failedProbe, 151_000)).toContain("could not be inspected");
    expect(CHATGPT_RESPONSE_DOM_GRACE_MS).toBeGreaterThan(30_000);
    expect(CHATGPT_DOM_PROBE_GRACE_MS).toBeGreaterThan(30_000);
  });

  test("caps scheduler-gap deadline extensions across repeated slow renderer probes", () => {
    let remaining = CHATGPT_MAX_SCHEDULER_GAP_EXTENSION_MS;
    let extended = 0;
    for (let index = 0; index < 1_000; index += 1) {
      const granted = chatGptSchedulerGapExtension(31_000, remaining);
      remaining -= granted;
      extended += granted;
    }

    expect(extended).toBe(CHATGPT_MAX_SCHEDULER_GAP_EXTENSION_MS);
    expect(remaining).toBe(0);
    expect(chatGptSchedulerGapExtension(31_000, remaining)).toBe(0);
    expect(chatGptSchedulerGapExtension(29_999, CHATGPT_MAX_SCHEDULER_GAP_EXTENSION_MS)).toBe(0);
  });

  test("delivers browser heartbeats only when the worker pulses", async () => {
    const feed = new ChatGptHeartbeatFeed();
    const abort = new AbortController();
    const waiting = feed.wait(feed.value(), abort.signal);
    feed.pulse();
    expect(await waiting).toBe(1);
    expect(feed.value()).toBe(1);

    // A new request attached to a reused session must not treat an older pulse
    // as fresh liveness; it waits for the sequence to advance again.
    let reusedRequestResolved = false;
    const reusedRequest = feed.wait(feed.value()).then(sequence => {
      reusedRequestResolved = true;
      return sequence;
    });
    await Promise.resolve();
    expect(reusedRequestResolved).toBe(false);
    feed.pulse();
    expect(await reusedRequest).toBe(2);

    const cancelled = feed.wait(feed.value(), abort.signal);
    abort.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
  });
});
