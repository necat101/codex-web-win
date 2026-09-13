import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexTool } from "../src/types";
import type { ChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";
import { validateBatchTools } from "../src/adapters/chatgpt-web/index";
import { TurnBroker, callTurnBroker } from "../src/adapters/chatgpt-web/turn-broker";

function environment(tools: CodexTool[]): ChatGptTurnEnvironment {
  const cwd = process.cwd();
  return {
    cwd,
    roots: [cwd],
    writableRoots: [cwd],
    sandboxPolicy: { type: "dangerFullAccess" },
    tools,
  };
}

function tool(namespace: string, name: string, description = name): CodexTool {
  return { namespace, name, description, parameters: {} };
}

describe("active-turn broker tool registry", () => {
  test("retains prior tools across an empty continuation and unions later declarations", async () => {
    const socketPath = join(tmpdir(), `codex-web-registry-${randomUUID()}.sock`);
    const broker = TurnBroker.forSocket(socketPath);
    const initial = [
      { ...tool("functions", "exec", "original gateway"), freeform: true },
      tool("functions", "wait"),
    ];

    try {
      const token = await broker.register(environment(initial), "registry-test");

      const afterEmpty = broker.updateEnvironment(token, environment([]));
      expect(afterEmpty.tools.map(value => `${value.namespace}__${value.name}`)).toEqual([
        "functions__exec",
        "functions__wait",
      ]);

      const afterExpansion = broker.updateEnvironment(token, environment([
        { ...tool("functions", "exec", "updated gateway"), freeform: true },
        tool("collaboration", "spawn_agent"),
      ]));
      expect(afterExpansion.tools.map(value => `${value.namespace}__${value.name}`)).toEqual([
        "functions__exec",
        "functions__wait",
        "collaboration__spawn_agent",
      ]);
      expect(afterExpansion.tools[0]?.description).toBe("updated gateway");

      const claimed = await callTurnBroker<{ environment: ChatGptTurnEnvironment }>(socketPath, {
        method: "claim",
        token,
      });
      expect(claimed.environment.tools).toEqual(afterExpansion.tools);

      expect(() => validateBatchTools(afterExpansion.tools, [{
        callId: "call_registry",
        wireName: "functions__exec",
        freeform: true,
        input: "text(ALL_TOOLS);",
      }])).not.toThrow();
    } finally {
      await broker.close();
    }
  });
});
