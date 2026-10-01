import type { Locator, Page } from "playwright-core";
import { CLOUDFLARE_CHALLENGE_MESSAGE, cloudflareChallengeSignal } from "./cloudflare-challenge";

// CODEX_WEB_WIN_CHATGPT_UI_2026_09_25_V7
// Compatibility selectors mirrored from the current ChatGPT web layout while
// retaining this fork's normal-Chrome login/session architecture.
export const CHATGPT_TEMPORARY_CHAT_URL = "https://chatgpt.com/?temporary-chat=true";

export const CHATGPT_COMPOSER_SELECTOR = [
  '[data-testid="prompt-textarea"]',
  "#prompt-textarea",
  '[contenteditable="true"][data-lexical-editor="true"]',
  'form[data-chatgpt-composer] [data-composer-markdown][contenteditable="true"][role="textbox"]',
].join(", ");

export const CHATGPT_EFFORT_CONTROL_SELECTOR = [
  'button[aria-haspopup="menu"][data-tone="neutral"]',
  'button[data-testid="model-switcher-dropdown-button"][aria-haspopup="menu"]',
  'button[data-codex-intelligence-trigger="true"][data-composer-navigation-target="reasoning"][aria-haspopup="menu"]',
].join(", ");

export const CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR =
  '[data-model-reasoning-effort-slider], [data-model-picker-power-slider]';

export const CHATGPT_SEND_BUTTON_SELECTOR =
  '[data-testid="send-button"], button[type="submit"]';

export const CHATGPT_STOP_BUTTON_SELECTOR = [
  '[data-testid="stop-button"]',
  'form[data-chatgpt-composer] button[type="button"][aria-label="Stop"]',
  'button[aria-label="Stop answering"]',
  'button[aria-label="Stop generating"]',
].join(", ");

export const CHATGPT_COMPLETION_ACTION_SELECTOR = [
  'button[data-testid="copy-turn-action-button"]',
  'button[aria-label="Copy response"]',
  '[data-turn-key] .turn-action-controls button',
].join(", ");

export const CHATGPT_ASSISTANT_TURN_SELECTOR = [
  '[data-testid^="conversation-turn-"][data-turn="assistant"]:not([data-turn-key] *)',
  '[data-testid^="conversation-turn-"][data-message-author-role="assistant"]:not([data-turn-key] *)',
  '[data-testid^="conversation-turn-"]:has([data-message-author-role="assistant"]):not([data-turn-key] *)',
  '[data-turn-key]:has([data-conversation-role="assistant"])',
].join(", ");

export const CHATGPT_USER_TURN_SELECTOR = [
  '[data-testid^="conversation-turn-"][data-turn="user"]:not([data-turn-key] *)',
  '[data-testid^="conversation-turn-"][data-message-author-role="user"]:not([data-turn-key] *)',
  '[data-testid^="conversation-turn-"]:has([data-message-author-role="user"]):not([data-turn-key] *)',
  '[data-turn-key]:has([data-user-message-bubble])',
].join(", ");

export const GOOGLE_SECURE_BROWSER_RELOGIN_MESSAGE =
  "Google sign-in cannot be completed inside the automation-controlled browser. "
  + "Run `codex-chatgpt-web login`, finish Google/ChatGPT sign-in in the normal Chrome window it opens, "
  + "wait until the ChatGPT composer is visible, then close that dedicated Chrome window.";

export function isGoogleAccountSignInUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.toLowerCase() === "accounts.google.com";
  } catch {
    return false;
  }
}

export function chatGptReauthenticationMessage(currentUrl: string): string {
  if (isGoogleAccountSignInUrl(currentUrl)) return GOOGLE_SECURE_BROWSER_RELOGIN_MESSAGE;
  return "ChatGPT web login is expired. Run `codex-chatgpt-web login` to refresh it in a normal Chrome window.";
}

/**
 * Detect a Cloudflare/edge challenge interstitial in the page. The probe is
 * intentionally self-contained so Playwright can serialize it into the page.
 * Returns a short signal label (for diagnostics) or undefined when the page is
 * free of challenge markers. It never solves or bypasses the challenge.
 */
export async function chatGptCloudflareChallengeSignal(page: Page): Promise<string | undefined> {
  return page.evaluate(() => {
    const patterns: Array<{ label: string; pattern: RegExp }> = [
      { label: "cloudflare_challenge", pattern: /cloudflare[\s_-]?challenge/i },
      { label: "cf-mitigated: challenge", pattern: /cf-mitigated[\s"':]*challenge/i },
      { label: "Enable JavaScript and cookies", pattern: /enable javascript and cookies to continue/i },
      { label: "Just a moment", pattern: /\bjust a moment\b/i },
      { label: "Checking your browser", pattern: /checking (?:your browser|if the site connection is secure)/i },
      { label: "Verify you are human", pattern: /verify (?:you are|that you are) (?:a )?human/i },
      { label: "Unusual traffic", pattern: /unusual traffic/i },
      { label: "Captcha challenge", pattern: /\bcaptcha[\s-]*challenge\b/i },
    ];
    const visible = (element: Element): boolean => {
      const candidate = element as HTMLElement;
      if (typeof candidate.checkVisibility === "function") {
        return candidate.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true });
      }
      const style = getComputedStyle(candidate);
      const rect = candidate.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };

    const surface = `${document.title ?? ""}\n${document.body?.innerText ?? ""}`;
    for (const { label, pattern } of patterns) {
      if (pattern.test(surface)) return label;
    }

    // Cloudflare's full-page interstitial exposes these specific nodes. Do NOT
    // treat Cloudflare's always-injected `challenge-platform` script, Turnstile
    // iframes, or generic "challenge" attributes as signals: they are present on
    // entirely healthy ChatGPT pages and previously produced false positives
    // that aborted setup before the user could do anything.
    const interstitial = document.querySelector<HTMLElement>(
      '#challenge-form, #challenge-stage, #challenge-error-text, [id^="cf-chl-"],'
      + ' .cf-challenge, [data-translate="checking_browser"], [data-translate="verify_you_are_human"]',
    );
    if (interstitial && visible(interstitial)) return "interstitial challenge node";

    // The interstitial document (not the normal app) lives under the
    // challenge-platform path or carries a `__cf_chl` token.
    const path = `${location.pathname}${location.search}`;
    if (/\/cdn-cgi\/challenge-platform\//.test(path) || /__cf_chl|cf_chl_/.test(path)) {
      return "challenge url";
    }
    return undefined;
  }).catch(() => undefined);
}

/**
 * Wait, up to `timeoutMs`, for a real-Chrome challenge to clear on its own.
 * Managed (non-interactive) challenges usually resolve in a few seconds. Returns
 * the lingering signal when it never clears.
 */
export async function waitForCloudflareChallengeToClear(
  page: Page,
  timeoutMs = 30_000,
): Promise<string | undefined> {
  let signal = await chatGptCloudflareChallengeSignal(page);
  if (!signal) return undefined;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(500).catch(() => undefined);
    signal = await chatGptCloudflareChallengeSignal(page);
    if (!signal) return undefined;
  }
  return signal;
}

/** Throw the shared Cloudflare challenge error when the page is challenged. */
export async function assertNoChatGptCloudflareChallenge(
  page: Page,
  timeoutMs = 30_000,
): Promise<void> {
  const signal = await waitForCloudflareChallengeToClear(page, timeoutMs);
  if (signal) throw new Error(chatGptCloudflareChallengeMessage(signal));
}

/** Compose the actionable challenge error, preserving the detected signal. */
export function chatGptCloudflareChallengeMessage(signal: string): string {
  return `${CLOUDFLARE_CHALLENGE_MESSAGE} (detected: ${signal})`;
}

/** True when an error thrown by this module is the Cloudflare challenge error. */
export function isChatGptCloudflareChallengeMessage(message: string): boolean {
  return cloudflareChallengeSignal(message) !== undefined;
}

async function anyVisible(locator: Locator): Promise<boolean> {
  return locator.evaluateAll(elements => elements.some(element => {
    const candidate = element as HTMLElement;
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
  })).catch(() => false);
}

export async function assertAuthenticatedChatGptPage(page: Page): Promise<void> {
  if (isGoogleAccountSignInUrl(page.url())) {
    throw new Error(GOOGLE_SECURE_BROWSER_RELOGIN_MESSAGE);
  }

  // A challenge interstitial hides the composer and previously produced a
  // misleading "no visible composer" error. Report the real cause instead.
  const challenge = await chatGptCloudflareChallengeSignal(page);
  if (challenge) throw new Error(chatGptCloudflareChallengeMessage(challenge));

  // Current ChatGPT no longer guarantees the old profile/account button or the
  // old "Chat with ChatGPT" accessible name. The visible composer is the stable
  // authenticated-page contract used by the current upstream UI adapter.
  const composer = page.locator(CHATGPT_COMPOSER_SELECTOR);
  if (await anyVisible(composer)) return;

  const loginButtons = page.getByRole("button", { name: "Log in", exact: true });
  if (await anyVisible(loginButtons)) {
    throw new Error(chatGptReauthenticationMessage(page.url()));
  }

  throw new Error("ChatGPT authentication could not be verified: no visible composer is present");
}

function isTemporaryChatUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const expected = new URL(CHATGPT_TEMPORARY_CHAT_URL);
    return url.origin === expected.origin
      && url.pathname === expected.pathname
      && url.searchParams.get("temporary-chat") === "true"
      && url.searchParams.get("surface") !== "work";
  } catch {
    return false;
  }
}

export async function assertTemporaryChatPage(page: Page): Promise<void> {
  /*
   * Temporary Chat's public UI is volatile. Older builds exposed a large
   * heading named "Temporary Chat"; newer builds may show only the Temporary
   * mode control. The query parameter is the stable isolation contract used
   * by this project, so do not block on presentation text.
   */
  const deadline = Date.now() + 20_000;
  let observedUrl = page.url();

  while (Date.now() < deadline) {
    observedUrl = page.url();
    if (isTemporaryChatUrl(observedUrl)) return;
    await page.waitForTimeout(100);
  }

  throw new Error(`ChatGPT left the isolated Temporary Chat surface (${observedUrl})`);
}

export async function detectChatGptProCapability(page: Page): Promise<boolean> {
  await assertAuthenticatedChatGptPage(page);

  const composer = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true }).first();
  const composerForm = composer.locator("xpath=ancestor::form[1]");

  let effortButton = composerForm.locator(CHATGPT_EFFORT_CONTROL_SELECTOR).filter({ visible: true }).last();
  if (!await effortButton.isVisible().catch(() => false)) {
    // Compatibility fallback for the immediately previous picker.
    effortButton = page.getByRole("button", {
      name: /^(?:Instant(?:\s+5\.\d+)?|Medium|High|Extra High|Pro)$/,
    }).last();
    if (!await effortButton.waitFor({ state: "visible", timeout: 5_000 }).then(() => true).catch(() => false)) {
      return false;
    }
  }

  await effortButton.click({ force: true, timeout: 5_000 }).catch(async () => {
    await effortButton.press("Enter", { timeout: 5_000 });
  });

  try {
    // Current picker: five-position structural power/reasoning slider.
    const sliderContainer = page.locator(CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR)
      .filter({ visible: true }).last();
    const modern = await sliderContainer.waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true).catch(() => false);

    if (modern) {
      const slider = sliderContainer.locator('[role="slider"]').first();
      await slider.waitFor({ state: "attached", timeout: 5_000 });
      const min = Number(await slider.getAttribute("aria-valuemin"));
      const max = Number(await slider.getAttribute("aria-valuemax"));
      if (!Number.isInteger(min) || !Number.isInteger(max) || max < min || max - min + 1 < 5) {
        return false;
      }

      const locks = await sliderContainer.evaluate(container => {
        const power = container.hasAttribute("data-model-picker-power-slider")
          && Boolean(container.querySelector('[data-orientation="horizontal"][aria-disabled="false"]'));
        return Array.from(container.querySelectorAll("[data-selected]"), tick =>
          tick.getAttribute("data-locked") ?? (power ? "false" : null));
      }).catch(() => [] as Array<string | null>);

      return locks.length >= 5 ? locks[4] === "false" : false;
    }

    // Legacy picker fallback.
    const pro = page.getByRole("menuitem", { name: "Pro", exact: true }).or(
      page.getByRole("menuitemradio", { name: "Pro", exact: true }),
    ).last();
    return await pro.isVisible().catch(() => false);
  } finally {
    await page.keyboard.press("Escape").catch(() => {});
  }
}