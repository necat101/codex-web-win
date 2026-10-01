/**
 * Cloudflare / edge-interstitial detection shared by the browser and Node
 * request paths.
 *
 * ChatGPT's backend now answers some non-browser or otherwise disliked traffic
 * with a generic `cloudflare_challenge` error or a challenge interstitial
 * instead of the expected JSON/SSE. The harness never tries to solve or bypass
 * that challenge (see README security model); this module exists so the harness
 * can detect it, report it once, and stop instead of forwarding challenge HTML
 * or looping forever inside Codex's own retry budget.
 */

export const CLOUDFLARE_CHALLENGE_CODE = "cloudflare_challenge";

/** Human-readable, actionable message reused by every surface that reports it. */
export const CLOUDFLARE_CHALLENGE_MESSAGE =
  "ChatGPT's edge returned a Cloudflare challenge instead of an API response "
  + "(`cloudflare_challenge`). This typically means the account/session or the "
  + "automated traffic is being challenged and must be cleared interactively. "
  + "Open the controlled Chrome window, finish the \"Verify you are human\" step "
  + "on chatgpt.com, confirm the composer loads, then retry. The harness will not "
  + "solve or bypass the challenge automatically.";

interface ChallengeTextSignal {
  /** Short label recorded in diagnostics. */
  label: string;
  pattern: RegExp;
}

/**
 * Ordered strongest-first. `cloudflare_challenge` is the explicit machine code
 * and always wins; the remaining markers cover the HTML interstitial variants.
 */
const CHALLENGE_TEXT_SIGNALS: readonly ChallengeTextSignal[] = [
  { label: "cloudflare_challenge", pattern: /cloudflare[_\s-]?challenge/i },
  { label: "cf-mitigated: challenge", pattern: /cf-mitigated[\s"':]*challenge/i },
  { label: "Enable JavaScript and cookies", pattern: /enable javascript and cookies to continue/i },
  { label: "Just a moment", pattern: /\bjust a moment\b/i },
  { label: "Checking your browser", pattern: /checking (?:your browser|if the site connection is secure)/i },
  { label: "Verify you are human", pattern: /verify (?:you are|that you are) (?:a )?human/i },
  { label: "Unusual traffic", pattern: /unusual traffic/i },
  { label: "Captcha challenge", pattern: /\bcaptcha[\s-]*challenge\b/i },
  // NOTE: Cloudflare injects a `challenge-platform` script into otherwise
  // healthy responses, so its mere presence is NOT a signal. Only the
  // human-visible interstitial text above reliably distinguishes a real
  // challenge.
  { label: "cf challenge token", pattern: /__cf_chl|\bcf_chl\b|\bcf-chl-/i },
];

const CHALLENGE_HEADER_NAME = "cf-mitigated";

/**
 * Return a short label when `text` carries a challenge signal, else undefined.
 * Works on headers, JSON error bodies, HTML interstitials, and visible page text.
 */
export function cloudflareChallengeSignal(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  for (const signal of CHALLENGE_TEXT_SIGNALS) {
    if (signal.pattern.test(text)) return signal.label;
  }
  return undefined;
}

/** True when `cf-mitigated: challenge` (or equivalent) is present. */
export function cloudflareChallengeFromHeaders(
  headers: Headers | { get(name: string): string | null },
): string | undefined {
  const mitigated = headers.get(CHALLENGE_HEADER_NAME);
  if (mitigated && /challenge/i.test(mitigated)) return "cf-mitigated: challenge";
  return undefined;
}

/**
 * Classify a completed upstream response. A challenge is only credible on a
 * non-2xx status; successful JSON that merely mentions Cloudflare is ignored.
 */
export function cloudflareChallengeFromResponse(
  status: number,
  headers: Headers | { get(name: string): string | null },
  bodyText?: string | null,
): string | undefined {
  if (status >= 200 && status < 300) return undefined;
  return cloudflareChallengeFromHeaders(headers) ?? cloudflareChallengeSignal(bodyText);
}

/** True when an adapter/upstream error message is a Cloudflare challenge. */
export function isCloudflareChallengeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return cloudflareChallengeSignal(message) !== undefined;
}

/** True when a challenge label came from the explicit machine-readable code. */
export function isExplicitCloudflareChallengeCode(signal: string | undefined): boolean {
  return signal === "cloudflare_challenge";
}

/**
 * Cap how much of an upstream error body is read while looking for markers.
 * Challenge interstitials are small; a large body is never a challenge.
 */
export const CLOUDFLARE_CHALLENGE_BODY_READ_LIMIT = 64 * 1024;

/**
 * Read at most {@link CLOUDFLARE_CHALLENGE_BODY_READ_LIMIT} bytes of a clone of
 * the response body so the caller can still consume the original stream.
 */
export async function readCloudflareChallengeBody(response: Response): Promise<string | undefined> {
  if (!response.body) return undefined;
  const length = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(length) && length > CLOUDFLARE_CHALLENGE_BODY_READ_LIMIT) return undefined;
  try {
    const reader = response.clone().body?.getReader();
    if (!reader) return undefined;
    const decoder = new TextDecoder();
    let text = "";
    let read = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      read += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (read >= CLOUDFLARE_CHALLENGE_BODY_READ_LIMIT) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
    return text;
  } catch {
    return undefined;
  }
}
