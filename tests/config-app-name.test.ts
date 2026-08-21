import { describe, expect, test } from "bun:test";
import { defaultAppName } from "../src/config";

describe("machine-specific connector defaults", () => {
  test("adds a stable sanitized machine suffix", () => {
    expect(defaultAppName("LAPTOP-01")).toBe("Codex Native LAPTOP-01");
    expect(defaultAppName(" Friend Laptop ")).toBe("Codex Native Friend-Laptop");
  });

  test("falls back to the legacy name if no usable machine name exists", () => {
    expect(defaultAppName("   ")).toBe("Codex Native");
  });
});
