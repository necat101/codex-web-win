import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";
import { inspectBoundWorkspace } from "../src/adapters/chatgpt-web/read-only-inspection";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; outside: string; environment: ChatGptTurnEnvironment }> {
  const root = await mkdtemp(join(tmpdir(), "codex-readonly-inspect-root-"));
  const outside = await mkdtemp(join(tmpdir(), "codex-readonly-inspect-outside-"));
  temporaryDirectories.push(root, outside);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "sample.txt"), "alpha\nbeta needle\ngamma\n", "utf8");
  await writeFile(join(outside, "secret.txt"), "must not be readable", "utf8");
  return {
    root,
    outside,
    environment: {
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    },
  };
}

describe("Codex read-only workspace inspection", () => {
  test("reads bounded line ranges without a shell", async () => {
    const { environment } = await fixture();
    const result = await inspectBoundWorkspace(environment, {
      operation: "read_file",
      path: "src/sample.txt",
      startLine: 2,
      endLine: 3,
    });
    expect(result.output).toBe("2:beta needle\n3:gamma");
    expect(result.truncated).toBe(false);
  });

  test("searches the workspace and returns line-numbered matches", async () => {
    const { environment } = await fixture();
    const result = await inspectBoundWorkspace(environment, {
      operation: "search",
      path: "src",
      query: "needle",
      fixedStrings: true,
    });
    expect(result.output).toContain("sample.txt:2:beta needle");
  });

  test("lists files without exposing paths outside the bound workspace", async () => {
    const { environment } = await fixture();
    const result = await inspectBoundWorkspace(environment, {
      operation: "list_files",
      path: "src",
    });
    expect(result.output).toContain("sample.txt");
    expect(result.output).not.toContain("secret.txt");
  });

  test("reports git status and diff without mutating the repository", async () => {
    const { root, environment } = await fixture();
    await execFileAsync("git", ["init"], { cwd: root, windowsHide: true });
    await execFileAsync("git", ["config", "user.email", "readonly-inspection@example.invalid"], { cwd: root, windowsHide: true });
    await execFileAsync("git", ["config", "user.name", "Read Only Inspection Test"], { cwd: root, windowsHide: true });
    await execFileAsync("git", ["add", "src/sample.txt"], { cwd: root, windowsHide: true });
    await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: root, windowsHide: true });
    await writeFile(join(root, "src", "sample.txt"), "alpha\nbeta needle changed\ngamma\n", "utf8");

    const status = await inspectBoundWorkspace(environment, { operation: "git_status" });
    expect(status.output).toContain("src/sample.txt");

    const diff = await inspectBoundWorkspace(environment, {
      operation: "git_diff",
      paths: ["src/sample.txt"],
    });
    expect(diff.output).toContain("beta needle changed");

    const statusAfter = await inspectBoundWorkspace(environment, { operation: "git_status" });
    expect(statusAfter.output).toBe(status.output);

    const subdirectoryEnvironment = { ...environment, cwd: join(root, "src") };
    const nestedStatus = await inspectBoundWorkspace(subdirectoryEnvironment, { operation: "git_status" });
    expect(nestedStatus.output).toContain("src/sample.txt");
    const nestedDiff = await inspectBoundWorkspace(subdirectoryEnvironment, {
      operation: "git_diff",
      paths: ["sample.txt"],
    });
    expect(nestedDiff.output).toContain("beta needle changed");

    const history = await inspectBoundWorkspace(environment, {
      operation: "git_log",
      paths: ["src/sample.txt"],
      maxCount: 1,
    });
    expect(history.output).toContain("Read Only Inspection Test");
    expect(history.output).toContain("fixture");
  });

  test("summarizes large untracked directories instead of recursively listing every file", async () => {
    const { root, environment } = await fixture();
    await execFileAsync("git", ["init"], { cwd: root, windowsHide: true });
    await mkdir(join(root, "generated", "nested"), { recursive: true });
    await writeFile(join(root, "generated", "nested", "one.txt"), "one", "utf8");
    await writeFile(join(root, "generated", "nested", "two.txt"), "two", "utf8");

    const status = await inspectBoundWorkspace(environment, { operation: "git_status" });
    expect(status.output).toContain("?? generated/");
    expect(status.output).not.toContain("generated/nested/one.txt");
    expect(status.output).not.toContain("generated/nested/two.txt");
  });

  test("rejects canonical targets outside the bound workspace", async () => {
    const { environment, outside } = await fixture();
    await expect(inspectBoundWorkspace(environment, {
      operation: "read_file",
      path: join(outside, "secret.txt"),
    })).rejects.toThrow("outside the bound workspace roots");
  });
});
