import type { Locator, Page } from "playwright-core";

export const CHATGPT_TEMPORARY_CHAT_URL = "https://chatgpt.com/?temporary-chat=true&surface=chat";

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
  const loginButtons = page.getByRole("button", { name: "Log in", exact: true });
  if (await anyVisible(loginButtons)) {
    throw new Error(chatGptReauthenticationMessage(page.url()));
  }

  const accountControl = page.getByRole("button", { name: /(?:profile|account) menu/i }).or(
    page.locator('[data-testid="profile-button"], button[aria-label*="account" i]'),
  );

  if (!await anyVisible(accountControl)) {
    throw new Error("ChatGPT authentication could not be verified: no visible account control is present");
  }
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
  const effortButton = page.getByRole("button", {
    name: /^(?:Instant(?:\s+5\.5)?|Medium|High|Extra High|Pro)$/,
  }).last();

  await effortButton.waitFor({ state: "visible", timeout: 30_000 });
  await effortButton.click();

  try {
    const pro = page.getByRole("menuitem", { name: "Pro", exact: true }).or(
      page.getByRole("menuitemradio", { name: "Pro", exact: true }),
    ).last();

    return await pro.isVisible().catch(() => false);
  } finally {
    await page.keyboard.press("Escape").catch(() => {});
  }
}
