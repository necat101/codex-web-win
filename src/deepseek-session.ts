import type { Locator, Page } from "playwright-core";

export const DEEPSEEK_HOME_URL = "https://chat.deepseek.com/";
export const DEEPSEEK_COMPOSER_SELECTOR = [
  'textarea[name="search"]',
  'textarea[placeholder*="DeepSeek" i]',
  '[contenteditable="true"][role="textbox"]',
].join(", ");

/**
 * Keep authentication and composer detection in one place. DeepSeek regularly
 * renames generated CSS classes, so the primary selectors use stable form
 * semantics and the observed class is only a final compatibility fallback.
 */
export function deepSeekComposer(page: Page): Locator {
  return page.locator(DEEPSEEK_COMPOSER_SELECTOR).filter({ visible: true }).first();
}

export function deepSeekSignInUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "chat.deepseek.com" && /(?:^|\/)sign_in(?:\/|$)/.test(parsed.pathname);
  } catch {
    return false;
  }
}

const DEEPSEEK_SECURITY_SIGNAL =
  /(?:access denied|request blocked|aws\s*waf|verify you are human|security verification|captcha\s+(?:required|challenge)|^captcha$|^just a moment(?:\.\.\.)?$)/i;

/**
 * Match only strong security-check language. In particular, do not treat generic
 * words such as "forbidden" as a challenge: they can legitimately appear in a
 * user's prompt or in DeepSeek's answer.
 */
export function deepSeekSecurityChallengeSignal(text: string): string | undefined {
  return text.match(DEEPSEEK_SECURITY_SIGNAL)?.[0];
}

/**
 * Detect an interactive access-control surface without scanning chat messages.
 * A response can discuss CAPTCHA/WAF concepts as ordinary text, so challenge
 * detection is limited to the title, explicit challenge widgets, and visible
 * top-level alert/dialog/heading surfaces outside `.ds-message`.
 */
export async function deepSeekSecurityChallenge(page: Page): Promise<string | undefined> {
  const signals = await page.evaluate(() => {
    const visible = (element: Element): boolean => {
      const candidate = element as HTMLElement;
      const style = getComputedStyle(candidate);
      const rect = candidate.getBoundingClientRect();
      return style.visibility !== "hidden"
        && style.display !== "none"
        && rect.width > 0
        && rect.height > 0;
    };
    const values: string[] = [];
    if (document.title) values.push(document.title);

    const structuralChallenge = [...document.querySelectorAll<HTMLElement>([
      'iframe[src*="captcha" i]',
      'iframe[src*="turnstile" i]',
      'iframe[src*="challenge-platform" i]',
      '[id*="captcha" i]',
      '[data-testid*="captcha" i]',
      '[class*="captcha" i]',
    ].join(", "))].some(visible);
    if (structuralChallenge) values.push("captcha challenge");

    const surfaces = [...document.querySelectorAll<HTMLElement>('h1, h2, [role="alert"], [role="dialog"]')];
    for (const surface of surfaces.slice(0, 64)) {
      if (!visible(surface) || surface.closest(".ds-message")) continue;
      const text = (surface.innerText ?? surface.textContent ?? "").replace(/\s+/g, " ").trim();
      if (text) values.push(text.slice(0, 1_000));
    }
    return values;
  }).catch(() => [] as string[]);

  for (const signal of signals) {
    const matched = deepSeekSecurityChallengeSignal(signal);
    if (matched) return matched;
  }
  return undefined;
}

export async function assertAuthenticatedDeepSeekPage(page: Page): Promise<void> {
  if (deepSeekSignInUrl(page.url())) {
    throw new Error("DeepSeek Web login is required");
  }
  const composer = deepSeekComposer(page);
  try {
    await composer.waitFor({ state: "visible", timeout: 60_000 });
  } catch {
    const signInForm = page.getByRole("textbox", { name: /Phone number|email address/i })
      .or(page.getByRole("textbox", { name: "Password" }))
      .or(page.getByRole("button", { name: "Log in", exact: true }));
    if (await signInForm.first().isVisible().catch(() => false)) {
      throw new Error("DeepSeek Web login is required");
    }
    const blocked = await deepSeekSecurityChallenge(page);
    if (blocked) {
      throw new Error(`DeepSeek Web is blocked by an interactive security check: ${blocked}`);
    }
    throw new Error("DeepSeek Web login is expired or the message composer is unavailable");
  }
  if (!await composer.isEditable().catch(() => false)) {
    throw new Error("DeepSeek Web UI contract drift: the visible message composer is not editable");
  }
  if (deepSeekSignInUrl(page.url())) {
    throw new Error("DeepSeek Web login is required");
  }
}
