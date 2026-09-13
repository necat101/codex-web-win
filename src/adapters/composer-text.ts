/**
 * Browser text controls expose line endings as LF even when the inserted
 * JavaScript string contained CRLF (or a bare CR). Keep fidelity checks strict
 * for every other character while accepting that standards-defined rewrite.
 */
export function normalizeBrowserComposerText(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

export function browserComposerTextMatches(expected: string, observed: string): boolean {
  return normalizeBrowserComposerText(expected) === normalizeBrowserComposerText(observed);
}
