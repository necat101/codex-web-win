import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import {
  ChatGptHeartbeatFeed,
  ChatGptTextFeed,
  ChatGptTraceFeed,
  ChatGptTurnSessions,
  chatGptTurnExecutionFamilyKey,
  chatGptTurnExecutionKey,
  type ChatGptTurnRuntime,
} from "../src/adapters/chatgpt-web/turn-execution";
import type { AppConfig } from "../src/config";
import { COMPACT_PROMPT, encodeCompactionSummary, SUMMARY_PREFIX } from "../src/responses/compaction";
import { createLocalCompactionSnapshot, readLocalCompactionSnapshot } from "../src/responses/compaction-snapshot";
import { parseRequest } from "../src/responses/parser";
import { compactRequest, responseRequest } from "../src/server";
import {
  clearResponseStateForTests,
  clearResponseStateMemoryForTests,
  expandPreviousResponseInput,
  flushResponseState,
  RESPONSE_STATE_SNAPSHOT_MAX_BYTES,
  rememberResponseState,
} from "../src/responses/state";

const originalHarnessHome = process.env.CODEX_CHATGPT_WEB_HOME;
const temporaryHomes: string[] = [];

beforeEach(async () => {
  const harnessHome = await mkdtemp(join(tmpdir(), "codex-web-compaction-test-"));
  temporaryHomes.push(harnessHome);
  process.env.CODEX_CHATGPT_WEB_HOME = harnessHome;
  // Response state is process-global. Reset it only after redirecting the
  // configured home so a test can never delete the user's live continuation
  // cache under ~/.codex-chatgpt-web.
  clearResponseStateForTests();
});

afterEach(async () => {
  try {
    clearResponseStateForTests();
  } finally {
    if (originalHarnessHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
    else process.env.CODEX_CHATGPT_WEB_HOME = originalHarnessHome;
    await Promise.all(temporaryHomes.splice(0).map(home => rm(home, { recursive: true, force: true })));
  }
});

function activeHarnessHome(): string {
  const harnessHome = process.env.CODEX_CHATGPT_WEB_HOME;
  if (!harnessHome) throw new Error("compaction test home was not initialized");
  return harnessHome;
}

function turnMetadata() {
  return {
    "x-codex-turn-metadata": JSON.stringify({
      thread_id: "thread_compaction_regression",
      turn_id: "turn_compaction_regression",
      sandbox_mode: "danger-full-access",
    }),
  };
}

function browserOnlyConfig(deepSeekEnabled = false): AppConfig {
  return {
    mode: "browser-only",
    proAvailable: false,
    ...(deepSeekEnabled ? {
      deepSeekWeb: {
        enabled: true,
        storageStatePath: join(activeHarnessHome(), "browser", "deepseek-storage-state.json"),
        acknowledgedAt: "2026-08-23T00:00:00.000Z",
      },
    } : {}),
  } as AppConfig;
}

function pendingReadOnlyRuntime(onCancel: () => void): ChatGptTurnRuntime {
  return {
    mode: "read-only",
    browser: new Promise<string>(() => {}),
    heartbeat: new ChatGptHeartbeatFeed(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: onCancel,
  };
}

describe("ChatGPT Web compaction continuation", () => {
  test("routes enabled DeepSeek compact requests through the local provider-aware snapshot path", async () => {
    const response = await compactRequest(new Request("http://127.0.0.1/v1/responses/compact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-web/expert",
        input: [{
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "retain this DeepSeek compaction detail" }],
        }],
      }),
    }), browserOnlyConfig(true));

    expect(response.status).toBe(200);
    const body = await response.json() as { output?: Array<Record<string, unknown>> };
    const serialized = JSON.stringify(body.output);
    expect(serialized).toContain("retain this DeepSeek compaction detail");
    const snapshotId = serialized.match(/snapshot_id=([0-9a-f]{32})/)?.[1];
    expect(snapshotId).toBeDefined();
    const snapshot = await readLocalCompactionSnapshot({ snapshotId: snapshotId!, maxChars: 40_000 });
    expect(snapshot.text).toContain("kind: responses-compact-v1");
    expect(snapshot.text).toContain("model: deepseek-web/expert");
  });

  test("stores compaction as a replacement replay epoch", () => {
    const oldInput = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "very old context" }] },
      { type: "compaction_trigger" },
    ];
    rememberResponseState(
      { model: "chatgpt-web/high", store: false, input: oldInput },
      {
        id: "resp_compacted",
        status: "completed",
        output: [{ type: "compaction", encrypted_content: encodeCompactionSummary("checkpoint summary") }],
      },
      { force: true },
    );

    const expanded = expandPreviousResponseInput({
      model: "chatgpt-web/high",
      previous_response_id: "resp_compacted",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "new work" }] }],
    }) as { input: unknown[] };

    expect(expanded.input).toHaveLength(2);
    expect(expanded.input[0]).toMatchObject({ type: "compaction" });
    expect(JSON.stringify(expanded.input)).not.toContain("very old context");
    expect(JSON.stringify(expanded.input)).not.toContain("compaction_trigger");

    const parsed = parseRequest(expanded);
    expect(parsed._compactionRequest).toBeUndefined();
    expect(parsed.context.messages).toHaveLength(2);
    expect(parsed.context.messages[0]).toMatchObject({
      role: "user",
      content: `${SUMMARY_PREFIX}\n\ncheckpoint summary`,
    });
    expect(parsed.context.messages[1]).toMatchObject({ role: "user", content: "new work" });
  });

  test("only a newly appended compaction trigger requests compaction", () => {
    const parsed = parseRequest({
      model: "chatgpt-web/high",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "context" }] },
        { type: "compaction_trigger" },
      ],
    });
    expect(parsed._compactionRequest).toBe(true);
    expect(parsed._localCompactionRequest).toBeUndefined();
  });

  test("recognizes the native no-id checkpoint prompt without conflating remote v2 compaction", () => {
    const parsed = parseRequest({
      model: "chatgpt-web/high",
      reasoning: { effort: "high" },
      client_metadata: turnMetadata(),
      input: [
        { type: "additional_tools", role: "developer", tools: [] },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: `${COMPACT_PROMPT.replaceAll("\n", "\r\n")}\r\n` }],
        },
      ],
    });

    expect(parsed._localCompactionRequest).toBe(true);
    expect(parsed._compactionRequest).toBeUndefined();
  });

  test("answers the native checkpoint prompt locally with a normal assistant message", async () => {
    const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "chatgpt-web/high",
        stream: false,
        input: [{
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: COMPACT_PROMPT }],
        }],
        tools: [],
      }),
    }), browserOnlyConfig());

    expect(response.status).toBe(200);
    const body = await response.json() as { output?: Array<Record<string, unknown>> };
    expect(body.output?.some(item => item.type === "message")).toBe(true);
    expect(body.output?.some(item => item.type === "compaction")).toBe(false);
    expect(JSON.stringify(body.output)).toContain("CODEX_BRIDGE_LOCAL_COMPACTION");
  });

  test("keeps the streamed native checkpoint response on ordinary message events", async () => {
    const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "chatgpt-web/high",
        stream: true,
        input: [{
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: COMPACT_PROMPT }],
        }],
        tools: [],
      }),
    }), browserOnlyConfig());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const frames = (await response.text())
      .split(/\r?\n/)
      .filter(line => line.startsWith("data:"))
      .map(line => line.slice("data:".length).trim())
      .filter(data => data.length > 0 && data !== "[DONE]")
      .map(data => JSON.parse(data) as {
        type?: string;
        item?: { type?: string };
        delta?: string;
      });
    const addedItems = frames
      .filter(frame => frame.type === "response.output_item.added")
      .map(frame => frame.item?.type);
    expect(addedItems).toContain("message");
    expect(addedItems).not.toContain("compaction");
    expect(frames.filter(frame => frame.type === "response.output_text.delta").map(frame => frame.delta).join(""))
      .toContain("CODEX_BRIDGE_LOCAL_COMPACTION");
  });

  test("keeps remote-v2 compaction_trigger on the synthetic compaction-item contract", async () => {
    const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "chatgpt-web/high",
        stream: false,
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "context" }] },
          { type: "compaction_trigger" },
        ],
      }),
    }), browserOnlyConfig());

    expect(response.status).toBe(200);
    const body = await response.json() as { output?: Array<Record<string, unknown>> };
    expect(body.output).toHaveLength(1);
    expect(body.output?.[0]?.type).toBe("compaction");
  });

  test("does not treat an id-bearing user message as a native checkpoint request", () => {
    const parsed = parseRequest({
      model: "chatgpt-web/high",
      input: [{
        type: "message",
        id: "msg_real_user",
        role: "user",
        content: [{ type: "input_text", text: COMPACT_PROMPT }],
      }],
    });

    expect(parsed._localCompactionRequest).toBeUndefined();
    expect(parsed._compactionRequest).toBeUndefined();
  });

  test("keeps a stable local-compaction epoch across single-newline summary continuation rounds", () => {
    const compactedSummary = `${SUMMARY_PREFIX}\nmanager-context checkpoint`;
    const first = parseRequest({
      model: "chatgpt-web/high",
      reasoning: { effort: "high" },
      client_metadata: turnMetadata(),
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: compactedSummary }] },
        { type: "message", id: "msg_continue_a", role: "user", content: [{ type: "input_text", text: "continue A" }] },
      ],
    });
    const later = parseRequest({
      model: "chatgpt-web/high",
      reasoning: { effort: "high" },
      client_metadata: turnMetadata(),
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: compactedSummary }] },
        { type: "message", id: "msg_continue_b", role: "user", content: [{ type: "input_text", text: "continue B" }] },
      ],
    });
    const preCompaction = parseRequest({
      model: "chatgpt-web/high",
      reasoning: { effort: "high" },
      client_metadata: turnMetadata(),
      input: [{ type: "message", id: "msg_before", role: "user", content: [{ type: "input_text", text: "before" }] }],
    });

    expect(first._contextCompactionEpoch).toBeDefined();
    expect(later._contextCompactionEpoch).toBe(first._contextCompactionEpoch);
    expect(preCompaction._contextCompactionEpoch).toBeUndefined();
    expect(chatGptTurnExecutionKey(first)).toBe(chatGptTurnExecutionKey(later));
    expect(chatGptTurnExecutionKey(first)).not.toBe(chatGptTurnExecutionKey(preCompaction));
    expect(chatGptTurnExecutionFamilyKey(first)).toBe(chatGptTurnExecutionFamilyKey(later));
    expect(chatGptTurnExecutionFamilyKey(first)).toBe(chatGptTurnExecutionFamilyKey(preCompaction));
  });

  test("cancels the prior browser epoch before starting its compacted replacement", () => {
    const sessions = new ChatGptTurnSessions();
    const cancelled: string[] = [];
    const lifecycle: string[] = [];
    let starts = 0;
    const start = (name: string) => {
      starts++;
      lifecycle.push(`start:${name}`);
      return pendingReadOnlyRuntime(() => {
        cancelled.push(name);
        lifecycle.push(`cancel:${name}`);
      });
    };

    const before = sessions.getOrCreate("before-compaction", () => start("before"), "turn-family");
    const after = sessions.getOrCreate("after-compaction", () => start("after"), "turn-family");
    const replay = sessions.getOrCreate("after-compaction", () => start("unexpected-replay"), "turn-family");

    expect(after).not.toBe(before);
    expect(replay).toBe(after);
    expect(starts).toBe(2);
    expect(cancelled).toEqual(["before"]);
    expect(lifecycle).toEqual(["start:before", "cancel:before", "start:after"]);
    expect(() => sessions.getOrCreate(
      "before-compaction",
      () => start("stale-before"),
      "turn-family",
    )).toThrow("retired pre-compaction browser epoch");
    expect(starts).toBe(2);
    expect(sessions.getOrCreate("after-compaction", () => start("unexpected"), "turn-family")).toBe(after);
    sessions.clear();
  });

  test("supersedes every older epoch without cancelling an unrelated turn family", () => {
    const sessions = new ChatGptTurnSessions();
    const cancelled: string[] = [];
    const start = (name: string) => pendingReadOnlyRuntime(() => cancelled.push(name));

    sessions.getOrCreate("family-a-epoch-0", () => start("a0"), "family-a");
    sessions.getOrCreate("family-b-epoch-0", () => start("b0"), "family-b");
    sessions.getOrCreate("family-a-epoch-1", () => start("a1"), "family-a");
    sessions.getOrCreate("family-a-epoch-2", () => start("a2"), "family-a");

    expect(cancelled).toEqual(["a0", "a1"]);
    expect(sessions.activeCount()).toBe(2);
    sessions.clear();
    expect(cancelled).toEqual(["a0", "a1", "b0", "a2"]);
  });

  test("keeps an active browser session alive across arbitrary time beyond settled-cache retention", () => {
    let now = 1_000;
    let starts = 0;
    const cancelled: string[] = [];
    const sessions = new ChatGptTurnSessions(5 * 60_000, 256, () => now);
    const start = () => {
      starts += 1;
      return pendingReadOnlyRuntime(() => cancelled.push("active"));
    };

    const initial = sessions.getOrCreate("long-running", start, "long-running-family");
    now += 31 * 60_000;
    const thirtyMinuteReplay = sessions.getOrCreate("long-running", start, "long-running-family");
    now += 1_000 * 365 * 24 * 60 * 60_000;
    const thousandYearReplay = sessions.getOrCreate("long-running", start, "long-running-family");

    expect(thirtyMinuteReplay).toBe(initial);
    expect(thousandYearReplay).toBe(initial);
    expect(sessions.activeCount()).toBe(1);
    expect(starts).toBe(1);
    expect(cancelled).toEqual([]);
    sessions.clear();
  });

  test("cancelling a superseded turn releases the serialized BrowserWorker tail", async () => {
    const worker = Object.create(ChatGptBrowserWorker.prototype) as ChatGptBrowserWorker & Record<string, unknown>;
    (worker as any).tail = Promise.resolve();
    (worker as any).runExclusive = async (turn: {
      traceId: string;
      abortSignal: AbortSignal;
      prepare: () => Promise<unknown>;
    }) => {
      await turn.prepare();
      if (turn.traceId === "before") {
        await new Promise<void>((_resolve, reject) => {
          if (turn.abortSignal.aborted) {
            reject(new DOMException("ChatGPT web turn aborted", "AbortError"));
            return;
          }
          turn.abortSignal.addEventListener(
            "abort",
            () => reject(new DOMException("ChatGPT web turn aborted", "AbortError")),
            { once: true },
          );
        });
      }
      return turn.traceId;
    };

    let beforePrepared!: () => void;
    const beforeReady = new Promise<void>(resolve => { beforePrepared = resolve; });
    let afterPrepared = false;
    const beforeAbort = new AbortController();
    const afterAbort = new AbortController();
    const browserTurn = (traceId: string, abort: AbortController, prepare: () => void) => ({
      traceId,
      modelId: "chatgpt-web/high",
      capabilities: { localToolsEnabled: true, proAvailable: false },
      abortSignal: abort.signal,
      prepare: async () => {
        prepare();
        return { text: "", images: [], release: () => {} };
      },
      onTextDelta: () => {},
    });

    const beforeRun = worker.run(browserTurn("before", beforeAbort, beforePrepared));
    await beforeReady;
    const afterRun = worker.run(browserTurn("after", afterAbort, () => { afterPrepared = true; }));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(afterPrepared).toBe(false);

    beforeAbort.abort();
    await beforeRun.catch(() => {});
    expect(await afterRun).toBe("after");
    expect(afterPrepared).toBe(true);
  });

  test("stores local snapshots under the configured harness home and bounds giant scalar output", async () => {
    const harnessHome = activeHarnessHome();
    const giant = `begin-${"x".repeat(600_000)}-end`;

    const snapshot = await createLocalCompactionSnapshot({
      model: "chatgpt-web/high",
      input: [{
        type: "function_call_output",
        call_id: "call_big",
        output: giant,
      }],
      tools: [{ name: "must-not-be-archived" }],
    }, { kind: "responses-v2", model: "chatgpt-web/high" });

    const page = await readLocalCompactionSnapshot({
      snapshotId: snapshot.snapshotId,
      query: "oversized text payload compacted locally",
      maxChars: 20_000,
    });
    expect(page.matched).toBe(true);
    expect(page.text).toContain("original_chars=600010");
    expect(page.text).not.toContain("must-not-be-archived");
    expect(snapshot.archivedChars).toBeLessThan(400_000);

    const head = await readLocalCompactionSnapshot({ snapshotId: snapshot.snapshotId, query: "begin-", maxChars: 2_000 });
    const tail = await readLocalCompactionSnapshot({ snapshotId: snapshot.snapshotId, query: "-end", maxChars: 2_000 });
    expect(head.matched).toBe(true);
    expect(head.text).toContain("begin-");
    expect(tail.matched).toBe(true);
    expect(tail.text).toContain("-end");
  });

  test("bounds the restart continuation cache while preserving the newest response", async () => {
    const harnessHome = activeHarnessHome();
    const payload = "x".repeat(450_000);

    for (let index = 0; index < 24; index++) {
      rememberResponseState(
        {
          model: "chatgpt-web/high",
          store: false,
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: `turn-${index}` }] }],
        },
        {
          id: `resp_cache_${index}`,
          status: "completed",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: payload }] }],
        },
        { force: true },
      );
    }
    flushResponseState();

    const snapshot = await readFile(join(harnessHome, "responses-state.json"), "utf8");
    expect(Buffer.byteLength(snapshot)).toBeLessThanOrEqual(RESPONSE_STATE_SNAPSHOT_MAX_BYTES + 1_024);
    const parsed = JSON.parse(snapshot) as { states: unknown[] };
    expect(parsed.states.length).toBeLessThan(24);

    clearResponseStateMemoryForTests();
    const expanded = expandPreviousResponseInput({
      model: "chatgpt-web/high",
      previous_response_id: "resp_cache_23",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "after restart" }] }],
    }) as { input: unknown[] };
    expect(JSON.stringify(expanded.input)).toContain("after restart");
    expect(JSON.stringify(expanded.input)).toContain(payload.slice(0, 1_000));
  });

  test("migrates an oversized legacy restart cache after its first reload", async () => {
    const harnessHome = activeHarnessHome();
    const payload = "y".repeat(450_000);
    const states = Array.from({ length: 22 }, (_, index) => [
      `resp_legacy_${index}`,
      {
        createdAt: Date.now(),
        items: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: payload }] }],
      },
    ]);
    await mkdir(harnessHome, { recursive: true });
    await writeFile(join(harnessHome, "responses-state.json"), JSON.stringify({ version: 1, states }), "utf8");

    const expanded = expandPreviousResponseInput({
      model: "chatgpt-web/high",
      previous_response_id: "resp_legacy_21",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "new turn" }] }],
    }) as { input: unknown[] };
    expect(JSON.stringify(expanded.input)).toContain("new turn");
    flushResponseState();

    const migrated = await readFile(join(harnessHome, "responses-state.json"), "utf8");
    expect(Buffer.byteLength(migrated)).toBeLessThanOrEqual(RESPONSE_STATE_SNAPSHOT_MAX_BYTES + 1_024);
    expect((JSON.parse(migrated) as { states: unknown[] }).states.length).toBeLessThan(states.length);
  });
});
