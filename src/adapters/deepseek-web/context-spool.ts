import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const DEEPSEEK_WEB_PROMPT_CHAR_BUDGET = 48_000;
export const DEEPSEEK_WEB_INLINE_CONTEXT_CHARS = 12_000;

export interface DeepSeekRollingContextArchive {
  path: string;
  archivedChars: number;
}

function defaultContextDirectory(): string {
  return path.join(tmpdir(), "codex-deepseek-context");
}

function safeContextKey(contextKey: string): string {
  const readable = contextKey.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 40);
  const digest = createHash("sha256").update(contextKey).digest("hex").slice(0, 16);
  return readable ? `${readable}-${digest}` : digest;
}

/**
 * Keep one replace-in-place context file per DeepSeek conversation identity.
 * The browser receives only a compact pointer plus recent context; the complete
 * serialized history remains local and can be searched/read in bounded slices
 * through Codex's normal command tool when older details are actually needed.
 */
export function writeDeepSeekRollingContext(
  contextKey: string,
  content: { priorityInstructions: string; serializedHistory: string },
  directory = defaultContextDirectory(),
): DeepSeekRollingContextArchive {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    chmodSync(directory, 0o700);
  } catch {
    // Windows ACLs are authoritative there; chmod can be a no-op or unsupported.
  }

  const file = path.join(directory, `context-${safeContextKey(contextKey)}.txt`);
  const temporaryFile = `${file}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  const archiveText = [
    "CODEX DEEPSEEK WEB ROLLING CONTEXT",
    "==================================",
    `updated_at: ${new Date().toISOString()}`,
    `context_key: ${contextKey}`,
    "",
    "This file is local overflow context for the current Codex task.",
    "It contains the complete serialized history that was too large to paste into DeepSeek Web.",
    "Search it and read only bounded relevant slices; do not dump the whole file back into web chat.",
    "",
    "<priority_instructions>",
    content.priorityInstructions || "[no serialized system/developer instructions]",
    "</priority_instructions>",
    "",
    "<serialized_history>",
    content.serializedHistory,
    "</serialized_history>",
    "",
  ].join("\n");

  try {
    writeFileSync(temporaryFile, archiveText, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporaryFile, file);
    try {
      chmodSync(file, 0o600);
    } catch {
      // See directory chmod note above.
    }
  } finally {
    rmSync(temporaryFile, { force: true });
  }

  return { path: file, archivedChars: archiveText.length };
}
