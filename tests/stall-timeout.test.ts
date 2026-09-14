import { describe, expect, test } from "bun:test";
import { resolveStallTimeoutSec } from "../src/stall-timeout";

describe("Responses watchdog configuration", () => {
  test.each([undefined, 0, -1, NaN, Infinity])("%s disables the watchdog", value => {
    expect(resolveStallTimeoutSec(value)).toBeUndefined();
  });
  test("positive deadlines remain available", () => {
    expect(resolveStallTimeoutSec(0.1)).toBe(1);
    expect(resolveStallTimeoutSec(2.1)).toBe(3);
  });
});
