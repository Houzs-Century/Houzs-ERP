import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";

type FetchCall = {
  file: string;
  functionName: string;
  callee: string;
  argument: string;
};

// Exact callsites, not whole-file exemptions. A second raw fetch in one of
// these files is therefore a failure too. API traffic belongs behind
// correlatedFetch; the other two calls are fixed same-origin static assets.
const EXPECTED_RAW_FETCH_CALLS: FetchCall[] = [
  {
    // One re-fetch of the hashed chunk a lazy import just failed on, to tell a
    // dropped request apart from a build that has moved before spending a
    // service-worker unregister + full cache purge on it. Same category as the
    // version check below: a fixed same-origin static asset, no API traffic, and
    // chunkUrlFrom() constrains the URL to our own origin.
    file: "components/RouteFallback.tsx",
    functionName: "probeChunk",
    callee: "fetch",
    argument: "url",
  },
  {
    file: "hooks/useVersionCheck.ts",
    functionName: "check",
    callee: "fetch",
    argument: "`/index.html?_=${Date.now()}`",
  },
  {
    file: "lib/requestCorrelation.ts",
    functionName: "correlatedFetch",
    callee: "fetch",
    argument: "input",
  },
  {
    file: "vendor/scm/lib/pdf-common.ts",
    functionName: "fetchFaceBase64",
    callee: "fetch",
    argument: "url",
  },
  {
    // Capability probe for the service worker's /print-preview route. It never
    // leaves the device — the worker answers it — and carries no API traffic, so
    // correlation headers would be meaningless. Same category as the version
    // check and the font asset above.
    file: "vendor/scm/lib/pdf-common.ts",
    functionName: "putPrintPreview",
    callee: "fetch",
    argument: "`${PRINT_PREFIX}__probe`",
  },
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

function enclosingFunctionName(node: ts.Node): string {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current))
      && ts.isVariableDeclaration(current.parent)
      && ts.isIdentifier(current.parent.name)
    ) return current.parent.name.text;
  }
  return "<module>";
}

function isFetchProperty(node: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(node)
    && node.name.text === "fetch"
  ) || (
    ts.isElementAccessExpression(node)
    && ts.isStringLiteral(node.argumentExpression)
    && node.argumentExpression.text === "fetch"
  );
}

function isDirectFetchCallee(node: ts.Node): boolean {
  return (ts.isIdentifier(node) && node.text === "fetch") || isFetchProperty(node);
}

function containsFetchToken(sourceText: string): boolean {
  if (sourceText.includes("fetch")) return true;
  if (!sourceText.includes("\\u")) return false;

  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.JSX,
    sourceText,
  );
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (
      (token === ts.SyntaxKind.Identifier || token === ts.SyntaxKind.StringLiteral)
      && scanner.getTokenValue() === "fetch"
    ) return true;
  }
  return false;
}

function inventory(path: string, srcRoot: string, sourceText?: string): {
  calls: FetchCall[];
  unsafeReferences: string[];
} {
  const text = sourceText ?? readFileSync(path, "utf8");
  // Reading every source file keeps the inventory exhaustive, while avoiding
  // expensive AST construction for files without a `fetch` identifier/string.
  if (!containsFetchToken(text)) return { calls: [], unsafeReferences: [] };

  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const file = sourceText === undefined
    ? relative(srcRoot, path).replaceAll("\\", "/")
    : path.replaceAll("\\", "/");
  const calls: FetchCall[] = [];
  const unsafeReferences: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isDirectFetchCallee(node.expression)) {
      calls.push({
        file,
        functionName: enclosingFunctionName(node),
        callee: node.expression.getText(source),
        argument: node.arguments[0]?.getText(source) ?? "<missing>",
      });
    }

    // Reject aliases and indirect access (`const f = fetch`, `fetch.bind(...)`,
    // `window["fetch"]`, destructuring, etc.). Otherwise a new transport could
    // bypass the exact direct-call inventory without making this test fail.
    if (ts.isIdentifier(node) && node.text === "fetch") {
      const parent = node.parent;
      const isBareDirect = ts.isCallExpression(parent) && parent.expression === node;
      const isNamedDirect =
        ts.isPropertyAccessExpression(parent)
        && parent.name === node
        && ts.isCallExpression(parent.parent)
        && parent.parent.expression === parent;
      if (!isBareDirect && !isNamedDirect) {
        const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
        unsafeReferences.push(`${file}:${line + 1}:${character + 1}:${node.getText(source)}`);
      }
    }
    if (
      ts.isElementAccessExpression(node)
      && ts.isStringLiteral(node.argumentExpression)
      && node.argumentExpression.text === "fetch"
      && !(ts.isCallExpression(node.parent) && node.parent.expression === node)
    ) {
      const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
      unsafeReferences.push(`${file}:${line + 1}:${character + 1}:${node.getText(source)}`);
    }

    ts.forEachChild(node, visit);
  };
  visit(source);
  return { calls, unsafeReferences };
}

describe("request correlation transport inventory", () => {
  test("every raw fetch is one exact transport/static-asset callsite", () => {
    const src = resolve(process.cwd(), "src");
    const result = sourceFiles(src).map((path) => inventory(path, src));
    const calls = result.flatMap((entry) => entry.calls)
      .sort((a, b) => `${a.file}:${a.functionName}`.localeCompare(`${b.file}:${b.functionName}`));

    expect(calls).toEqual(EXPECTED_RAW_FETCH_CALLS);
    expect(result.flatMap((entry) => entry.unsafeReferences)).toEqual([]);
  }, 15_000); // Deliberately parses the entire source tree; keep the larger budget local to this gate.

  test("the two non-API exemptions remain compile-time-constrained static assets", () => {
    const versionSource = readFileSync(resolve(process.cwd(), "src/hooks/useVersionCheck.ts"), "utf8");
    expect(versionSource).toContain('fetch(`/index.html?_=${Date.now()}`, { cache: "no-store" })');

    const fontSource = readFileSync(resolve(process.cwd(), "src/vendor/scm/lib/pdf-common.ts"), "utf8");
    expect(fontSource).toContain('type FontAssetUrl = `/fonts/${string}.ttf`;');
    expect(fontSource).toContain("fetchFaceBase64(TIER_FACES[tier].normal)");
    expect(fontSource).toContain("fetchFaceBase64(TIER_FACES[tier].bold)");
    expect(fontSource.match(/fetchFaceBase64\(/g)).toHaveLength(2);
  });

  test.each([
    "const raw = fetch; raw('/api/private')",
    "const raw = window.fetch; raw('/api/private')",
    "const raw = window['fetch']; raw('/api/private')",
    "fetch.bind(window)('/api/private')",
    "const { fetch: raw } = window; raw('/api/private')",
    String.raw`const raw = f\u0065tch; raw('/api/private')`,
  ])("fetch aliases cannot bypass the gate: %s", (source) => {
    expect(inventory("alias-probe.ts", "", source).unsafeReferences).not.toEqual([]);
  });
});
