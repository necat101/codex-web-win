import { describe, expect, test } from "bun:test";
import { chatGptComposer, chatGptSendButton } from "../src/adapters/chatgpt-web/browser-worker";

function fakePage() {
  const calls: string[] = [];
  const locator = (value: string): any => {
    calls.push(value);
    const current = {
      filter: (_options: unknown) => current,
      first: () => current,
      locator: (nested: string) => locator(nested),
      kind: "locator",
      value,
    };
    return current;
  };
  return {
    calls,
    page: {
      getByRole: (role: string, options: { name: RegExp }) => {
        calls.push(`${role}:${options.name}`);
        return {
          or: (other: unknown) => ({
            first: () => ({ kind: "composer", other }),
          }),
        };
      },
      locator,
    } as any,
  };
}

describe("ChatGPT current UI locator smoke coverage", () => {
  test("composer locator covers current textbox and editor fallbacks", () => {
    const { page, calls } = fakePage();
    chatGptComposer(page);

    const selectors = calls.join("\n");
    expect(selectors).toContain('data-testid="prompt-textarea"');
    expect(selectors).toContain("#prompt-textarea");
    expect(selectors).toContain("data-lexical-editor");
  });

  test("send locator covers current send button variants", () => {
    const { page, calls } = fakePage();
    chatGptSendButton(page);

    const selectors = calls.join("\n");
    expect(selectors).toContain("send-button");
    expect(selectors).toContain('button[type="submit"]');
  });
});
