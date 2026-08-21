import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeCompactionSummary, SUMMARY_PREFIX } from "../src/responses/compaction";
import { createLocalCompactionSnapshot, readLocalCompactionSnapshot } from "../src/responses/compaction-snapshot";
import { parseRequest } from "../src/responses/parser";
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

afterEach(async () => {
  clearResponseStateForTests();
  if (originalHarnessHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
  else process.env.CODEX_CHATGPT_WEB_HOME = originalHarnessHome;
  await Promise.all(temporaryHomes.splice(0).map(home => rm(home, { recursive: true, force: true })));
});

describe("ChatGPT Web compaction continuation", () => {
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
  });

  test("stores local snapshots under the configured harness home and bounds giant scalar output", async () => {
    const harnessHome = await mkdtemp(join(tmpdir(), "codex-web-compaction-"));
    temporaryHomes.push(harnessHome);
    process.env.CODEX_CHATGPT_WEB_HOME = harnessHome;
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
    const harnessHome = await mkdtemp(join(tmpdir(), "codex-web-response-state-"));
    temporaryHomes.push(harnessHome);
    process.env.CODEX_CHATGPT_WEB_HOME = harnessHome;
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
    const harnessHome = await mkdtemp(join(tmpdir(), "codex-web-response-state-legacy-"));
    temporaryHomes.push(harnessHome);
    process.env.CODEX_CHATGPT_WEB_HOME = harnessHome;
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
