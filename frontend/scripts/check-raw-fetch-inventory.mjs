// ---------------------------------------------------------------------------
// check-raw-fetch-inventory.mjs — every raw `fetch` in frontend/src is one
// EXACT, named callsite. API traffic belongs behind `correlatedFetch`; the
// exemptions are fixed same-origin static assets and one service-worker probe.
//
// WHY THIS IS A SCRIPT AND NOT A VITEST TEST.
//
// It was `src/api/requestCorrelationInventory.test.ts` until 2026-08-21, and it
// carried an inline `}, 15_000)` timeout because it TypeScript-parses the whole
// source tree. Two things were wrong with that, and only the second is about
// speed:
//
//   1. An inline per-test timeout OVERRIDES `--testTimeout`, so no CLI flag
//      could rescue it. Under `vitest run --coverage` on the machine this repo
//      is developed on, the test took 17,378ms against that 15,000ms budget and
//      failed — every other one of the 232 files passed — so the run wrote NO
//      coverage report at all, locally, at any flag. A gate that cannot be run
//      locally is a gate whose own bugs go unnoticed, and one did: the coverage
//      ratchet's Windows REPO_ROOT bug (see scripts/coverage-areas.mjs).
//
//   2. Raising the number was never the fix — it drifts again on a slower
//      machine. Measured here: the work is 39ms to walk, ~590ms to read 891
//      files, and ~3.6s COLD to parse the 321 of them containing the substring
//      `fetch`. Under v8 coverage instrumentation that parse is what balloons,
//      because every call inside the TypeScript parser is being counted. The
//      answer is to stop doing a whole-tree parse inside an instrumented test
//      worker, not to buy it more time.
//
// So the scan runs here, once, in a plain node process with no instrumentation
// — the same shape as check-silent-mutations.mjs and check-test-focus.mjs next
// door. The pure rules keep their unit tests in
// check-raw-fetch-inventory.test.mjs (`node --test`), which is where the
// alias-bypass probes live and where they cost milliseconds.
//
//   npm --prefix frontend run check:raw-fetch
// ---------------------------------------------------------------------------
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(FRONTEND, "src");

// Exact callsites, not whole-file exemptions. A second raw fetch in one of
// these files is therefore a failure too. API traffic belongs behind
// correlatedFetch; the other two calls are fixed same-origin static assets.
export const EXPECTED_RAW_FETCH_CALLS = [
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

export function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

function enclosingFunctionName(node) {
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

function isFetchProperty(node) {
  return (
    ts.isPropertyAccessExpression(node)
    && node.name.text === "fetch"
  ) || (
    ts.isElementAccessExpression(node)
    && ts.isStringLiteral(node.argumentExpression)
    && node.argumentExpression.text === "fetch"
  );
}

function isDirectFetchCallee(node) {
  return (ts.isIdentifier(node) && node.text === "fetch") || isFetchProperty(node);
}

/**
 * Cheap pre-filter: is `fetch` present as a TOKEN this scan could act on?
 *
 * The rules below only ever recognise the bare identifier `fetch`, a `.fetch`
 * property name, or the string literal `"fetch"` — each of which necessarily
 * appears in the raw text as a whole word. `\b` in JS is `[A-Za-z0-9_]`-based,
 * so this rejects `refetch`, `prefetch`, `fetchBlobUrl` and `fetchFaceBase64`
 * without rejecting `.fetch(`, `window['fetch']` or `fetch(`.
 *
 * The one shape a word match cannot see is a UNICODE-ESCAPED identifier
 * (`fetch`), which is a real bypass — hence the scanner fallback, which
 * compares token VALUES rather than text. Measured on this tree: the word test
 * takes the parse set from 321 files to 238 and hides ZERO findings, verified by
 * parsing every dropped file with these same rules
 * (check-raw-fetch-inventory.test.mjs pins the property).
 */
export function containsFetchToken(sourceText) {
  if (/\bfetch\b/.test(sourceText)) return true;
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

export function inventory(path, srcRoot, sourceText) {
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
  const calls = [];
  const unsafeReferences = [];

  const visit = (node) => {
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
    // bypass the exact direct-call inventory without making this check fail.
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

/** The whole-tree scan. Returns the sorted callsites and the alias findings. */
export function scanTree(srcRoot = SRC) {
  /* A verdict computed over nothing must never read as a pass — the rule
     scripts/coverage-areas.mjs states in full. If SRC is not where this script
     thinks it is, every scan comes back empty and the gate reports clean. */
  if (!existsSync(srcRoot)) {
    throw new Error(
      `check-raw-fetch-inventory: ${srcRoot} does not exist — refusing to report.`,
    );
  }
  const files = sourceFiles(srcRoot);
  if (files.length === 0) {
    throw new Error(
      `check-raw-fetch-inventory: found zero .ts/.tsx files under ${srcRoot} — refusing to report.`,
    );
  }
  const results = files.map((path) => inventory(path, srcRoot));
  const calls = results.flatMap((r) => r.calls)
    .sort((a, b) => `${a.file}:${a.functionName}`.localeCompare(`${b.file}:${b.functionName}`));
  return { files, calls, unsafeReferences: results.flatMap((r) => r.unsafeReferences) };
}

/** The two non-API exemptions must stay compile-time-constrained static assets. */
export function exemptionProblems(srcRoot = SRC) {
  const problems = [];
  const want = (text, needle, where) => {
    if (!text.includes(needle)) problems.push(`${where}: expected to contain ${needle}`);
  };

  const versionSource = readFileSync(join(srcRoot, "hooks/useVersionCheck.ts"), "utf8");
  want(
    versionSource,
    'fetch(`/index.html?_=${Date.now()}`, { cache: "no-store" })',
    "hooks/useVersionCheck.ts",
  );

  const fontSource = readFileSync(join(srcRoot, "vendor/scm/lib/pdf-common.ts"), "utf8");
  want(fontSource, "type FontAssetUrl = `/fonts/${string}.ttf`;", "vendor/scm/lib/pdf-common.ts");
  want(fontSource, "fetchFaceBase64(TIER_FACES[tier].normal)", "vendor/scm/lib/pdf-common.ts");
  want(fontSource, "fetchFaceBase64(TIER_FACES[tier].bold)", "vendor/scm/lib/pdf-common.ts");
  const faceCalls = (fontSource.match(/fetchFaceBase64\(/g) ?? []).length;
  if (faceCalls !== 2) {
    problems.push(`vendor/scm/lib/pdf-common.ts: expected 2 fetchFaceBase64( calls, found ${faceCalls}`);
  }
  return problems;
}

function main() {
  const started = Date.now();
  const { files, calls, unsafeReferences } = scanTree();
  const problems = [];

  const actual = JSON.stringify(calls, null, 2);
  const expected = JSON.stringify(EXPECTED_RAW_FETCH_CALLS, null, 2);
  if (actual !== expected) {
    problems.push(
      "The raw-fetch inventory has DRIFTED.\n"
        + "  expected:\n" + expected.split("\n").map((l) => `    ${l}`).join("\n")
        + "\n  found:\n" + actual.split("\n").map((l) => `    ${l}`).join("\n"),
    );
  }
  for (const ref of unsafeReferences) {
    problems.push(`aliased or indirect \`fetch\` (a bypass of the exact inventory): ${ref}`);
  }
  problems.push(...exemptionProblems());

  console.log(
    `Scanned ${files.length} frontend/src files in ${Date.now() - started}ms — `
      + `${calls.length} raw fetch callsite(s), ${unsafeReferences.length} alias reference(s).`,
  );
  if (problems.length === 0) {
    console.log("Every raw fetch is one exact transport/static-asset callsite.");
    return 0;
  }
  console.error("");
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    "\nAPI traffic goes through correlatedFetch (src/lib/requestCorrelation.ts).\n"
      + "If a NEW callsite is genuinely a fixed same-origin static asset, add it to\n"
      + "EXPECTED_RAW_FETCH_CALLS in this file with the reason next to it.",
  );
  return 1;
}

// Only when run directly — the test suite next door imports this module.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main());
}
