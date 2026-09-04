import { describe, expect, test } from "bun:test";
import { classifiedDeepSeekError } from "../src/adapters/deepseek-web";
import {
  DEEPSEEK_MAX_RETRY_CLICKS,
  DeepSeekBrowserTurnFailure,
  DeepSeekRetryClickBudget,
  DeepSeekTurnDomHealthTracker,
  type DeepSeekResponseSnapshot,
} from "../src/adapters/deepseek-web/browser-worker";

function snapshot(overrides: Partial<DeepSeekResponseSnapshot> = {}): DeepSeekResponseSnapshot {
  return {
    probeSucceeded: true,
    responsePresent: true,
    running: true,
    retryActionPresent: false,
    completionActionPresent: false,
    composerReady: true,
    finalHtml: "<p>partial</p>",
    finalText: "partial",
    finalRawText: "partial",
    finalTextLength: 7,
    activitySignature: "partial:running",
    ...overrides,
  };
}

function healthTracker(unchangedRunningResponseMs = 300): DeepSeekTurnDomHealthTracker {
  return new DeepSeekTurnDomHealthTracker(
    1_000,
    1_000,
    1_000,
    1_000,
    1_000,
    unchangedRunningResponseMs,
  );
}

describe("DeepSeek bounded browser stall guards", () => {
  test("fails a running response whose literal assistant output stops changing", () => {
    const tracker = healthTracker();

    expect(tracker.update(snapshot(), 0)).toBeUndefined();
    expect(tracker.update(snapshot({ activitySignature: "spinner-frame-2" }), 299)).toBeUndefined();
    expect(tracker.update(snapshot({ activitySignature: "spinner-frame-3" }), 300)).toBe(
      "DeepSeek Web remained active with an unchanged partial response beyond the recovery window",
    );
  });

  test("literal response progress and a non-running handoff reset the stall window", () => {
    const tracker = healthTracker();

    expect(tracker.update(snapshot(), 0)).toBeUndefined();
    expect(tracker.update(snapshot({
      finalHtml: "<p>partial answer</p>",
      finalText: "partial answer",
      finalRawText: "partial answer",
      finalTextLength: 14,
      activitySignature: "partial-answer:running",
    }), 250)).toBeUndefined();
    expect(tracker.update(snapshot({
      finalHtml: "<p>partial answer</p>",
      finalText: "partial answer",
      finalRawText: "partial answer",
      finalTextLength: 14,
      activitySignature: "spinner-only-change",
    }), 549)).toBeUndefined();
    expect(tracker.update(snapshot({ running: false }), 550)).toBeUndefined();
    expect(tracker.update(snapshot(), 600)).toBeUndefined();
    expect(tracker.update(snapshot(), 899)).toBeUndefined();
    expect(tracker.update(snapshot(), 900)).toContain("unchanged partial response");
  });

  test("caps persistent in-page Retry clicks with a small per-turn budget", () => {
    const budget = new DeepSeekRetryClickBudget();

    expect(budget.limit).toBe(DEEPSEEK_MAX_RETRY_CLICKS);
    expect(budget.used).toBe(0);
    expect(budget.exhausted).toBe(false);
    for (let attempt = 1; attempt <= DEEPSEEK_MAX_RETRY_CLICKS; attempt += 1) {
      expect(budget.recordClick()).toBe(attempt);
    }
    expect(budget.exhausted).toBe(true);
    expect(() => budget.recordClick()).toThrow("Retry click budget is exhausted");
  });

  test("stall guard failures remain non-retryable after prompt submission", () => {
    const classified = classifiedDeepSeekError(new DeepSeekBrowserTurnFailure(
      "DeepSeek Web failed after submission was attempted; automatic retry is disabled to avoid duplicate prompts: "
        + "DeepSeek Web remained active with an unchanged partial response beyond the recovery window",
      true,
    ));

    expect(classified.retryable).toBe(false);
    expect(classified.code).toBe("invalid_prompt");
    expect(classified.status).toBe(400);
  });
});
