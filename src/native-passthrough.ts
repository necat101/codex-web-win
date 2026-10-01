import {
  CLOUDFLARE_CHALLENGE_CODE,
  CLOUDFLARE_CHALLENGE_MESSAGE,
  cloudflareChallengeFromHeaders,
  cloudflareChallengeSignal,
  readCloudflareChallengeBody,
} from "./cloudflare-challenge";

const CODEX_BACKEND = "https://chatgpt.com/backend-api/codex";
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

export type NativeFetch = (request: Request) => Promise<Response>;
export type NativeCodexEndpoint = "models" | "responses" | "responses/compact";

function endToEndHeaders(source: Headers): Headers {
  const headers = new Headers();
  for (const [name, value] of source) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) headers.append(name, value);
  }
  headers.delete("content-length");
  return headers;
}

/**
 * A Cloudflare interstitial is HTML/plain text, never the JSON or SSE Codex
 * expects. Sniff it so the challenge body is never forwarded downstream, where
 * Node's fetch would surface it as an opaque "error decoding response body" and
 * feed Codex's own retry budget.
 *
 * Only bodies that could plausibly be an interstitial are inspected. Streaming
 * SSE and other large payloads are left as a pass-through stream.
 */
async function upstreamCloudflareChallenge(upstream: Response): Promise<string | undefined> {
  const header = cloudflareChallengeFromHeaders(upstream.headers);
  if (header) return header;
  const contentType = (upstream.headers.get("content-type") ?? "").toLowerCase();
  const inspectable = !upstream.ok
    || contentType.includes("text/html")
    || contentType.includes("text/plain");
  if (!inspectable) return undefined;
  return cloudflareChallengeSignal(await readCloudflareChallengeBody(upstream));
}

/**
 * Fail closed on a detected challenge. Codex recognizes neither the challenge
 * HTML nor a generic 5xx as terminal, so return an explicit JSON error carrying
 * the machine-readable `cloudflare_challenge` code and a status Codex treats as
 * non-retryable, instead of looping the same request forever.
 */
function cloudflareChallengeResponse(signal: string): Response {
  return new Response(JSON.stringify({
    error: {
      message: `${CLOUDFLARE_CHALLENGE_MESSAGE} (detected: ${signal})`,
      type: "invalid_request_error",
      code: CLOUDFLARE_CHALLENGE_CODE,
    },
  }), {
    // 403 is terminal for Codex; 429/5xx would re-enter its retry budget.
    status: 403,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export async function forwardNativeCodexRequest(
  request: Request,
  endpoint: NativeCodexEndpoint,
  fetchUpstream: NativeFetch = fetch,
): Promise<Response> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ") || authorization.length <= "Bearer ".length) {
    throw new Error("Native Codex passthrough requires the incoming Bearer authorization");
  }

  const incomingUrl = new URL(request.url);
  const headers = endToEndHeaders(request.headers);
  // Node's fetch transparently decodes compressed response bodies while
  // retaining the upstream content-encoding header. Request identity bytes so
  // the streamed body and the headers exposed to Codex cannot disagree.
  headers.set("accept-encoding", "identity");
  if (endpoint === "models") headers.delete("if-none-match");
  const method = endpoint === "models" ? "GET" : "POST";
  const body = method === "POST" ? await request.arrayBuffer() : undefined;
  const upstreamRequest = new Request(`${CODEX_BACKEND}/${endpoint}${incomingUrl.search}`, {
    method,
    headers,
    ...(body ? { body } : {}),
    signal: request.signal,
  });
  const upstream = await fetchUpstream(upstreamRequest);
  const challenge = await upstreamCloudflareChallenge(upstream);
  if (challenge) {
    await upstream.body?.cancel().catch(() => {});
    return cloudflareChallengeResponse(challenge);
  }
  const responseHeaders = endToEndHeaders(upstream.headers);
  responseHeaders.delete("content-encoding");
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
