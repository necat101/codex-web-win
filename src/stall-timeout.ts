/**
 * Bridge upstream stall budget: seconds of silence (no adapter events) before the
 * Responses bridge emits `response.incomplete` / `upstream_stall_timeout`.
 *
 * Raised from 90s so long reasoning + large tool writes are not cut mid-turn.
 * Hung streams still depend on the transport/process lifecycle; this bridge
 * timeout no longer creates an artificial execution cutoff.
 */
export const DEFAULT_STALL_TIMEOUT_SEC = 0;

/**
 * Resolve the effective bridge stall deadline for a turn.
 * - unset / non-finite config → {@link DEFAULT_STALL_TIMEOUT_SEC}
 * - finite config → ceil, minimum 0
 */
export function resolveStallTimeoutSec(configuredSec: number | undefined): number {
  if (typeof configuredSec === "number" && Number.isFinite(configuredSec)) {
    return Math.max(0, Math.ceil(configuredSec));
  }
  return DEFAULT_STALL_TIMEOUT_SEC;
}
