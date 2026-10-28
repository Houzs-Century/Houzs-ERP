// ---------------------------------------------------------------------------
// The raw-fetch inventory's own logic, over inline sources. Milliseconds, no
// tree walk of its own for the rules — the whole-tree INVENTORY is the SCRIPT's
// job (check-raw-fetch-inventory.mjs), and lives there precisely so it never has
// to fit inside a test's time budget.
//
// A checker nobody runs is not a checker, and a checker that cannot MATCH
// reports a clean run. Both halves are pinned here: the alias shapes must be
// caught, and the cheap pre-filter must not be able to hide a callsite the rules
// would have found.
//
//   node --test frontend/scripts/check-raw-fetch-inventory.test.mjs
// ---------------------------------------------------------------------------
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

import {
  containsFetchToken,
  inventory,
  sourceFiles,
} from "./check-raw-fetch-inventory.mjs";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/* A real backslash, built rather than typed. The whole point of these two
   probes is that the escape sequence reaches the scanner intact, and a literal
   backslash is the character most easily lost when this file is edited by a
   tool that re-encodes it. `ESCAPED_FETCH` is the six-character source text
   fetch, which JavaScript parses as the identifier `fetch`. */
const BACKSLASH = String.fromCharCode(92);
const ESCAPED_FETCH = `f${BACKSLASH}u0065tch`;

const ALIAS_BYPASSES = [
  "const raw = fetch; raw('/api/private')",
  "const raw = window.fetch; raw('/api/private')",
  "const raw = window['fetch']; raw('/api/private')",
  "fetch.bind(window)('/api/private')",
  "const { fetch: raw } = window; raw('/api/private')",
  `const raw = ${ESCAPED_FETCH}; raw('/api/private')`,
];

for (const source of ALIAS_BYPASSES) {
  test(`fetch aliases cannot bypass the gate: ${source}`, () => {
    assert.notDeepEqual(inventory("alias-probe.ts", "", source).unsafeReferences, []);
  });
}

test("a direct call is recorded, with its enclosing function and argument", () => {
  const { calls, unsafeReferences } = inventory(
    "probe.ts",
    "",
    "export async function check() { return fetch('/index.html'); }",
  );
  assert.deepEqual(unsafeReferences, []);
  assert.deepEqual(calls, [
    { file: "probe.ts", functionName: "check", callee: "fetch", argument: "'/index.html'" },
  ]);
});

test("the pre-filter rejects fetch-shaped WORDS the rules could never match", () => {
  assert.equal(containsFetchToken("const x = refetch(); prefetch(); api.fetchBlobUrl(u);"), false);
  assert.equal(containsFetchToken("fetch('/x')"), true);
  assert.equal(containsFetchToken("window['fetch']"), true);
  assert.equal(containsFetchToken("client.fetch(u)"), true);
  assert.equal(
    containsFetchToken(`const raw = ${ESCAPED_FETCH};`),
    true,
    "a unicode-escaped identifier is a real bypass and needs the scanner fallback",
  );
});

test("the pre-filter cannot hide a callsite the rules would have found", () => {
  /* The expensive half of this gate is skipped for files the pre-filter
     rejects, and that is only safe while the rejected set holds nothing the AST
     rules can see. So parse every REJECTED file with those same rules and
     assert they find nothing. Without this assertion the optimisation is an
     untested claim, which is the exact shape of a checker that quietly stops
     matching. */
  const missed = [];
  for (const path of sourceFiles(SRC)) {
    const text = readFileSync(path, "utf8");
    if (containsFetchToken(text)) continue;
    const source = ts.createSourceFile(
      path, text, ts.ScriptTarget.Latest, false,
      path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node) => {
      if (
        (ts.isIdentifier(node) && node.text === "fetch")
        || (ts.isStringLiteral(node) && node.text === "fetch")
        || (ts.isPropertyAccessExpression(node) && node.name.text === "fetch")
      ) missed.push(path);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.deepEqual([...new Set(missed)], []);
});
