import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { isWindowsNamedPipePath, resolveBrokerSocketPath } from "../../config";
import type { CodexTool } from "../../types";
import type { ChatGptTurnEnvironment } from "./environment";

export interface BrokerToolRequest {
  callId: string;
  wireName: string;
  freeform: boolean;
  arguments?: Record<string, unknown>;
  input?: string;
}

export interface BrokerToolResult {
  content: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: unknown;
}

interface PendingInvocation {
  request: BrokerToolRequest;
  resolve: (result: BrokerToolResult) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface ToolWaiter {
  resolve: (requests: BrokerToolRequest[]) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface PendingCountWaiter {
  previousCount: number;
  resolve: (count: number) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface TurnChannel {
  traceId: string;
  environment: ChatGptTurnEnvironment;
  bindingId?: string;
  queuedCallIds: string[];
  invocations: Map<string, PendingInvocation>;
  waiters: Set<ToolWaiter>;
  pendingCountWaiters: Set<PendingCountWaiter>;
  batchTimer?: ReturnType<typeof setTimeout>;
}

interface BrokerRequest {
  id: string;
  method: "claim" | "resolve" | "release" | "invoke";
  token?: string;
  bindingId?: string;
  wireName?: string;
  freeform?: boolean;
  arguments?: Record<string, unknown>;
  input?: string;
}

interface BrokerResponse {
  id: string;
  result?: unknown;
  error?: string;
}

const brokers = new Map<string, TurnBroker>();
const MAX_BROKER_LINE_CHARS = 67_108_864;

function opaqueId(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function environmentIdentity(environment: ChatGptTurnEnvironment): string {
  const pathKey = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  return JSON.stringify({
    cwd: pathKey(environment.cwd),
    roots: environment.roots.map(pathKey),
    writableRoots: environment.writableRoots.map(pathKey),
    sandboxPolicy: environment.sandboxPolicy.type === "workspaceWrite"
      ? { ...environment.sandboxPolicy, writableRoots: environment.sandboxPolicy.writableRoots.map(pathKey) }
      : environment.sandboxPolicy,
  });
}

function toolIdentity(tool: Pick<CodexTool, "name" | "namespace">): string {
  return `${tool.namespace ?? ""}\u0000${tool.name}`;
}

function isStableTurnExecutionTool(tool: CodexTool): boolean {
  if (tool.namespace && tool.namespace !== "functions") return false;
  if (tool.name === "exec") return tool.freeform === true;
  return tool.freeform !== true
    && (tool.name === "exec_command"
      || tool.name === "shell_command"
      || tool.name === "write_stdin"
      || tool.name === "wait");
}

/**
 * A claimed turn binding is the capability grant for that native Codex turn.
 * Continuation requests sometimes arrive with a transiently incomplete tool
 * registry (notably while the Windows exec gateway/plugin registry is being
 * refreshed). Treating that sample as authoritative used to make a working
 * exec_command/apply_patch capability disappear immediately before a later
 * build step.
 *
 * Keep only the native command path already advertised for the lifetime of the
 * binding. A later continuation may refresh those definitions or add/remove
 * unrelated tools normally, but a transient registry sample cannot strand an
 * in-flight command or its resumable session. Filesystem and sandbox authority
 * are still checked separately by environmentIdentity().
 */
export function mergeStableTurnTools(previous: readonly CodexTool[], refreshed: readonly CodexTool[]): CodexTool[] {
  const remaining = new Map(refreshed.map(tool => [toolIdentity(tool), tool]));
  const merged: CodexTool[] = [];
  for (const prior of previous) {
    const identity = toolIdentity(prior);
    const current = remaining.get(identity);
    if (current) {
      merged.push(current);
      remaining.delete(identity);
    } else if (isStableTurnExecutionTool(prior)) {
      merged.push(prior);
    }
  }
  merged.push(...remaining.values());
  return merged;
}

export class TurnBroker {
  static forSocket(path: string): TurnBroker {
    const endpoint = resolveBrokerSocketPath(path);
    let broker = brokers.get(endpoint);
    if (!broker) {
      broker = new TurnBroker(endpoint);
      brokers.set(endpoint, broker);
    }
    return broker;
  }

  private readonly channels = new Map<string, TurnChannel>();
  private readonly pending = new Map<string, TurnChannel>();
  private readonly bindings = new Map<string, { token: string; channel: TurnChannel }>();
  private server?: Server;
  private startPromise?: Promise<void>;

  private constructor(readonly socketPath: string) {}

  async register(environment: ChatGptTurnEnvironment, traceId = "unknown"): Promise<string> {
    await this.start();
    const token = opaqueId("turn");
    const channel: TurnChannel = {
      traceId,
      environment: { ...environment },
      queuedCallIds: [],
      invocations: new Map(),
      waiters: new Set(),
      pendingCountWaiters: new Set(),
    };
    this.channels.set(token, channel);
    this.pending.set(token, channel);
    return token;
  }

  updateEnvironment(token: string, environment: ChatGptTurnEnvironment): ChatGptTurnEnvironment {
    const channel = this.channels.get(token);
    if (!channel) throw new Error("turn token is invalid or revoked");
    if (environmentIdentity(channel.environment) !== environmentIdentity(environment)) {
      throw new Error("Codex turn environment changed during an active ChatGPT tool loop");
    }
    channel.environment = {
      ...environment,
      tools: mergeStableTurnTools(channel.environment.tools, environment.tools),
    };
    return channel.environment;
  }

  pendingToolCount(token: string): number {
    const channel = this.channels.get(token);
    if (!channel) return 0;
    return channel.invocations.size;
  }

  async waitForPendingToolCountChange(
    token: string,
    previousCount: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<number> {
    const channel = this.channels.get(token);
    if (!channel) throw new Error("turn token is invalid or revoked");
    const current = channel.invocations.size;
    if (current !== previousCount || timeoutMs <= 0) return current;
    if (signal?.aborted) throw new DOMException("pending tool count wait aborted", "AbortError");
    return new Promise<number>((resolveWait, rejectWait) => {
      const finish = (value: number, error?: Error) => {
        channel.pendingCountWaiters.delete(waiter);
        clearTimeout(waiter.timer);
        if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
        if (error) rejectWait(error);
        else resolveWait(value);
      };
      const waiter: PendingCountWaiter = {
        previousCount,
        resolve: value => finish(value),
        reject: error => finish(channel.invocations.size, error),
        timer: setTimeout(() => finish(channel.invocations.size), timeoutMs),
        ...(signal ? { signal } : {}),
      };
      if (signal) {
        waiter.onAbort = () => finish(channel.invocations.size, new DOMException("pending tool count wait aborted", "AbortError"));
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      channel.pendingCountWaiters.add(waiter);
      const afterRegistration = channel.invocations.size;
      if (afterRegistration !== previousCount) finish(afterRegistration);
    });
  }

  async nextToolBatch(token: string, signal?: AbortSignal): Promise<BrokerToolRequest[]> {
    const channel = this.channels.get(token);
    if (!channel) throw new Error("turn token is invalid or revoked");
    const ready = this.takeQueued(channel);
    if (ready.length > 0) return ready;
    if (signal?.aborted) throw new DOMException("tool wait aborted", "AbortError");
    return new Promise<BrokerToolRequest[]>((resolveWait, rejectWait) => {
      const waiter: ToolWaiter = { resolve: resolveWait, reject: rejectWait, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          channel.waiters.delete(waiter);
          rejectWait(new DOMException("tool wait aborted", "AbortError"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      channel.waiters.add(waiter);
    });
  }

  completeTool(token: string, callId: string, result: BrokerToolResult): void {
    const channel = this.channels.get(token);
    if (!channel) throw new Error("turn token is invalid or revoked");
    const invocation = channel.invocations.get(callId);
    if (!invocation) throw new Error(`tool call is not pending: ${callId}`);
    if (channel.queuedCallIds.includes(callId)) throw new Error(`tool call was completed before it was delivered: ${callId}`);
    channel.invocations.delete(callId);
    this.detachInvocationAbort(invocation);
    this.wakePendingCountWaiters(channel);
    console.info(`[chatgpt-web] broker trace=${channel.traceId} completed call=${callId.slice(0, 17)} pending=${channel.invocations.size}`);
    invocation.resolve(result);
  }

  revoke(token: string): void {
    const channel = this.channels.get(token);
    if (!channel) return;
    this.channels.delete(token);
    this.pending.delete(token);
    if (channel.bindingId) this.bindings.delete(channel.bindingId);
    this.rejectChannel(channel, new Error("Codex turn binding was revoked"));
  }

  async close(): Promise<void> {
    for (const token of [...this.channels.keys()]) this.revoke(token);
    const server = this.server;
    this.server = undefined;
    this.startPromise = undefined;
    brokers.delete(this.socketPath);
    if (server?.listening) {
      await new Promise<void>((resolveClose, rejectClose) => server.close(error => {
        if (!error || (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") resolveClose();
        else rejectClose(error);
      }));
    }
    if (!isWindowsNamedPipePath(this.socketPath)
      && existsSync(this.socketPath)
      && lstatSync(this.socketPath).isSocket()) {
      unlinkSync(this.socketPath);
    }
  }

  private start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise<void>((resolveStart, rejectStart) => {
      const namedPipe = isWindowsNamedPipePath(this.socketPath);
      const listen = () => {
        const server = createServer(socket => this.handleSocket(socket));
        this.server = server;
        server.once("error", rejectStart);
        server.listen(this.socketPath, () => {
          server.off("error", rejectStart);
          if (!namedPipe) chmodSync(this.socketPath, 0o600);
          resolveStart();
        });
      };

      if (namedPipe) {
        listen();
        return;
      }
      mkdirSync(dirname(this.socketPath), { recursive: true, mode: 0o700 });
      if (!existsSync(this.socketPath)) {
        listen();
        return;
      }
      if (!lstatSync(this.socketPath).isSocket()) {
        rejectStart(new Error(`ChatGPT web broker path exists and is not a socket: ${this.socketPath}`));
        return;
      }
      const probe = createConnection(this.socketPath);
      probe.once("connect", () => {
        probe.destroy();
        rejectStart(new Error(`ChatGPT web broker socket is already owned by another process: ${this.socketPath}`));
      });
      probe.once("error", () => {
        unlinkSync(this.socketPath);
        listen();
      });
    });
    return this.startPromise;
  }

  private handleSocket(socket: Socket): void {
    let buffered = "";
    let handled = false;
    let responseStarted = false;
    const requestAbort = new AbortController();
    const respond = (response: BrokerResponse) => {
      if (responseStarted) return;
      responseStarted = true;
      this.writeSocketResponse(socket, response);
    };
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.once("close", () => {
      if (!responseStarted) requestAbort.abort();
    });
    socket.on("data", chunk => {
      if (handled) return;
      buffered += chunk;
      if (buffered.length > MAX_BROKER_LINE_CHARS && !buffered.slice(0, MAX_BROKER_LINE_CHARS + 1).includes("\n")) {
        handled = true;
        respond({ id: "unknown", error: "turn broker request exceeds size limit" });
        return;
      }
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      const line = buffered.slice(0, newline);
      let request: BrokerRequest | undefined;
      try {
        if (line.length > MAX_BROKER_LINE_CHARS) throw new Error("turn broker request exceeds size limit");
        request = JSON.parse(line) as BrokerRequest;
        this.validateRequest(request);
      } catch (error) {
        respond({ id: request?.id ?? "unknown", error: errorOf(error).message });
        return;
      }
      void Promise.resolve().then(() => this.dispatch(request!, requestAbort.signal)).then(
        result => respond({ id: request!.id, result }),
        error => respond({ id: request!.id, error: errorOf(error).message }),
      );
    });
  }

  private writeSocketResponse(socket: Socket, response: BrokerResponse): void {
    const line = `${JSON.stringify(response)}\n`;
    if (line.length > MAX_BROKER_LINE_CHARS) {
      socket.end(`${JSON.stringify({ id: response.id, error: "turn broker response exceeds size limit" } satisfies BrokerResponse)}\n`);
      return;
    }
    socket.end(line);
  }

  private validateRequest(request: BrokerRequest): void {
    if (!request || typeof request !== "object" || typeof request.id !== "string" || request.id.length === 0 || request.id.length > 256) {
      throw new Error("turn broker request id is invalid");
    }
    if (request.method !== "claim" && request.method !== "resolve" && request.method !== "release" && request.method !== "invoke") {
      throw new Error("turn broker method is invalid");
    }
  }

  private dispatch(request: BrokerRequest, signal?: AbortSignal): unknown | Promise<unknown> {
    if (signal?.aborted) throw new DOMException("turn broker request aborted", "AbortError");
    if (request.method === "claim") {
      const token = request.token?.trim();
      if (!token) throw new Error("turn token is required");
      const channel = this.channels.get(token);
      console.error(`[chatgpt-web] broker claim received (tokenChars=${token.length}, valid=${Boolean(channel)})`);
      if (!channel) throw new Error("turn token is invalid or revoked");
      if (channel.bindingId) {
        const existing = this.bindings.get(channel.bindingId);
        if (!existing || existing.token !== token || existing.channel !== channel) {
          throw new Error("turn token binding state is inconsistent");
        }
        return { bindingId: channel.bindingId, environment: channel.environment };
      }
      this.pending.delete(token);
      const bindingId = opaqueId("binding");
      channel.bindingId = bindingId;
      this.bindings.set(bindingId, { token, channel });
      return { bindingId, environment: channel.environment };
    }

    const bindingId = request.bindingId?.trim();
    if (!bindingId) throw new Error("binding id is required");
    const binding = this.bindings.get(bindingId);
    if (!binding) throw new Error("binding id is invalid or revoked");
    if (request.method === "release") {
      this.revoke(binding.token);
      return { released: true };
    }
    if (request.method === "resolve") return { environment: binding.channel.environment };

    const wireName = request.wireName?.trim();
    if (!wireName) throw new Error("wire tool name is required");
    const callId = opaqueId("call");
    const toolRequest: BrokerToolRequest = {
      callId,
      wireName,
      freeform: request.freeform === true,
      ...(request.freeform === true ? { input: request.input ?? "" } : { arguments: request.arguments ?? {} }),
    };
    return new Promise<BrokerToolResult>((resolveInvoke, rejectInvoke) => {
      const invocation: PendingInvocation = {
        request: toolRequest,
        resolve: resolveInvoke,
        reject: rejectInvoke,
        ...(signal ? { signal } : {}),
      };
      binding.channel.invocations.set(callId, invocation);
      if (signal) {
        invocation.onAbort = () => this.cancelInvocation(
          binding.channel,
          callId,
          invocation,
          new DOMException("turn broker invocation aborted", "AbortError"),
        );
        signal.addEventListener("abort", invocation.onAbort, { once: true });
        if (signal.aborted) invocation.onAbort();
      }
      if (!binding.channel.invocations.has(callId)) return;
      binding.channel.queuedCallIds.push(callId);
      this.wakePendingCountWaiters(binding.channel);
      console.info(
        `[chatgpt-web] broker trace=${binding.channel.traceId} queued call=${callId.slice(0, 17)} tool=${wireName} waiters=${binding.channel.waiters.size}`,
      );
      this.scheduleToolWaiters(binding.channel);
    });
  }

  private takeQueued(channel: TurnChannel): BrokerToolRequest[] {
    const ids = channel.queuedCallIds.splice(0);
    return ids.map(id => channel.invocations.get(id)?.request).filter((request): request is BrokerToolRequest => Boolean(request));
  }

  private scheduleToolWaiters(channel: TurnChannel): void {
    if (channel.queuedCallIds.length === 0 || channel.waiters.size === 0) return;
    if (channel.batchTimer) return;
    channel.batchTimer = setTimeout(() => {
      channel.batchTimer = undefined;
      this.wakeToolWaiters(channel);
    }, 15);
  }

  private wakeToolWaiters(channel: TurnChannel): void {
    if (channel.queuedCallIds.length === 0 || channel.waiters.size === 0) return;
    const batch = this.takeQueued(channel);
    console.info(
      `[chatgpt-web] broker trace=${channel.traceId} delivered calls=${batch.length} tools=${batch.map(request => request.wireName).join(",")}`,
    );
    const waiters = [...channel.waiters];
    channel.waiters.clear();
    const first = waiters.shift();
    if (first) {
      if (first.signal && first.onAbort) first.signal.removeEventListener("abort", first.onAbort);
      first.resolve(batch);
    }
    for (const waiter of waiters) {
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.reject(new Error("another adapter waiter already claimed the queued tool batch"));
    }
  }

  private wakePendingCountWaiters(channel: TurnChannel): void {
    const count = channel.invocations.size;
    for (const waiter of [...channel.pendingCountWaiters]) {
      if (waiter.previousCount !== count) waiter.resolve(count);
    }
  }

  private detachInvocationAbort(invocation: PendingInvocation): void {
    if (invocation.signal && invocation.onAbort) {
      invocation.signal.removeEventListener("abort", invocation.onAbort);
    }
  }

  private cancelInvocation(
    channel: TurnChannel,
    callId: string,
    invocation: PendingInvocation,
    error: Error,
  ): void {
    if (channel.invocations.get(callId) !== invocation) return;
    channel.invocations.delete(callId);
    channel.queuedCallIds = channel.queuedCallIds.filter(id => id !== callId);
    this.detachInvocationAbort(invocation);
    this.wakePendingCountWaiters(channel);
    console.info(
      `[chatgpt-web] broker trace=${channel.traceId} cancelled call=${callId.slice(0, 17)} pending=${channel.invocations.size}`,
    );
    invocation.reject(error);
  }

  private rejectChannel(channel: TurnChannel, error: Error): void {
    if (channel.batchTimer) clearTimeout(channel.batchTimer);
    channel.batchTimer = undefined;
    for (const waiter of channel.waiters) {
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.reject(error);
    }
    channel.waiters.clear();
    for (const invocation of channel.invocations.values()) {
      this.detachInvocationAbort(invocation);
      invocation.reject(error);
    }
    channel.invocations.clear();
    for (const waiter of [...channel.pendingCountWaiters]) waiter.reject(error);
    channel.pendingCountWaiters.clear();
    channel.queuedCallIds = [];
  }

}

export async function closeTurnBrokers(): Promise<void> {
  const active = [...new Set(brokers.values())];
  await Promise.all(active.map(broker => broker.close()));
}

export async function callTurnBroker<T>(
  socketPath: string,
  request: Omit<BrokerRequest, "id">,
  timeoutMs = 5_000,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw new DOMException("ChatGPT web turn broker call aborted", "AbortError");
  const id = opaqueId("request");
  return new Promise<T>((resolveCall, rejectCall) => {
    const socket = createConnection(resolveBrokerSocketPath(socketPath));
    let buffered = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    };
    const finishError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      rejectCall(error);
    };
    const onAbort = () => finishError(new DOMException("ChatGPT web turn broker call aborted", "AbortError"));
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs > 0) {
      timer = setTimeout(() => finishError(new Error("ChatGPT web turn broker timed out")), timeoutMs);
    }
    socket.setEncoding("utf8");
    socket.once("error", error => finishError(new Error(`ChatGPT web turn broker unavailable: ${error.message}`)));
    socket.once("close", () => {
      if (!settled) finishError(new Error("ChatGPT web turn broker closed before returning a response"));
    });
    socket.once("connect", () => socket.write(`${JSON.stringify({ id, ...request })}\n`));
    socket.on("data", chunk => {
      if (settled) return;
      buffered += chunk;
      if (buffered.length > MAX_BROKER_LINE_CHARS) {
        finishError(new Error("ChatGPT web turn broker response exceeds size limit"));
        return;
      }
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      let response: BrokerResponse;
      try {
        response = JSON.parse(buffered.slice(0, newline)) as BrokerResponse;
      } catch (error) {
        finishError(new Error(`ChatGPT web turn broker returned invalid JSON: ${errorOf(error).message}`));
        return;
      }
      if (response.id !== id) {
        finishError(new Error("ChatGPT web turn broker response id mismatch"));
        return;
      }
      settled = true;
      cleanup();
      socket.end();
      if (response.error) rejectCall(new Error(response.error));
      else resolveCall(response.result as T);
    });
  });
}
