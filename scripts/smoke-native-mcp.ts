import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { resolveBrokerSocketPath } from "../src/config";
import type { ChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";

/** Real stdio MCP -> Windows pipe/Unix socket -> native tool -> result round trip. */
export async function smokeNativeMcp(command: string, args: string[]): Promise<void> {
  const socket = resolveBrokerSocketPath(join(tmpdir(), `codex-mcp-smoke-${randomUUID()}.sock`));
  const broker = TurnBroker.forSocket(socket);
  const environment: ChatGptTurnEnvironment = {
    cwd: process.cwd(), roots: [process.cwd()], writableRoots: [process.cwd()],
    sandboxPolicy: { type: "dangerFullAccess" },
    tools: [{ name: "exec", namespace: "functions", freeform: true, parameters: {},
      description: "Execute JavaScript using tools and the deferred ALL_TOOLS registry." }],
  };
  const token = await broker.register(environment, "native-mcp-smoke");
  assert.equal(broker.isBound(token), false);
  const client = new Client({ name: "native-mcp-smoke", version: "1.0.0" });
  const transport = new StdioClientTransport({ command, args: [...args, "mcp", "--broker-socket", socket], stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", chunk => { stderr += String(chunk); });
  try {
    await client.connect(transport);
    const inventory = await client.listTools();
    assert(inventory.tools.some(tool => tool.name === "codex_bind_turn"));
    const claim = await client.callTool({ name: "codex_bind_turn", arguments: { turn_token: token } });
    assert(!claim.isError, JSON.stringify(claim));
    const bound = JSON.parse((claim.content as { text: string }[])[0]!.text);
    assert.equal(bound.execution, "outer_codex_native");
    assert.equal(broker.isBound(token), true);
    assert.equal(bound.outer_tool_gateway, "functions__exec");
    assert(bound.capabilities.includes("exec"));
    assert.equal(broker.pendingToolCount(token), 0, "binding must not deadlock on nested discovery");
    const again = await client.callTool({ name: "codex_bind_turn", arguments: { turn_token: token } });
    assert.equal(JSON.parse((again.content as { text: string }[])[0]!.text).binding_id, bound.binding_id);
    for (let round = 0; round < 3; round++) {
      const resultPromise = client.callTool({ name: "codex_exec", arguments: { binding_id: bound.binding_id, cmd: "fixture-command" } });
      const calls = await broker.nextToolBatch(token);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.wireName, "functions__exec");
      assert(calls[0]!.input?.includes("fixture-command"));
      broker.completeTool(token, calls[0]!.callId, { content: [{ type: "text", text: `native-result-${round}` }] });
      const result = await resultPromise;
      assert(!result.isError, JSON.stringify(result));
      assert(JSON.stringify(result.content).includes(`native-result-${round}`));
    }
    broker.revoke(token);
    assert.equal(broker.isBound(token), false);
    const revoked = await client.callTool({ name: "codex_bind_turn", arguments: { turn_token: token } });
    assert.equal(revoked.isError, true);
    console.log("NATIVE_MCP_ROUNDTRIP_OK");
  } catch (error) {
    throw new Error(`Native MCP smoke failed: ${String(error)}\n${stderr}`, { cause: error });
  } finally {
    await client.close();
    await broker.close();
  }
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  assert(command, "Usage: bun scripts/smoke-native-mcp.ts <runtime-or-launcher> [entrypoint]");
  await smokeNativeMcp(resolve(command), args);
}
