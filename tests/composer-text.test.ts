import { describe, expect, test } from "bun:test";
import {
  browserComposerTextMatches,
  normalizeBrowserComposerText,
} from "../src/adapters/composer-text";

describe("browser composer text fidelity", () => {
  test("accepts browser line-ending normalization without accepting truncation", () => {
    const expected = "first\r\nsecond\rthird\nfourth";
    const observed = "first\nsecond\nthird\nfourth";

    expect(normalizeBrowserComposerText(expected)).toBe(observed);
    expect(browserComposerTextMatches(expected, observed)).toBe(true);
    expect(browserComposerTextMatches(expected, observed.slice(0, -1))).toBe(false);
  });

  test("reproduces the 35511/35523 DeepSeek false rejection", () => {
    const payload = "x".repeat(35_499);
    const expected = payload + "\r\n".repeat(12);
    const observed = payload + "\n".repeat(12);

    expect(expected.length).toBe(35_523);
    expect(observed.length).toBe(35_511);
    expect(browserComposerTextMatches(expected, observed)).toBe(true);
  });

  test("does not normalize ordinary prompt characters", () => {
    expect(browserComposerTextMatches("alpha  beta", "alpha beta")).toBe(false);
    expect(browserComposerTextMatches("alpha", "Alpha")).toBe(false);
  });
});
