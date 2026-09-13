import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createChatGptMcpServer } from "./mcp-server";

export const LEGACY_CODEX_MCP_HOST = "127.0.0.1" as const;
export const LEGACY_CODEX_MCP_PORT = 17847;
export const LEGACY_CODEX_MCP_PATH = "/v1" as const;

export function legacyCodexMcpPort(environment: NodeJS.ProcessEnv = process.env): number {
  const configured = environment.CODEX_CHATGPT_WEB_LEGACY_MCP_PORT?.trim();
  if (!configured) return LEGACY_CODEX_MCP_PORT;
  if (!/^\d+$/.test(configured)) {
    throw new Error("CODEX_CHATGPT_WEB_LEGACY_MCP_PORT must be an integer between 0 and 65535");
  }
  const port = Number(configured);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("CODEX_CHATGPT_WEB_LEGACY_MCP_PORT must be an integer between 0 and 65535");
  }
  return port;
}

interface HttpMcpSession {
  transport: StreamableHTTPServerTransport;
  server: ReturnType<typeof createChatGptMcpServer>;
}

export interface LegacyCodexMcpHttpServer {
  host: typeof LEGACY_CODEX_MCP_HOST;
  port: number;
  path: typeof LEGACY_CODEX_MCP_PATH;
  stop(): Promise<void>;
}

function requestPath(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? "/", `http://${LEGACY_CODEX_MCP_HOST}`).pathname;
  } catch {
    return "/";
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

async function readJsonBody(req: IncomingMessage, maxBytes = 2 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error("Legacy Codex MCP request body is too large");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return undefined;
  return JSON.parse(text) as unknown;
}

function jsonRpcError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({
    jsonrpc: "2.0",
    error: { code: -32000, message },
    id: null,
  }));
}

export async function startLegacyCodexMcpHttpServer(options: {
  brokerSocketPath: string;
  port?: number;
}): Promise<LegacyCodexMcpHttpServer> {
  const sessions = new Map<string, HttpMcpSession>();
  const port = options.port ?? legacyCodexMcpPort();

  const http = createServer(async (req, res) => {
    if (requestPath(req) !== LEGACY_CODEX_MCP_PATH) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    try {
      const sessionId = header(req, "mcp-session-id");

      if (req.method === "POST") {
        const body = await readJsonBody(req);
        let session = sessionId ? sessions.get(sessionId) : undefined;

        if (!session && !sessionId && isInitializeRequest(body)) {
          const mcp = createChatGptMcpServer({ brokerSocketPath: options.brokerSocketPath });
          let transport!: StreamableHTTPServerTransport;
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: initializedSessionId => {
              sessions.set(initializedSessionId, { transport, server: mcp });
            },
          });
          transport.onclose = () => {
            const initializedSessionId = transport.sessionId;
            if (initializedSessionId) sessions.delete(initializedSessionId);
          };
          await mcp.connect(transport);
          await transport.handleRequest(req, res, body);
          return;
        }

        if (!session) {
          jsonRpcError(res, 400, "Bad Request: No valid MCP session ID provided");
          return;
        }
        await session.transport.handleRequest(req, res, body);
        return;
      }

      if (req.method === "GET" || req.method === "DELETE") {
        const session = sessionId ? sessions.get(sessionId) : undefined;
        if (!session) {
          jsonRpcError(res, 400, "Bad Request: No valid MCP session ID provided");
          return;
        }
        await session.transport.handleRequest(req, res);
        return;
      }

      res.writeHead(405, { allow: "GET, POST, DELETE" });
      res.end();
    } catch (error) {
      console.error(`[chatgpt-web-mcp-http] ${error instanceof Error ? error.message : String(error)}`);
      jsonRpcError(res, 500, "Legacy Codex MCP request failed");
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    http.once("error", onError);
    http.listen(port, LEGACY_CODEX_MCP_HOST, () => {
      http.off("error", onError);
      resolve();
    });
  });

  const address = http.address();
  const boundPort = address && typeof address === "object" ? address.port : port;
  return {
    host: LEGACY_CODEX_MCP_HOST,
    port: boundPort,
    path: LEGACY_CODEX_MCP_PATH,
    async stop() {
      const active = [...sessions.values()];
      sessions.clear();
      await Promise.allSettled(active.map(session => session.server.close()));
      if (!http.listening) return;
      await new Promise<void>((resolve, reject) => {
        http.close(error => error ? reject(error) : resolve());
      });
    },
  };
}
