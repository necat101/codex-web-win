import { describe, expect, test } from "bun:test";
import { emitDeepSeekToolRequests } from "../src/adapters/deepseek-web";
import { bridgeToResponsesSSE } from "../src/bridge";
import { AsyncEventQueue } from "../src/event-queue";
import type { AdapterEvent } from "../src/types";

interface SseFrame {
  event: string;
  data: Record<string, unknown>;
}

function parseSseFrames(body: string): SseFrame[] {
  return body.split("\n\n").flatMap(block => {
    const event = block.match(/^event: (.+)$/m)?.[1];
    const data = block.match(/^data: (.+)$/m)?.[1];
    if (!event || !data || data === "[DONE]") return [];
    return [{ event, data: JSON.parse(data) as Record<string, unknown> }];
  });
}

async function bridgeEvents(
  events: AdapterEvent[],
  options: {
    toolNsMap?: Map<string, { namespace: string; name: string }>;
    freeformToolNames?: Set<string>;
  } = {},
): Promise<SseFrame[]> {
  const queue = new AsyncEventQueue<AdapterEvent>();
  for (const event of events) queue.push(event);
  queue.close();
  const body = await new Response(bridgeToResponsesSSE(
    queue,
    "deepseek-web/expert",
    options.toolNsMap,
    options.freeformToolNames,
  )).text();
  return parseSseFrames(body);
}

describe("DeepSeek adapter to Responses SSE bridge", () => {
  test("emits a complete native function-call lifecycle with a non-terminal turn", async () => {
    const events: AdapterEvent[] = [];
    emitDeepSeekToolRequests(
      [{ name: "exec_command", arguments: { cmd: "rg --files" } }],
      "trace123",
      { inputTokens: 10, outputTokens: 4, totalTokens: 14, estimated: true },
      event => events.push(event),
    );

    const frames = await bridgeEvents(events);
    expect(frames.map(frame => frame.event)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
    ]);

    const added = frames[1]!.data.item as Record<string, unknown>;
    expect(added).toMatchObject({
      type: "function_call",
      call_id: "deepseek_trace123_0",
      name: "exec_command",
      arguments: "",
      status: "in_progress",
    });
    expect(added.id).toMatch(/^fc_/);

    expect(frames[2]!.data).toMatchObject({
      item_id: added.id,
      output_index: 0,
      delta: '{"cmd":"rg --files"}',
    });
    expect(frames[3]!.data).toMatchObject({
      item_id: added.id,
      output_index: 0,
      arguments: '{"cmd":"rg --files"}',
    });

    const done = frames[4]!.data.item as Record<string, unknown>;
    expect(done).toEqual({
      ...added,
      arguments: '{"cmd":"rg --files"}',
      status: "completed",
    });

    const response = frames[5]!.data.response as Record<string, unknown>;
    expect(response).toMatchObject({
      status: "completed",
      model: "deepseek-web/expert",
      end_turn: false,
      output: [done],
    });
  });

  test("preserves the custom/freeform input lifecycle for the namespaced exec tool", async () => {
    const input = 'const result = await tools.exec_command({cmd: "pwd"});\ntext(result.output);';
    const events: AdapterEvent[] = [];
    emitDeepSeekToolRequests(
      [{ name: "functions__exec", arguments: { input } }],
      "trace456",
      { inputTokens: 12, outputTokens: 6, totalTokens: 18, estimated: true },
      event => events.push(event),
    );

    const frames = await bridgeEvents(events, {
      toolNsMap: new Map([
        ["functions__exec", { namespace: "functions", name: "exec" }],
      ]),
      freeformToolNames: new Set(["exec"]),
    });
    expect(frames.map(frame => frame.event)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.custom_tool_call_input.delta",
      "response.custom_tool_call_input.done",
      "response.output_item.done",
      "response.completed",
    ]);

    const added = frames[1]!.data.item as Record<string, unknown>;
    expect(added).toMatchObject({
      type: "custom_tool_call",
      call_id: "deepseek_trace456_0",
      name: "exec",
      input: "",
      status: "in_progress",
    });
    expect(added.id).toMatch(/^ctc_/);
    expect(frames[2]!.data).toMatchObject({ item_id: added.id, delta: input });
    expect(frames[3]!.data).toMatchObject({ item_id: added.id, input });

    const done = frames[4]!.data.item as Record<string, unknown>;
    expect(done).toEqual({ ...added, input, status: "completed" });
    const response = frames[5]!.data.response as Record<string, unknown>;
    expect(response).toMatchObject({
      status: "completed",
      end_turn: false,
      output: [done],
    });
  });
});
