import { describe, expect, test } from "bun:test";
import {
  CHATGPT_LOGIN_VERIFICATION_HEADLESS,
  normalChromeLoginArguments,
} from "../src/browser-login";
import {
  chatGptReauthenticationMessage,
  GOOGLE_SECURE_BROWSER_RELOGIN_MESSAGE,
  isGoogleAccountSignInUrl,
} from "../src/chatgpt-session";

describe("Google secure-browser login boundary", () => {
  test("recognizes only the real Google Accounts sign-in host", () => {
    expect(isGoogleAccountSignInUrl("https://accounts.google.com/v3/signin/identifier")).toBe(true);
    expect(isGoogleAccountSignInUrl("https://accounts.google.com/o/oauth2/v2/auth?client_id=test")).toBe(true);
    expect(isGoogleAccountSignInUrl("https://accounts.google.com.evil.example/signin")).toBe(false);
    expect(isGoogleAccountSignInUrl("https://chatgpt.com/auth/login")).toBe(false);
  });

  test("manual login Chrome arguments contain no automation or remote-debugging switches", () => {
    const args = normalChromeLoginArguments("C:\\tmp\\chatgpt-login-profile");
    expect(args.some(arg => /remote-debugging|enable-automation|automationcontrolled|webdriver/i.test(arg))).toBe(false);
    expect(args.some(arg => arg.startsWith("--user-data-dir="))).toBe(true);
  });

  test("keeps the post-login ChatGPT verification launches visible", () => {
    expect(CHATGPT_LOGIN_VERIFICATION_HEADLESS).toBe(false);
  });

  test("Google redirects explain the required normal-Chrome reauthentication path", () => {
    expect(chatGptReauthenticationMessage("https://accounts.google.com/signin/v2/identifier"))
      .toBe(GOOGLE_SECURE_BROWSER_RELOGIN_MESSAGE);
    expect(chatGptReauthenticationMessage("https://chatgpt.com/"))
      .toContain("codex-chatgpt-web login");
  });
});
