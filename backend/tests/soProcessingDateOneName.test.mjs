/* The Processing Date has ONE column name, and no script may hand-type the one
   migration 0286 retired.

   This fails on the tree as it stood on 2026-08-14: ELEVEN scripts under
   backend/scripts still named `internal_expected_dd` in live SQL, four months
   of audits' worth of go-live, cutover, reconciliation and completeness checks.
   0286 applied on prod at 2026-08-13T13:46:59Z, so every one of those queries
   was answered with 42703 — and 42703 fails the WHOLE statement, not the one
   column. An audit that cannot run is not a quieter audit.

   WHY THIS AND NOT tests/soDatePairWiring.test.ts. That file already forbids
   the retired name, over a HAND-LISTED set of five src/ files, because the
   backend vitest suite runs in workerd and has no filesystem: it can only check
   files somebody remembered to add. This walks the directory, so a script
   written tomorrow is covered by existing code. node:test with no dependencies,
   run by `npm run test:scale-contract`.

   WHAT IS ALLOWED. Comments — the rename is a story worth telling, and
   unify-processing-date.mjs quotes the owner naming the column verbatim. And
   one declaration: scripts/lib/so-processing-date.mjs, which is where the
   retired spelling lives so that the audit-log scans can still match rows
   written before the rename. Everywhere else, in code, it is a defect. */
import { test } from 'vitest';
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SO_PROCESSING_DATE_COLUMN,
  SO_PROCESSING_DATE_LEGACY_COLUMNS,
} from "../scripts/lib/so-processing-date.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(here, "..", "scripts");

/** The ONE file entitled to spell the retired name: it is the declaration the
 *  rest import. Relative to backend/scripts. */
const DECLARATION = path.join("lib", "so-processing-date.mjs");

/* Source with comments removed, character-identical to the helper
 *  tests/soDatePairWiring.test.ts uses for the same job. A name that appears
 *  only in a comment is a note about history, not a query. Trailing `//`
 *  comments are deliberately NOT stripped — leaving them in only makes this
 *  stricter, and a column name parked at the end of a line of code is the one
 *  place a reader would miss it. */
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Every .mjs under backend/scripts, path relative to that directory. */
function scriptFiles() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && e.name !== "data") walk(p);
        continue;
      }
      if (e.name.endsWith(".mjs")) out.push(path.relative(SCRIPTS, p));
    }
  };
  walk(SCRIPTS);
  return out.sort();
}

const FILES = scriptFiles();
const read = (rel) => fs.readFileSync(path.join(SCRIPTS, rel), "utf8");

test("the walk actually found the script tree", () => {
  /* A guard on the guard. If the directory moves or the walk breaks, every
     assertion below passes over an empty list and reports a clean tree — the
     exact failure this whole file exists to stop. */
  assert.ok(FILES.length > 100, `walked backend/scripts and found ${FILES.length} .mjs files`);
  assert.ok(FILES.includes(DECLARATION), `${DECLARATION} is not where this test expects it`);
});

for (const legacy of SO_PROCESSING_DATE_LEGACY_COLUMNS) {
  const named = new RegExp(`\\b${legacy}\\b`);

  test(`no script names ${legacy} outside a comment`, () => {
    const offenders = FILES.filter((f) => f !== DECLARATION && named.test(code(read(f))));
    assert.deepEqual(
      offenders,
      [],
      `migration 0286 renamed ${legacy} -> ${SO_PROCESSING_DATE_COLUMN}; a query naming it ` +
        `is 42703 and returns NOTHING. Import SO_PROCESSING_DATE_COLUMN from ` +
        `./lib/so-processing-date.mjs instead — ${offenders.join(", ")}`,
    );
  });

  test(`${DECLARATION} is the only place ${legacy} is declared`, () => {
    assert.match(read(DECLARATION), named, `${DECLARATION} no longer records the retired name`);
  });
}

test("every script that still audits the Processing Date reads the name from the shared module", () => {
  /* The other half, scoped to the files this rule was written for. Forbidding
     the dead name alone can be passed by hand-typing the live one, which is how
     the dead name got into twelve files in the first place — each was correct
     the day it was written.

     Deliberately NOT extended to every .mjs that says processing_date.
     scale-pg-real-schema.mjs holds a hard-coded column list that
     tests/scaleRouteDrift.node.mjs deepEquals against the route's own: it is a
     tripwire and it is MEANT to break loudly on a rename, so binding it to the
     constant would delete the check (docs/modules/sales-order.md says so in the
     "surfaces that read this date by NAME" table). The rest name a different
     table's date. */
  const AUDITS = [
    "backfill-so-dates.mjs",
    "backfill-sofa-variants-from-desc2.mjs",
    "check-ac-vs-erp-reconcile.mjs",
    "check-cutover-completeness.mjs",
    "check-cutover-metrics.mjs",
    "check-golive-readiness.mjs",
    "check-po-so-completeness.mjs",
    "check-so-warehouse-venue-final.mjs",
    "check-sofa-bedframe-completeness.mjs",
    "check-stock-criterion.mjs",
    "diag-sofa-cutover-residue.mjs",
    "probe-rename-preconditions.mjs",
  ];
  const imports = /from ["']\.{1,2}\/(?:lib\/)?so-processing-date\.mjs["']/;
  const missing = AUDITS.filter((f) => !FILES.includes(f));
  assert.deepEqual(missing, [], `these audits were renamed or deleted; fix this list: ${missing.join(", ")}`);
  const offenders = AUDITS.filter((f) => !imports.test(read(f)));
  assert.deepEqual(
    offenders,
    [],
    `these query scm.mfg_sales_orders' Processing Date and must read ${SO_PROCESSING_DATE_COLUMN} ` +
      `from lib/so-processing-date.mjs, not a literal: ${offenders.join(", ")}`,
  );
});
