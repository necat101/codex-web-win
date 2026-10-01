import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, test } from "bun:test";
import {
  LEGACY_CODEX_MCP_HOST,
  LEGACY_CODEX_MCP_PATH,
  LEGACY_CODEX_MCP_PORT,
  startLegacyCodexMcpHttpServer,
} from "../src/adapters/chatgpt-web/mcp-http";

describe("legacy Codex Native HTTP MCP compatibility", () => {
  test("keeps the historical loopback route", () => {
    expect(LEGACY_CODEX_MCP_HOST).toBe("127.0.0.1");
    expect(LEGACY_CODEX_MCP_PORT).toBe(17847);
    expect(LEGACY_CODEX_MCP_PATH).toBe("/v1");
  });

  test("initializes and exposes the native bridge tools over Streamable HTTP", async () => {
    const server = await startLegacyCodexMcpHttpServer({
      brokerSocketPath: "unused-by-list-tools",
      port: 0,
    });
    const client = new Client({ name: "legacy-http-smoke", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://${server.host}:${server.port}${server.path}`),
    );
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      const names = new Set(tools.tools.map(tool => tool.name));
      expect(names.has("codex_bind_turn")).toBe(true);
      expect(names.has("codex_inspect")).toBe(true);
      expect(names.has("codex_exec")).toBe(true);
      expect(names.has("codex_wait_session")).toBe(true);
      expect(names.has("codex_read_compaction")).toBe(true);
      expect(names.has("codex_tool_inventory")).toBe(true);
      expect(names.has("codex_tool_call")).toBe(true);
      const inspect = tools.tools.find(tool => tool.name === "codex_inspect");
      expect(inspect?.annotations?.readOnlyHint).toBe(true);
      expect(inspect?.annotations?.destructiveHint).toBe(false);
      const wait = tools.tools.find(tool => tool.name === "codex_wait_session");
      expect(wait?.annotations?.readOnlyHint).toBe(true);
      expect(wait?.annotations?.destructiveHint).toBe(false);
      const exec = tools.tools.find(tool => tool.name === "codex_exec");
      expect(exec?.annotations?.destructiveHint).toBe(true);
    } finally {
      await client.close();
      await server.stop();
    }
  });
});
