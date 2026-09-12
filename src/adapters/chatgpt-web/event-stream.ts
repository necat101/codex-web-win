import type { CDPSession, Page } from "playwright-core";

export interface ChatGptPublicDelta {
  kind: "reasoning" | "commentary" | "final";
  text: string;
  continuation: boolean;
}

type Json = Record<string, any>;
const object = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);

/** Counts and lengths only: never persist prompts, capabilities, tool arguments, or private analysis. */
export class ChatGptStreamDiagnostics {
  readonly counts: Record<string, number> = {};
  private nextLogAt = 0;

  constructor(private readonly traceId: string) {}

  count(name: string, amount = 1): void {
    this.counts[name] = (this.counts[name] ?? 0) + amount;
  }

  report(force = false): void {
    if (!force && Date.now() < this.nextLogAt) return;
    this.nextLogAt = Date.now() + 30_000;
    console.info(`[chatgpt-web] stream trace=${this.traceId} ${JSON.stringify(this.counts)}`);
  }
}

/** Decode browser SSE and the v1 message/JSON-patch encoding. Only public channels leave this class. */
export class ChatGptEventDecoder {
  private buffer = "";
  private state: Json = {};
  private lastPath = "";
  private lastOperation = "append";
  private readonly emitted = new Map<string, string>();
  private readonly itemKinds = new Map<string, "commentary" | "final">();
  finalText = "";
  finalComplete = false;

  constructor(
    private readonly emit: (delta: ChatGptPublicDelta) => void,
    readonly diagnostics: ChatGptStreamDiagnostics,
  ) {}

  push(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const boundary = /\r?\n\r?\n/.exec(this.buffer);
      if (!boundary) break;
      const frame = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary[0].length);
      const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:"))
        .map(line => line.slice(5).replace(/^ /, "")).join("\n");
      if (!data || data === "[DONE]") continue;
      const event = /^event: ?(.+)$/m.exec(frame)?.[1]?.trim();
      try { this.accept(JSON.parse(data), event); }
      catch { this.diagnostics.count("decode_errors"); }
    }
    // An invalid/unframed response must not grow an unbounded buffer.
    if (this.buffer.length > 8 * 1024 * 1024) {
      this.buffer = "";
      this.diagnostics.count("oversized_frames");
    }
  }

  private publish(kind: ChatGptPublicDelta["kind"], key: string, text: string): void {
    const previous = this.emitted.get(key) ?? "";
    if (!text || text === previous) return;
    if (!text.startsWith(previous)) {
      this.diagnostics.count("non_append_updates");
      return;
    }
    this.emitted.set(key, text);
    const delta = text.slice(previous.length);
    this.diagnostics.count(`received_${kind}_deltas`);
    this.diagnostics.count(`received_${kind}_chars`, delta.length);
    if (kind === "final") this.finalText += delta;
    this.emit({ kind, text: delta, continuation: previous.length > 0 });
  }

  accept(value: unknown, event?: string): void {
    this.diagnostics.count("sse_events");
    if (!object(value)) return;
    const type = typeof value.type === "string" ? value.type : event;
    if (type === "response.output_item.added" && object(value.item)) {
      if (value.item.type === "message") this.itemKinds.set(value.item.id, value.item.phase === "commentary" ? "commentary" : "final");
      else if (/^(?:function_call|custom_tool_call|mcp_call)$/.test(value.item.type ?? "")) this.diagnostics.count("received_tool_events");
      return;
    }
    if (type === "response.reasoning_summary_text.delta" && typeof value.delta === "string") {
      const key = `summary:${value.item_id ?? ""}:${value.summary_index ?? 0}`;
      this.publish("reasoning", key, (this.emitted.get(key) ?? "") + value.delta);
      return;
    }
    if (type === "response.output_text.delta" && typeof value.delta === "string") {
      const key = `text:${value.item_id ?? ""}:${value.content_index ?? 0}`;
      const kind = this.itemKinds.get(value.item_id) ?? (value.phase === "commentary" ? "commentary" : "final");
      this.publish(kind, key, (this.emitted.get(key) ?? "") + value.delta);
      return;
    }
    if (type === "response.completed") {
      if (value.response?.end_turn !== false && this.finalText) this.finalComplete = true;
      return;
    }
    if (type && /(?:function_call|tool_call|mcp_call)/.test(type)) {
      this.diagnostics.count("received_tool_events");
      return;
    }
    if (object(value.message)) this.state = value;
    else if ("v" in value) this.patch(value);
    else return;
    const message = this.state.message;
    if (!object(message)) return;
    if (message.author?.role === "tool" || (message.recipient && message.recipient !== "all")) {
      this.diagnostics.count("received_tool_events");
      return;
    }
    if (message.author?.role !== "assistant") return;
    const key = typeof message.id === "string" ? message.id : "message";
    const content = message.content;
    // ChatGPT's public thought headings have a summary sibling to private content.
    // Never forward content/thinking/analysis from a thought or analysis block.
    if (content?.content_type === "thoughts" && Array.isArray(content.thoughts)) {
      content.thoughts.forEach((thought: unknown, index: number) => {
        if (object(thought) && typeof thought.summary === "string") this.publish("reasoning", `${key}:${index}`, thought.summary);
      });
      return;
    }
    const channel = message.channel ?? message.metadata?.channel;
    const complete = message.status === "finished_successfully" && message.end_turn === true;
    const kind = channel === "commentary" ? "commentary"
      : channel === "final" || (!channel && complete) ? "final" : undefined;
    if (!kind || content?.content_type !== "text" || !Array.isArray(content.parts)) return;
    const text = content.parts.filter((part: unknown) => typeof part === "string").join("");
    this.publish(kind, key, text);
    if (kind === "final" && complete && this.finalText) this.finalComplete = true;
  }

  private patch(patch: Json, prefix = ""): void {
    const path = prefix + (typeof patch.p === "string" ? patch.p : prefix ? "" : this.lastPath);
    const op = typeof patch.o === "string" ? patch.o : this.lastOperation;
    if (!prefix) { this.lastPath = path; this.lastOperation = op; }
    if (op === "patch" && Array.isArray(patch.v)) {
      for (const child of patch.v) if (object(child)) this.patch(child, path);
      return;
    }
    if (path === "") {
      if (object(patch.v)) this.state = patch.v;
      return;
    }
    const keys = path.split("/").slice(1).map(key => key.replace(/~1/g, "/").replace(/~0/g, "~"));
    if (keys.some(key => ["__proto__", "constructor", "prototype"].includes(key))) return;
    let target: Json = this.state;
    for (const key of keys.slice(0, -1)) {
      if (!object(target[key]) && !Array.isArray(target[key])) return;
      target = target[key];
    }
    const key = keys.at(-1)!;
    if (op === "append") {
      if (typeof target[key] === "string" && typeof patch.v === "string") target[key] += patch.v;
      else if (Array.isArray(target[key])) target[key].push(...(Array.isArray(patch.v) ? patch.v : [patch.v]));
    } else if (op === "add" || op === "replace") target[key] = patch.v;
    else if (op === "remove") delete target[key];
  }
}

/** Passive Chromium network observation; does not replace fetch, replay requests, or consume the page's stream. */
export class ChatGptBrowserEventStream {
  private session?: CDPSession;
  private readonly requests = new Map<string, { ready: boolean; chunks: string[]; decoder: TextDecoder; events: ChatGptEventDecoder; streaming: boolean; done: boolean }>();
  decoder: ChatGptEventDecoder;

  constructor(private readonly emit: (delta: ChatGptPublicDelta) => void, readonly diagnostics: ChatGptStreamDiagnostics) {
    this.decoder = new ChatGptEventDecoder(emit, diagnostics);
  }

  async start(page: Page): Promise<void> {
    try {
      const session = this.session = await page.context().newCDPSession(page);
      session.on("Network.responseReceived", ({ requestId, response }) => {
        if (!/text\/event-stream/i.test(response.mimeType)) return;
        this.diagnostics.count("sse_responses");
        const events = new ChatGptEventDecoder(delta => {
          this.decoder = events;
          this.emit(delta);
        }, this.diagnostics);
        const state = { ready: false, chunks: [] as string[], decoder: new TextDecoder(), events, streaming: false, done: false };
        this.requests.set(requestId, state);
        void session.send("Network.streamResourceContent", { requestId }).then(({ bufferedData }) => {
          if (this.session !== session) return;
          state.streaming = true;
          this.consume(requestId, bufferedData);
          state.ready = true;
          for (const chunk of state.chunks) this.consume(requestId, chunk);
          state.chunks = [];
          if (state.done) this.finish(requestId);
        }).catch(() => {
          this.diagnostics.count("stream_attach_errors");
          state.ready = true;
          if (state.done) void this.readCompletedBody(requestId);
        });
      });
      session.on("Network.dataReceived", ({ requestId, data }) => {
        const state = this.requests.get(requestId);
        if (!state || !data) return;
        if (!state.ready) state.chunks.push(data);
        else this.consume(requestId, data);
      });
      session.on("Network.loadingFinished", ({ requestId }) => {
        const state = this.requests.get(requestId);
        if (!state) return;
        state.done = true;
        if (!state.ready) return;
        if (state.streaming) this.finish(requestId);
        else void this.readCompletedBody(requestId);
      });
      session.on("Network.loadingFailed", ({ requestId }) => {
        if (this.requests.delete(requestId)) this.diagnostics.count("network_failures");
      });
      await session.send("Network.enable");
      this.diagnostics.count("network_observer_attached");
    } catch {
      this.diagnostics.count("network_observer_unavailable");
      await this.close();
    }
  }

  private consume(requestId: string, base64: string): void {
    const state = this.requests.get(requestId);
    if (!state || !base64) return;
    const bytes = Buffer.from(base64, "base64");
    this.diagnostics.count("sse_bytes", bytes.length);
    state.events.push(state.decoder.decode(bytes, { stream: true }));
  }

  private finish(requestId: string): void {
    const state = this.requests.get(requestId);
    if (state) state.events.push(state.decoder.decode());
    this.requests.delete(requestId);
  }

  private async readCompletedBody(requestId: string): Promise<void> {
    try {
      const response = await this.session?.send("Network.getResponseBody", { requestId });
      const state = this.requests.get(requestId);
      if (response && state) state.events.push(response.base64Encoded ? Buffer.from(response.body, "base64").toString("utf8") : response.body);
    } catch { this.diagnostics.count("completed_body_unavailable"); }
    finally { this.requests.delete(requestId); }
  }

  async close(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    if (session) await session.detach().catch(() => {});
    this.requests.clear();
  }
}
