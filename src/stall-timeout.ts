/**
 * Bridge upstream stall budget: seconds of silence (no adapter events) before the
 * Responses bridge emits `response.incomplete` / `upstream_stall_timeout`.
 *
 * Silence is normal during browser reasoning and native/MCP tool waits. Keep
 * the watchdog disabled unless explicitly configured. In particular, zero
 * means disabled; comparing a tick counter against zero terminates healthy
 * turns after the first quiet heartbeat interval.
 */
export const DEFAULT_STALL_TIMEOUT_SEC: undefined = undefined;

/**
 * Resolve the effective bridge stall deadline for a turn.
 * - unset / non-finite / non-positive config → disabled (legacy zero supported)
 * - positive config → ceil, minimum 1 second
 */
export function resolveStallTimeoutSec(configuredSec: number | undefined): number | undefined {
  if (typeof configuredSec === "number" && Number.isFinite(configuredSec) && configuredSec > 0) {
    return Math.ceil(configuredSec);
  }
  return DEFAULT_STALL_TIMEOUT_SEC;
}
