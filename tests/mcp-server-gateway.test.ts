import { describe, expect, test } from "bun:test";
import type { CodexTool } from "../src/types";
import type { ChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";
import {
  gatewayNestedTools,
  isPotentialNonOwnerBrokerError,
  execGatewayCommandProgram,
  execGatewayProgram,
  parseGatewayRuntimeTools,
  requestOwnershipScopeKey,
  resolveCommandToolName,
  resolveCommandToolNameFromInventory,
  resolveSessionContinuationToolName,
  resolveSessionContinuationToolNameFromInventory,
  shouldReroutePotentialNonOwner,
  shellCommandInvocationArgs,
  waitCellInvocationArgs,
  yieldedSessionId,
} from "../src/adapters/chatgpt-web/mcp-server";

function environmentWithTools(tools: CodexTool[]): ChatGptTurnEnvironment {
  return { tools } as ChatGptTurnEnvironment;
}

function execGateway(description: string): CodexTool {
  return {
    name: "exec",
    description,
    parameters: {},
    freeform: true,
  };
}

describe("Codex exec gateway discovery", () => {
  test("recognizes shared-tunnel ownership misses and hashes request scope values", () => {
    expect(isPotentialNonOwnerBrokerError(new Error("turn token is invalid, expired, or revoked"))).toBe(true);
    expect(isPotentialNonOwnerBrokerError(new Error("binding id is invalid or expired"))).toBe(true);
    expect(isPotentialNonOwnerBrokerError(new Error("ChatGPT web turn broker unavailable: ECONNREFUSED"))).toBe(false);
    expect(isPotentialNonOwnerBrokerError(new Error("ChatGPT web turn broker timed out"))).toBe(false);
    expect(isPotentialNonOwnerBrokerError(new Error("native command failed"))).toBe(false);

    const first = requestOwnershipScopeKey({ _meta: { "openai/session": "shared-session-A" } });
    const same = requestOwnershipScopeKey({ _meta: { "openai/session": "shared-session-A" } });
    const other = requestOwnershipScopeKey({ _meta: { "openai/session": "shared-session-B" } });
    expect(first).toBe(same);
    expect(first).not.toBe(other);
    expect(first).not.toContain("shared-session-A");
  });

  test("routes capability misses by exact local ownership, not broad connector session ownership", () => {
    const bindingMiss = new Error("binding id is invalid or expired");
    expect(shouldReroutePotentialNonOwner(bindingMiss, false)).toBe(true);
    expect(shouldReroutePotentialNonOwner(bindingMiss, true)).toBe(false);
    expect(shouldReroutePotentialNonOwner(new Error("native command failed"), false)).toBe(false);
  });

  test("does not turn a short yield request into a short shell timeout", () => {
    expect(shellCommandInvocationArgs({
      cmd: "bun run build",
      yieldTimeMs: 1_000,
    })).toEqual({
      command: "bun run build",
      timeout_ms: 300_000,
    });

    expect(shellCommandInvocationArgs({
      cmd: "bun run verify",
      yieldTimeMs: 1_000,
      timeoutMs: 120_000,
    })).toEqual({
      command: "bun run verify",
      timeout_ms: 120_000,
    });

    expect(shellCommandInvocationArgs({
      cmd: "bun run verify",
      yieldTimeMs: 1_000,
      resumable: true,
    })).toEqual({
      command: "bun run verify",
      timeout_ms: 300_000,
    });
  });

  test("preserves caller yield controls through the nested exec gateway", () => {
    const program = execGatewayProgram("shell_command", false, {
      arguments: { command: "bun run verify", timeout_ms: 300_000 },
    }, {
      yieldTimeMs: 1_000,
      maxOutputTokens: 30_000,
    });

    expect(program.split(/\r?\n/, 1)[0]).toBe('// @exec: {"yield_time_ms":1000,"max_output_tokens":30000}');
    expect(program).toContain('tools["shell_command"]');
  });

  test("discovers the command tool and executes it in one gateway round", () => {
    const program = execGatewayCommandProgram({
      cmd: "bun run verify",
      workdir: "C:\\workspace",
      yieldTimeMs: 1_000,
      maxOutputTokens: 30_000,
    });

    expect(program.split(/\r?\n/, 1)[0]).toBe('// @exec: {"yield_time_ms":1000,"max_output_tokens":30000}');
    expect(program).toContain("ALL_TOOLS.map");
    expect(program).toContain('commandNames.has("exec_command")');
    expect(program).toContain('commandNames.has("shell_command")');
    expect(program).toContain('commandNames.has("write_stdin")');
    expect(program).toContain('tools.write_stdin({ session_id: commandSessionId');
    expect(program).toContain('tools.wait({ cell_id: String(commandSessionId)');
    expect(program).toContain('while (commandResult && typeof commandResult === "object" && commandResult.session_id !== undefined)');
    expect(program).toContain('"timeout_ms":300000');
    expect(program).toContain('"bun run verify"');
  });

  test("keeps a deferred command alive until its nested session completes", async () => {
    const program = execGatewayCommandProgram({
      cmd: "bun run verify",
      yieldTimeMs: 1_000,
      maxOutputTokens: 30_000,
    });
    const emitted: string[] = [];
    let polls = 0;
    const tools = {
      exec_command: async () => ({ output: "start\n", session_id: 77 }),
      write_stdin: async () => {
        polls += 1;
        return polls === 1
          ? { output: "middle\n", session_id: 77 }
          : { output: "done\n", exit_code: 0 };
      },
    };
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<void>;
    const run = new AsyncFunction("tools", "ALL_TOOLS", "text", "image", "audio", "generatedImage", program);

    await run(
      tools,
      [
        { name: "exec_command", description: "Run a command" },
        { name: "write_stdin", description: "Continue a command" },
      ],
      (value: unknown) => emitted.push(typeof value === "string" ? value : JSON.stringify(value)),
      () => {},
      () => {},
      () => {},
    );

    expect(polls).toBe(2);
    expect(emitted).toHaveLength(1);
    expect(JSON.parse(emitted[0]!)).toEqual({ output: "start\nmiddle\ndone\n", exit_code: 0 });
  });

  test("recognizes Codex wait cells as resumable command sessions", () => {
    const environment = environmentWithTools([{
      name: "wait",
      description: "Waits on a yielded exec cell",
      parameters: { type: "object" },
    }]);

    expect(resolveSessionContinuationToolName(environment)).toBe("wait");
    expect(yieldedSessionId([
      { type: "text", text: "Script running with cell ID 66\nWall time 11.0 seconds\nOutput:" },
    ])).toBe("66");
    expect(waitCellInvocationArgs({
      sessionId: 66,
      yieldTimeMs: 2_000,
      maxOutputTokens: 4_000,
      terminate: true,
    })).toEqual({
      cell_id: "66",
      yield_time_ms: 2_000,
      max_tokens: 4_000,
      terminate: true,
    });
  });

  test("does not mistake ordinary command output for a yielded session", () => {
    expect(yieldedSessionId([
      { type: "text", text: "Script completed\nOutput:\nScript running with cell ID 66\\nWall time 11.0 seconds" },
    ])).toBeUndefined();
    expect(yieldedSessionId([
      { type: "text", text: "Script running with cell ID 66\\nWall time 11.0 seconds" },
    ])).toBe("66");
  });

  test("uses declared nested headings instead of prose examples", () => {
    const environment = environmentWithTools([
      execGateway(`
Run JavaScript code to orchestrate tools.
For example, call await tools.exec_command(...).

### \`shell_command\`
Runs a Powershell command (Windows) and returns its output.

exec tool declaration:
\`\`\`ts
declare const tools: { shell_command(args: { command: string }): Promise<unknown>; };
\`\`\`
`),
    ]);

    expect(resolveCommandToolName(environment)).toBe("shell_command");
    expect(gatewayNestedTools(environment).map(tool => tool.wireName)).toEqual(["shell_command"]);
  });

  test("captures nested declarations and freeform tools", () => {
    const environment = environmentWithTools([
      execGateway(`
### \`apply_patch\`
Apply file changes. This is a FREEFORM tool.

exec tool declaration:
\`\`\`ts
declare const tools: { apply_patch(input: string): Promise<unknown>; };
\`\`\`

### \`shell_command\`
Runs a Powershell command.

exec tool declaration:
\`\`\`typescript
declare const tools: { shell_command(args: { command: string }): Promise<unknown>; };
\`\`\`
`),
    ]);

    const nested = gatewayNestedTools(environment);
    expect(nested).toHaveLength(2);
    expect(nested[0]).toMatchObject({ wireName: "apply_patch", freeform: true });
    expect(nested[0]?.declaration).toContain("apply_patch(input: string)");
    expect(nested[1]).toMatchObject({ wireName: "shell_command", freeform: false });
    expect(nested[1]?.declaration).toContain("shell_command(args:");
  });

  test("prefers a directly advertised command tool", () => {
    const environment = environmentWithTools([
      execGateway(`
### \`shell_command\`
Runs a Powershell command.
`),
      {
        name: "exec_command",
        description: "Run a command",
        parameters: {},
      },
    ]);

    expect(resolveCommandToolName(environment)).toBe("exec_command");
  });

  test("accepts built-in native function tools when Codex groups them under functions", () => {
    const environment = environmentWithTools([
      {
        namespace: "functions",
        name: "exec_command",
        description: "Run a command",
        parameters: {},
      },
      {
        namespace: "functions",
        name: "write_stdin",
        description: "Continue a command session",
        parameters: {},
      },
    ]);

    expect(resolveCommandToolName(environment)).toBe("exec_command");
    expect(resolveSessionContinuationToolName(environment)).toBe("write_stdin");
  });

  test("accepts the freeform exec gateway when Codex groups it under functions", () => {
    const environment = environmentWithTools([{
      ...execGateway(`
### \`exec_command\`
Run a local command.
`),
      namespace: "functions",
    }]);

    expect(resolveCommandToolName(environment)).toBe("exec_command");
    expect(gatewayNestedTools(environment).map(tool => tool.wireName)).toEqual(["exec_command"]);
  });

  test("does not treat arbitrary namespaced lookalikes as native command tools", () => {
    const environment = environmentWithTools([{
      namespace: "mcp__example",
      name: "exec_command",
      description: "Unrelated app command",
      parameters: {},
    }]);

    expect(resolveCommandToolName(environment)).toBeUndefined();
  });

  test("parses deferred tools returned by the live ALL_TOOLS registry", () => {
    const runtime = parseGatewayRuntimeTools([
      {
        name: "mcp__example__lookup",
        description: `Lookup a record.

exec tool declaration:
\`\`\`ts
declare const tools: { mcp__example__lookup(args: { id: string }): Promise<unknown>; };
\`\`\``,
      },
      {
        name: "apply_patch",
        description: "Apply a patch. This is a FREEFORM tool.",
      },
    ]);

    expect(runtime).toHaveLength(2);
    expect(runtime[0]?.wireName).toBe("mcp__example__lookup");
    expect(runtime[0]?.declaration).toContain("id: string");
    expect(runtime[1]).toMatchObject({ wireName: "apply_patch", freeform: true });
  });

  test("resolves command and continuation capabilities from deferred inventory", () => {
    const environment = environmentWithTools([execGateway("Run JavaScript code to orchestrate tools.")]);
    const runtime = parseGatewayRuntimeTools([
      { name: "shell_command", description: "Runs a Powershell command." },
      { name: "wait", description: "Waits on a yielded exec cell." },
    ]);

    expect(resolveCommandToolName(environment)).toBeUndefined();
    expect(resolveSessionContinuationToolName(environment)).toBeUndefined();
    expect(resolveCommandToolNameFromInventory(environment, runtime)).toBe("shell_command");
    expect(resolveSessionContinuationToolNameFromInventory(environment, runtime)).toBe("wait");
  });

  test("returns undefined when no command capability is advertised", () => {
    const environment = environmentWithTools([
      execGateway(`
### \`view_image\`
View an image.
`),
    ]);

    expect(resolveCommandToolName(environment)).toBeUndefined();
  });
});
