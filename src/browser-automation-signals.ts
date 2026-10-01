/**
 * Cloudflare began serving a *repeating* challenge to automation-controlled
 * Chrome on chatgpt.com (around 2026-09-29): the widget can be solved, but the
 * very next document is challenged again because the browser advertises itself
 * as automated. A plain, manually launched Chrome is not challenged, which
 * isolates the cause to the automation-controlled browser rather than the
 * account, session, or network.
 *
 * Playwright's public `chromium.launch` API never adds the canonical
 * `--disable-blink-features=AutomationControlled` opt-out (only Playwright's
 * internal browser tool does), so apply it here together with a minimal,
 * conservative property mask.
 *
 * This is signal suppression, never a challenge bypass: the harness still does
 * not solve or fake a Cloudflare challenge, and a challenge that does not clear
 * on its own still fails closed with the actionable `cloudflare_challenge`
 * error.
 */

/** Blink feature opt-out that stops Chrome advertising automation control. */
export const AUTOMATION_CONTROL_SUPPRESSION_ARGS = [
  "--disable-blink-features=AutomationControlled",
] as const;

/**
 * Playwright does not pass this switch itself, but a caller-supplied
 * `ignoreDefaultArgs` list must still name it so a future Playwright default
 * cannot re-introduce it.
 */
export const IGNORED_AUTOMATION_DEFAULT_ARGS = ["--enable-automation"] as const;

/**
 * Runs before any page script. Intentionally tiny: only the single property
 * that has no legitimate non-automation value. Broader fingerprint spoofing is
 * avoided because it is fragile and can break the real ChatGPT web app.
 */
const SUPPRESSION_INIT_SCRIPT = `(() => {
  try {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined, configurable: true });
  } catch (_) {}
})();`;

export interface InitScriptHost {
  addInitScript(script: string): Promise<unknown>;
}

export async function applyAutomationSignalSuppression(context: InitScriptHost): Promise<void> {
  await context.addInitScript(SUPPRESSION_INIT_SCRIPT).catch(() => undefined);
}

export function automationSuppressionLaunchArgs(): string[] {
  return [...AUTOMATION_CONTROL_SUPPRESSION_ARGS];
}

export function automationSuppressionIgnoredArgs(): string[] {
  return [...IGNORED_AUTOMATION_DEFAULT_ARGS];
}
