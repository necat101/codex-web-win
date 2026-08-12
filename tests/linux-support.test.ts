import { describe, expect, test } from "bun:test";
import { defaultBrowserHeaded, defaultChromeExecutable } from "../src/config";
import { externalUrlOpenCommand } from "../src/process";

describe("Linux browser defaults", () => {
  test("uses headless controlled browser turns by default", () => {
    expect(defaultBrowserHeaded("linux")).toBe(false);
    expect(defaultBrowserHeaded("darwin")).toBe(true);
    expect(defaultBrowserHeaded("win32")).toBe(true);
  });

  test("honors an installed CHROME_BIN before distro fallback paths", () => {
    expect(defaultChromeExecutable("linux", { CHROME_BIN: process.execPath })).toBe(process.execPath);
  });

  test("opens browser-facing setup links with xdg-open on Linux", () => {
    expect(externalUrlOpenCommand("https://chatgpt.com/", "linux")).toEqual({
      command: "xdg-open",
      args: ["https://chatgpt.com/"],
    });
  });
});
