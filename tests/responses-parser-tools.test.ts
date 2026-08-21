import { describe, expect, test } from "bun:test";
import { parseRequest } from "../src/responses/parser";
import { namespacedToolName } from "../src/types";

function parsedToolSignature(body: unknown): string[] {
  return (parseRequest(body).context.tools ?? []).map(tool => (
    `${namespacedToolName(tool.namespace, tool.name)}:${tool.freeform === true ? "custom" : "function"}`
  ));
}

describe("Responses additional_tools parsing", () => {
  test("keeps a top-level freeform exec gateway", () => {
    expect(parsedToolSignature({
      model: "chatgpt-web/high",
      input: [{
        type: "additional_tools",
        role: "developer",
        tools: [
          { type: "custom", name: "exec", description: "Run JavaScript." },
          { type: "function", name: "wait", parameters: {} },
        ],
      }],
    })).toEqual(["exec:custom", "wait:function"]);
  });

  test("keeps a freeform exec gateway grouped under the default functions namespace", () => {
    expect(parsedToolSignature({
      model: "chatgpt-web/high",
      input: [{
        type: "additional_tools",
        role: "developer",
        tools: [{
          type: "namespace",
          name: "functions",
          tools: [
            { type: "custom", name: "exec", description: "Run JavaScript." },
            { type: "function", name: "wait", parameters: {} },
          ],
        }],
      }],
    })).toEqual(["functions__exec:custom", "functions__wait:function"]);
  });
});
