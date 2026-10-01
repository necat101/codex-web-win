import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { ChatGptTurnEnvironment } from "./environment";

const execFileAsync = promisify(execFile);
const DEFAULT_OUTPUT_CHARS = 50_000;
const MAX_OUTPUT_CHARS = 200_000;
const MAX_READ_FILE_BYTES = 16 * 1024 * 1024;

export type ReadOnlyInspectionOperation = "read_file" | "search" | "list_files" | "git_status" | "git_diff" | "git_log";

export interface ReadOnlyInspectionRequest {
  operation: ReadOnlyInspectionOperation;
  path?: string;
  paths?: string[];
  query?: string;
  fixedStrings?: boolean;
  contextLines?: number;
  startLine?: number;
  endLine?: number;
  staged?: boolean;
  maxCount?: number;
  maxOutputChars?: number;
}

export interface ReadOnlyInspectionResult {
  operation: ReadOnlyInspectionOperation;
  output: string;
  truncated: boolean;
  output_chars: number;
}

function pathKey(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function boundedOutput(text: string, maxChars: number): { output: string; truncated: boolean } {
  if (text.length <= maxChars) return { output: text, truncated: false };
  const marker = `\n...[read-only inspection output truncated; original_chars=${text.length}]...\n`;
  const keep = Math.max(0, maxChars - marker.length);
  return { output: text.slice(0, keep) + marker, truncated: true };
}

async function canonicalRoots(environment: ChatGptTurnEnvironment): Promise<string[]> {
  if (environment.roots.length === 0) throw new Error("Codex read-only inspection has no bound workspace roots");
  const roots = await Promise.all(environment.roots.map(async root => pathKey(await realpath(root))));
  return [...new Set(roots)];
}

async function canonicalInspectionPath(
  environment: ChatGptTurnEnvironment,
  roots: readonly string[],
  requested: string | undefined,
): Promise<string> {
  const lexical = resolve(environment.cwd, requested?.trim() || ".");
  const canonical = await realpath(lexical);
  const key = pathKey(canonical);
  if (!roots.some(root => isWithin(root, key))) {
    throw new Error(`Codex read-only inspection path is outside the bound workspace roots: ${requested ?? "."}`);
  }
  return canonical;
}

async function canonicalInspectionPaths(
  environment: ChatGptTurnEnvironment,
  roots: readonly string[],
  requested: string[] | undefined,
): Promise<string[]> {
  const paths = requested && requested.length > 0 ? requested : ["."];
  if (paths.length > 64) throw new Error("Codex read-only inspection accepts at most 64 paths");
  return Promise.all(paths.map(value => canonicalInspectionPath(environment, roots, value)));
}

async function readOnlyProcess(
  executable: string,
  args: string[],
  cwd: string,
  allowExitOne = false,
): Promise<string> {
  try {
    const result = await execFileAsync(executable, args, {
      cwd,
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    return String(result.stdout ?? "") + String(result.stderr ?? "");
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: string | number };
    if (allowExitOne && Number(failure.code) === 1) return String(failure.stdout ?? "") + String(failure.stderr ?? "");
    const detail = [failure.message, failure.stderr, failure.stdout].filter(Boolean).join("\n").trim();
    throw new Error(`Codex read-only inspection ${executable} failed${detail ? `: ${detail}` : ""}`);
  }
}

function gitSafeDirectoryArgs(repo: string): string[] {
  // This is intentionally scoped to the exact canonical directory supplied to
  // the read-only helper. It avoids the broad `safe.directory=*` escape hatch
  // while allowing an Administrator-owned Windows checkout to be inspected.
  return ["-c", `safe.directory=${repo}`];
}

async function gitRepositoryRoot(
  environment: ChatGptTurnEnvironment,
  roots: readonly string[],
  requested: string | undefined,
): Promise<string> {
  let candidate = await canonicalInspectionPath(environment, roots, requested);
  const info = await stat(candidate);
  if (!info.isDirectory()) candidate = dirname(candidate);
  for (;;) {
    if (!roots.some(root => isWithin(root, pathKey(candidate)))) break;
    try {
      await stat(join(candidate, ".git"));
      return candidate;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String((error as NodeJS.ErrnoException).code ?? "")
        : "";
      if (code && code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  throw new Error("Codex read-only git inspection could not find a repository root inside the bound workspace");
}

function relativeGitPath(repo: string, target: string): string {
  const rel = relative(repo, target);
  if (rel === "") return ".";
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error("Codex read-only git path escapes the inspected repository");
  }
  return rel.replaceAll("\\", "/");
}

export async function inspectBoundWorkspace(
  environment: ChatGptTurnEnvironment,
  request: ReadOnlyInspectionRequest,
): Promise<ReadOnlyInspectionResult> {
  const roots = await canonicalRoots(environment);
  const cwd = await canonicalInspectionPath(environment, roots, ".");
  const maxChars = boundedInteger(request.maxOutputChars, DEFAULT_OUTPUT_CHARS, 1_000, MAX_OUTPUT_CHARS);
  let raw = "";

  if (request.operation === "read_file") {
    if (!request.path?.trim()) throw new Error("Codex read-only read_file requires path");
    const file = await canonicalInspectionPath(environment, roots, request.path);
    const info = await stat(file);
    if (!info.isFile()) throw new Error("Codex read-only read_file target is not a regular file");
    if (info.size > MAX_READ_FILE_BYTES) {
      throw new Error(`Codex read-only read_file refuses files larger than ${MAX_READ_FILE_BYTES} bytes`);
    }
    const lines = (await readFile(file, "utf8")).split(/\r?\n/);
    const start = boundedInteger(request.startLine, 1, 1, Math.max(1, lines.length));
    const end = boundedInteger(request.endLine, lines.length, start, lines.length);
    raw = lines.slice(start - 1, end).map((line, index) => `${start + index}:${line}`).join("\n");
  } else if (request.operation === "search") {
    const query = request.query ?? "";
    if (!query || query.length > 2_000) throw new Error("Codex read-only search requires query with at most 2000 characters");
    const paths = await canonicalInspectionPaths(environment, roots, request.paths ?? (request.path ? [request.path] : undefined));
    const context = boundedInteger(request.contextLines, 0, 0, 20);
    const args = ["-n", "--no-heading", "--color", "never"];
    if (request.fixedStrings) args.push("-F");
    if (context > 0) args.push("-C", String(context));
    args.push("--", query, ...paths);
    raw = await readOnlyProcess("rg", args, cwd, true);
  } else if (request.operation === "list_files") {
    const paths = await canonicalInspectionPaths(environment, roots, request.paths ?? (request.path ? [request.path] : undefined));
    raw = await readOnlyProcess("rg", ["--files", "--", ...paths], cwd);
  } else if (request.operation === "git_status") {
    const repo = await gitRepositoryRoot(environment, roots, request.path);
    raw = await readOnlyProcess(
      "git",
      // `all` recursively enumerates every file under large untracked build and
      // dependency trees (for example node_modules), which can turn a harmless
      // status probe into a minutes-long operation. Git's normal summary still
      // reports those directories without exploding the result set.
      [...gitSafeDirectoryArgs(repo), "--no-pager", "status", "--short", "--branch", "--untracked-files=normal"],
      repo,
    );
  } else if (request.operation === "git_diff") {
    const repo = await gitRepositoryRoot(environment, roots, request.path);
    const targets = request.paths && request.paths.length > 0
      ? await canonicalInspectionPaths(environment, roots, request.paths)
      : [];
    const pathspecs = targets.map(target => relativeGitPath(repo, target));
    const args = [
      ...gitSafeDirectoryArgs(repo),
      "--no-pager",
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      ...(request.staged ? ["--cached"] : []),
      ...(pathspecs.length > 0 ? ["--", ...pathspecs] : []),
    ];
    raw = await readOnlyProcess("git", args, repo);
  } else if (request.operation === "git_log") {
    const repo = await gitRepositoryRoot(environment, roots, request.path);
    const targets = request.paths && request.paths.length > 0
      ? await canonicalInspectionPaths(environment, roots, request.paths)
      : [];
    const pathspecs = targets.map(target => relativeGitPath(repo, target));
    const maxCount = boundedInteger(request.maxCount, 20, 1, 200);
    const args = [
      ...gitSafeDirectoryArgs(repo),
      "--no-pager",
      "log",
      `--max-count=${maxCount}`,
      "--date=iso-strict",
      "--format=%H%x09%aI%x09%an%x09%s",
      ...(pathspecs.length > 0 ? ["--", ...pathspecs] : []),
    ];
    raw = await readOnlyProcess("git", args, repo);
  } else {
    throw new Error(`Unsupported Codex read-only inspection operation: ${String(request.operation)}`);
  }

  const bounded = boundedOutput(raw, maxChars);
  return {
    operation: request.operation,
    output: bounded.output,
    truncated: bounded.truncated,
    output_chars: bounded.output.length,
  };
}
