import { describe, expect, test } from "bun:test";
import { parseGuiSetupRequest } from "../src/gui-control";

describe("DeepSeek Web GUI setup contract", () => {
  test("accepts independent enable, login refresh, and acknowledgement fields", () => {
    expect(parseGuiSetupRequest({
      mode: "browser-only",
      acknowledgedUnofficial: true,
      deepSeekEnabled: true,
      forceDeepSeekLogin: true,
      acknowledgedDeepSeek: true,
    })).toEqual({
      mode: "browser-only",
      acknowledgedUnofficial: true,
      deepSeekEnabled: true,
      forceDeepSeekLogin: true,
      acknowledgedDeepSeek: true,
    });
  });

  test("rejects non-boolean DeepSeek fields", () => {
    expect(() => parseGuiSetupRequest({
      mode: "browser-only",
      acknowledgedUnofficial: true,
      deepSeekEnabled: "yes",
    })).toThrow("deepSeekEnabled must be a boolean");
    expect(() => parseGuiSetupRequest({
      mode: "browser-only",
      acknowledgedUnofficial: true,
      forceDeepSeekLogin: 1,
    })).toThrow("forceDeepSeekLogin must be a boolean");
    expect(() => parseGuiSetupRequest({
      mode: "browser-only",
      acknowledgedUnofficial: true,
      acknowledgedDeepSeek: "yes",
    })).toThrow("acknowledgedDeepSeek must be a boolean");
  });
});
