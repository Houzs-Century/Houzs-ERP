#!/usr/bin/env node
/* check-ac-gap-attribution — for every AutoCount document the ERP is supposed
 * to hold, is it MISSING, or is it sitting in a file we already committed and
 * simply has not been written in yet?
 *
 * WHY THIS EXISTS.  `check-ac-erp-reconcile.mjs` answers "which in-scope
 * documents is the ERP not holding" and its answer is a number of GAPS.  A gap
 * reads as "we have no importer for this" and that reading has been wrong every
 * time it has been checked.  On 2026-09-07, go-live day, it was worth 32 goods
 * receipts and 12 delivery orders: PR #3029 re-cut the migration source files
 * from the live book that morning, and neither of the two jobs that consume
 * them had been dispatched since 2026-08-29.  Every one of those 44 documents
 * was already in the tree.
 *
 * So this check asks the cheaper question first, and it asks it OFFLINE: it
 * needs no database and no network, only the committed snapshot and the
 * committed migration sources.  Run it before writing an importer.  If it says
 * a population is fully present in its source file, the remedy is a
 * workflow_dispatch, not code.
 *
 * READ-ONLY, zero dependencies — it runs on a bare checkout with no
 * node_modules, because the completeness-claim gate re-executes this shape.
 *
 * The in-scope definition is NOT restated here.  It lives in
 * scripts/lib/ac-scope.mjs, which the reconcile reads too, so the two can never
 * disagree about who is in scope.
 *
 * RE-RUN: read-only and pure.  A second run against the same commit prints the
 * same answer; it changes only when the snapshot or a migration source does.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

import { MIGRATION_SOURCE, buildScope, decodeBook } from "./lib/ac-scope.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, "data");
const SNAP = path.join(DATA, "ac-reconcile-truth.json.gz");

const out = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

if (!fs.existsSync(SNAP)) {
  console.error(
    `REFUSED: ${SNAP} is missing. Run backend/scripts/export-ac-reconcile-truth.mjs against the book first.`,
  );
  process.exit(2);
}
const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DATA, f))).toString("utf8").replace(/^﻿/, ""));

const snap = gz("ac-reconcile-truth.json.gz");
const book = decodeBook(snap);
const scope = buildScope(book);

console.log(`AutoCount snapshot exported_at=${snap.exported_at}`);
console.log(`source=${snap.source}`);
console.log("");

/* The document numbers each committed migration source actually carries. A
   source file that does not exist is reported as such and never silently
   treated as empty — an empty set would make every document look missing, and
   "the gap is real" is exactly the wrong answer to reach by accident. */
const held = (cfg) => {
  const files = [cfg.file, cfg.also].filter(Boolean);
  const set = new Set();
  for (const f of files) {
    if (!fs.existsSync(path.join(DATA, f))) return { set: null, missing: f };
    for (const r of gz(f)) {
      const v = r[cfg.docField];
      if (v) set.add(String(v).trim());
    }
  }
  return { set, missing: null };
};

let closable = 0;
let genuinelyAbsent = 0;

for (const t of ["SO", "PO", "GR", "DO", "IV", "PI"]) {
  const cfg = MIGRATION_SOURCE[t];
  const inScope = scope[t];
  if (!cfg.file) {
    out(`${t}: no population expected — the owner declined the historical import. Nothing to attribute.`);
    continue;
  }
  const { set, missing } = held(cfg);
  if (!set) {
    out(`${t}: CANNOT ANSWER — the migration source ${missing} is not in the tree.`);
    continue;
  }
  const absent = [...inScope].filter((d) => !set.has(d)).sort();
  const present = inScope.size - absent.length;
  closable += present;
  genuinelyAbsent += absent.length;
  const names = [cfg.file, cfg.also].filter(Boolean).join(" + ");
  out(
    `${t}: ${inScope.size} in scope; ${present} already carried by ${names}; ` +
      `${absent.length} NOT in any committed migration source`,
  );
  console.log(`     the job that writes them in: ${cfg.workflow}  (${cfg.writer})`);
  if (cfg.note) console.log(`     note: ${cfg.note}`);
  if (absent.length) console.log(`     not in the source (first 20): ${absent.slice(0, 20).join(", ")}`);
}

console.log("");
out(
  `${closable} in-scope documents are already in a committed migration source; ` +
    `${genuinelyAbsent} are not in any of them.`,
);
console.log(
  "A document in the source that the ERP does not hold needs a DISPATCH, not an importer. Run the job named\n" +
    "above in DRY-RUN first (apply=0 / mode=plan); its plan is the number that would be written.",
);
