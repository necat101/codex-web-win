import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { bridgeToResponsesSSE } from "../../src/bridge";

/** Exercise the shipped bridge without booting the CLI or accessing browser data. */
export function installedBridge(path: string): typeof bridgeToResponsesSSE {
  const source = readFileSync(path, "utf8");
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const functions = new Map<string, ts.FunctionDeclaration>();
  for (const statement of parsed.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      functions.set(statement.name.text, statement);
    }
  }
  const bridges = [...functions.values()].filter(fn => {
    const text = fn.getText(parsed);
    return text.includes('"response.created"') && text.includes('"response.completed"')
      && text.includes("new ReadableStream");
  });
  if (bridges.length !== 1) throw new Error(`Expected exactly one bundled Responses bridge, found ${bridges.length}`);
  const names = new Set<string>();
  const collect = (name: string) => {
    if (names.has(name)) return;
    names.add(name);
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node) && functions.has(node.text)) collect(node.text);
      ts.forEachChild(node, visit);
    };
    visit(functions.get(name)!);
  };
  const name = bridges[0]!.name!.text;
  collect(name);
  // Include real helper functions, including compaction/error paths. Hard-coded
  // minifier names previously made bundle tests fail with missing VM helpers.
  const declarations = [...names].map(name => functions.get(name)!.getText(parsed));
  return runInNewContext(`${declarations.join("\n")}\n${name}`, {
    crypto, Buffer, TextEncoder, ReadableStream, setInterval, clearInterval, Date,
  });
}
