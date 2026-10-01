import { describe, expect, test } from "bun:test";
import {
  applyAutomationSignalSuppression,
  automationSuppressionIgnoredArgs,
  automationSuppressionLaunchArgs,
} from "../src/browser-automation-signals";

describe("automation signal suppression", () => {
  test("opts out of the AutomationControlled blink feature", () => {
    expect(automationSuppressionLaunchArgs()).toContain("--disable-blink-features=AutomationControlled");
  });

  test("names --enable-automation so a future Playwright default cannot reintroduce it", () => {
    expect(automationSuppressionIgnoredArgs()).toContain("--enable-automation");
  });

  test("injects a webdriver mask into the context before any page script", async () => {
    const scripts: string[] = [];
    await applyAutomationSignalSuppression({ addInitScript: async (script: string) => { scripts.push(script); } });
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain("navigator");
    expect(scripts[0]).toContain("webdriver");
  });

  test("never throws when the context cannot accept an init script", async () => {
    await expect(applyAutomationSignalSuppression({
      addInitScript: async () => { throw new Error("context closed"); },
    })).resolves.toBeUndefined();
  });
});
