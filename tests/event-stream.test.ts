import { describe, expect, test } from "bun:test";
import { ChatGptEventDecoder, ChatGptStreamDiagnostics, type ChatGptPublicDelta } from "../src/adapters/chatgpt-web/event-stream";

function decoder() {
  const deltas: ChatGptPublicDelta[] = [];
  return { deltas, events: new ChatGptEventDecoder(delta => deltas.push(delta), new ChatGptStreamDiagnostics("fixture")) };
}

describe("ChatGPT browser SSE completion", () => {
  test("does not end a tool round just because preceding assistant text completed", () => {
    const { events } = decoder();
    events.accept({ type: "response.output_text.delta", item_id: "progress", delta: "I will inspect the workspace." });
    events.accept({ type: "response.output_item.added", item: { type: "function_call", id: "call" } });
    events.accept({ type: "response.completed", response: { status: "completed" } });
    expect(events.finalComplete).toBe(false);
  });

  test("checks terminal output for tool calls even when the added event was missed", () => {
    const { events } = decoder();
    events.accept({ type: "response.output_text.delta", item_id: "progress", delta: "Checking." });
    events.accept({ type: "response.completed", response: { output: [{ type: "custom_tool_call" }] } });
    expect(events.finalComplete).toBe(false);
  });

  test("retains chunk whitespace and exposes only public thought summaries", () => {
    const { events, deltas } = decoder();
    events.accept({ message: { id: "thought", author: { role: "assistant" }, content: {
      content_type: "thoughts", thoughts: [{ summary: "Checking paths", content: "PRIVATE" }],
    } } });
    events.accept({ message: { id: "comment", author: { role: "assistant" }, channel: "commentary",
      content: { content_type: "text", parts: ["Running"] } } });
    events.accept({ p: "/message/content/parts/0", o: "append", v: " the check." });
    expect(deltas.map(delta => delta.text)).toEqual(["Checking paths", "Running", " the check."]);
    expect(JSON.stringify(deltas)).not.toContain("PRIVATE");
    expect(events.finalComplete).toBe(false);
  });

  test("requires an actual terminal assistant message after tool results", () => {
    const { events } = decoder();
    events.accept({ message: { id: "prelude", author: { role: "assistant" }, channel: "commentary",
      status: "finished_successfully", end_turn: false, content: { content_type: "text", parts: ["Working"] } } });
    expect(events.finalComplete).toBe(false);
    events.accept({ message: { id: "tool", author: { role: "tool" }, content: { content_type: "text", parts: ["result"] } } });
    events.accept({ message: { id: "answer", author: { role: "assistant" }, channel: "final",
      status: "in_progress", end_turn: false, content: { content_type: "text", parts: ["Verified"] } } });
    expect(events.finalComplete).toBe(false);
    events.accept({ p: "/message", o: "patch", v: [
      { p: "/status", o: "replace", v: "finished_successfully" },
      { p: "/end_turn", o: "replace", v: true },
    ] });
    expect(events.finalComplete).toBe(true);
    expect(events.finalText).toBe("Verified");
  });
});
