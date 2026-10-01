import { describe, expect, test } from "bun:test";
import {
  CLOUDFLARE_CHALLENGE_BODY_READ_LIMIT,
  CLOUDFLARE_CHALLENGE_CODE,
  cloudflareChallengeFromHeaders,
  cloudflareChallengeFromResponse,
  cloudflareChallengeSignal,
  isCloudflareChallengeError,
  readCloudflareChallengeBody,
} from "../src/cloudflare-challenge";
import {
  classifyError,
  httpStatusFromTerminalError,
  inferHttpStatusFromAdapterMessage,
} from "../src/lib/errors";
import { forwardNativeCodexRequest } from "../src/native-passthrough";

describe("cloudflare challenge detection", () => {
  test("recognizes the explicit machine code and interstitial markers", () => {
    expect(cloudflareChallengeSignal("cloudflare_challenge")).toBe("cloudflare_challenge");
    expect(cloudflareChallengeSignal("error: cf-mitigated: challenge"));
    expect(cloudflareChallengeSignal("<title>Just a moment...</title>"));
    expect(cloudflareChallengeSignal("Enable JavaScript and cookies to continue"));
    expect(cloudflareChallengeSignal("Verify you are human"));
    expect(cloudflareChallengeSignal("Checking your browser before accessing")).toBeDefined();
    expect(cloudflareChallengeSignal("Attention Required! Unusual traffic"));
  });

  test("does not flag Cloudflare's always-injected platform script", () => {
    // ChatGPT loads a `challenge-platform` script on healthy pages; treating its
    // mere presence as a challenge false-positived and aborted setup.
    expect(cloudflareChallengeSignal('<script src="https://chatgpt.com/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1">')).toBeUndefined();
    expect(cloudflareChallengeSignal("challenge-platform")).toBeUndefined();
  });

  test("ignores benign text that merely mentions Cloudflare", () => {
    expect(cloudflareChallengeSignal("Served via Cloudflare, request succeeded")).toBeUndefined();
    expect(cloudflareChallengeSignal("hello world")).toBeUndefined();
    expect(cloudflareChallengeSignal("")).toBeUndefined();
    expect(cloudflareChallengeSignal(undefined)).toBeUndefined();
  });

  test("reads cf-mitigated from response headers", () => {
    expect(cloudflareChallengeFromHeaders(new Headers({ "cf-mitigated": "challenge" }))).toBeDefined();
    expect(cloudflareChallengeFromHeaders(new Headers({ "cf-mitigated": "none" }))).toBeUndefined();
    expect(cloudflareChallengeFromHeaders(new Headers())).toBeUndefined();
  });

  test("only classifies non-2xx responses as challenges", () => {
    const headers = new Headers({ "cf-mitigated": "challenge" });
    expect(cloudflareChallengeFromResponse(403, headers, "Just a moment")).toBeDefined();
    expect(cloudflareChallengeFromResponse(200, headers, "cloudflare_challenge")).toBeUndefined();
  });

  test("detects challenge-shaped errors", () => {
    expect(isCloudflareChallengeError(new Error("cloudflare_challenge during setup"))).toBe(true);
    expect(isCloudflareChallengeError(new Error("all good"))).toBe(false);
  });

  test("bounds how much of a large body it reads", async () => {
    const big = new Response("Just a moment", {
      headers: { "content-length": String(CLOUDFLARE_CHALLENGE_BODY_READ_LIMIT + 1) },
    });
    expect(await readCloudflareChallengeBody(big)).toBeUndefined();

    const small = new Response("Just a moment");
    expect(await readCloudflareChallengeBody(small)).toContain("Just a moment");
  });
});

describe("native passthrough fails closed on challenges", () => {
  function modelsRequest(): Request {
    return new Request("http://127.0.0.1:17841/v1/models", {
      headers: { authorization: "Bearer local-runtime-key" },
    });
  }

  test("never forwards challenge HTML and returns a terminal cloudflare_challenge error", async () => {
    const upstream = new Response(
      "<html><title>Just a moment...</title><body>Enable JavaScript and cookies to continue</body></html>",
      { status: 403, headers: { "content-type": "text/html" } },
    );
    const response = await forwardNativeCodexRequest(modelsRequest(), "models", async () => upstream);
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toContain("application/json");
    const payload = await response.json() as { error: { code: string; message: string } };
    expect(payload.error.code).toBe(CLOUDFLARE_CHALLENGE_CODE);
    // The raw interstitial markup must never leak downstream; only the harness's
    // own actionable message (which may name the detected signal) is returned.
    expect(payload.error.message).not.toContain("<html>");
    expect(payload.error.message).not.toContain("<title>");
  });

  test("honors the cf-mitigated header even with a JSON content type", async () => {
    const upstream = new Response("{}", {
      status: 403,
      headers: { "content-type": "application/json", "cf-mitigated": "challenge" },
    });
    const response = await forwardNativeCodexRequest(modelsRequest(), "models", async () => upstream);
    expect(response.status).toBe(403);
    expect((await response.json() as { error: { code: string } }).error.code).toBe(CLOUDFLARE_CHALLENGE_CODE);
  });

  test("passes a healthy upstream response through unchanged", async () => {
    const upstream = new Response(JSON.stringify({ data: [{ id: "gpt-5" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const response = await forwardNativeCodexRequest(modelsRequest(), "models", async () => upstream);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [{ id: "gpt-5" }] });
  });

  test("does not buffer a streaming body looking for a challenge", async () => {
    let inspected = false;
    const upstream = new Response("data: {}\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    Object.defineProperty(upstream, "clone", { value: () => { inspected = true; return upstream; } });
    const response = await forwardNativeCodexRequest(modelsRequest(), "responses", async () => upstream);
    expect(response.status).toBe(200);
    expect(inspected).toBe(false);
  });

  test("requires the incoming bearer authorization", async () => {
    const anonymous = new Request("http://127.0.0.1:17841/v1/models");
    await expect(forwardNativeCodexRequest(anonymous, "models", async () => new Response("{}")))
      .rejects.toThrow(/Bearer/);
  });
});

describe("cloudflare challenge error classification", () => {
  test("keeps the explicit cloudflare_challenge code", () => {
    const classified = classifyError(403, "permission_error", "ChatGPT's edge returned a Cloudflare challenge (cloudflare_challenge)");
    expect(classified.code).toBe(CLOUDFLARE_CHALLENGE_CODE);
  });

  test("maps challenge text to a non-retryable permission status", () => {
    expect(inferHttpStatusFromAdapterMessage("Just a moment... cloudflare_challenge")).toBe(403);
    expect(httpStatusFromTerminalError({ type: "invalid_request_error", code: CLOUDFLARE_CHALLENGE_CODE })).toBe(403);
  });
});
