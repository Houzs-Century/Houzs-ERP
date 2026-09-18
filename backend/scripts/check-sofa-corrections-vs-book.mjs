#!/usr/bin/env node
// Grade EVERY entry in the sofa corrections files against the ACCOUNT BOOK.
//
// WHY THIS EXISTS. The owner, 2026-09-08: the book wins, and an owner-approved
// file that disagrees with it is evidence the FILE is wrong. He then asked the
// bigger question - why would our SKU ever differ from the book's at all.
// sofa-compartment-corrections-2026-08.json and -2026-09.json each state a
// `model` per build, and until now nothing ever compared that model to the item
// code AutoCount itself carries on the same line. This does, for every entry.
//
// READ-ONLY AND OFFLINE. It touches no database and no network: the book is
// data/ac-reconcile-truth.json.gz (the cut the reconcile itself grades against)
// and the AutoCount to ERP item map is data/autocount-erp-mapping-1561.csv read
// through lib/ac-mapping-csv.mjs. Two parsers for one file is how 40 invented
// item-code "differences" reached the owner's table (docs/bugs/0689-the-
// reconcile-read-the-mapping-sheet-with-split-comma-so-40.md), so this uses the
// shared CSV reader and the shared Desc2 matcher, never its own.
//
// The grading itself is in lib/sofa-corrections-book-grade.mjs, which has the
// test; this file is I/O and printing.
//
// Exit 0 for every legitimate answer, including a disagreement. The answer is
// the output; a red job would read as "the check broke".
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

import { readMappingCsv, normCode } from "./lib/ac-mapping-csv.mjs";
import { loadCorrections } from "./lib/sofa-corrections-source.mjs";
import { desc2Contains } from "./lib/sofa-desc2-match.mjs";
import { SOFA_MODEL_ALIAS } from "./lib/parse-sofa.mjs";
import { gradeCorrectionsAgainstBook } from "./lib/sofa-corrections-book-grade.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, "data");
const log = (m) => console.log(m);

/** The book cut, indexed one document at a time. */
export function readBook(dataDir = DATA) {
  const truth = JSON.parse(
    zlib.gunzipSync(fs.readFileSync(path.join(dataDir, "ac-reconcile-truth.json.gz"))).toString("utf8"),
  );
  const F = Object.fromEntries(truth.line_fields.map((n, i) => [n, i]));
  const byType = {};
  for (const type of ["SO", "PO"]) {
    const t = truth.types[type];
    const desc2 = new Map(t.desc2.map((r) => [String(r[0]), r[1]]));
    const byDoc = new Map();
    for (const r of t.lines) {
      const d = String(r[F.docNo]);
      if (!byDoc.has(d)) byDoc.set(d, []);
      byDoc.get(d).push({ dtlKey: String(r[F.dtlKey]), itemKey: String(r[F.itemKey]), desc2: desc2.get(String(r[F.dtlKey])) ?? "" });
    }
    byType[type] = byDoc;
  }
  /* The book numbers a Houzs Century document WITHOUT the company prefix the
     ERP carries: HC-SO-010882 here is SO-010882 there. Established by listing
     the cut's own DocNo values, not assumed. */
  const bookLines = (doc) => {
    const key = String(doc).replace(/^HC-/, "");
    const byDoc = byType[key.startsWith("SO") ? "SO" : "PO"];
    return { present: byDoc.has(key), lines: byDoc.get(key) ?? [] };
  };
  return { truth, bookLines };
}

const { truth, bookLines } = readBook();
const mapping = readMappingCsv(fs.readFileSync(path.join(DATA, "autocount-erp-mapping-1561.csv"), "utf8"));
const { builds, held, files } = loadCorrections(DATA);

const { rows, tally } = gradeCorrectionsAgainstBook({
  builds,
  bookLines,
  erpCodeFor: (ac) => mapping.get(normCode(ac))?.erp || null,
  desc2Contains,
  alias: SOFA_MODEL_ALIAS,
});
const n = (k) => tally[k] || 0;

log("== sofa corrections vs the account book ==");
log(`book cut       ${truth.exported_at}  (${truth.source})`);
log(`files          ${files.join(" | ")}`);
log(`item map       autocount-erp-mapping-1561.csv, ${mapping.size} AutoCount codes`);
log(`alias          ${JSON.stringify(SOFA_MODEL_ALIAS)}   (5535 deliberately absent)`);
log("");
log(`entries graded                      ${rows.length} / ${builds.length}`);
log(`  name the model the book names     ${n("AGREE")} / ${rows.length}`);
log(`  agree only after SOFA_MODEL_ALIAS ${n("AGREE-VIA-ALIAS")} / ${rows.length}`);
log(`  the OWNER overrode the book       ${n("OWNER-OVERRIDE")} / ${rows.length}`);
log(`  DISAGREE with the book            ${n("DIFFER")} / ${rows.length}`);
log(`  carry no model at all             ${n("NO-MODEL-IN-FILE")} / ${rows.length}`);
log(`  build not found in the book cut   ${n("NO-BOOK-LINE")} / ${rows.length}`);
if (n("UNMAPPED-BOOK-CODE")) log(`  book code not in the item map     ${n("UNMAPPED-BOOK-CODE")} / ${rows.length}`);
if (n("BOOK-SPLIT")) log(`  book names >1 model for the build ${n("BOOK-SPLIT")} / ${rows.length}`);
log(`  held, not applied                 ${held.length}`);

const show = (title, want) => {
  const list = rows.filter((r) => r.verdict === want);
  if (!list.length) return;
  log("");
  log(`-- ${title} (${list.length}) --`);
  for (const r of list) {
    const where = r.hits.map((h) => `${h.doc} ${h.ac}`).join(", ");
    const fold = r.bookFolded.join("|") === r.bookRaw.join("|") ? "" : ` -> ${r.bookFolded.join("|")}`;
    const un = r.unmapped.length ? `   UNMAPPED ${r.unmapped.join("|")}` : "";
    log(`  ${r.docs.join(" + ")}  [${r.source.slice(-12)}]`);
    log(`      file model ${r.fileModel ?? "(none)"}   book ${r.bookRaw.join("|") || "-"}${fold}${un}`);
    if (where) log(`      book line  ${where}`);
    for (const m of r.missing) log(`      ${m}`);
  }
};

show("DISAGREE with the book - the book wins, these need correcting", "DIFFER");
/* Printed with the differences rather than with the agreements: the ERP really
   does name another product on these lines, and the only thing making that
   right is a decision somebody has to be able to find and re-read. */
show("the OWNER decided the line carries another product - his call, not a defect", "OWNER-OVERRIDE");
show("book code is not in the item map", "UNMAPPED-BOOK-CODE");
show("the book names more than one model for this build", "BOOK-SPLIT");
show("agree only because SOFA_MODEL_ALIAS folds them - policy, not a defect", "AGREE-VIA-ALIAS");
show("the entry states no model, so there is nothing to grade", "NO-MODEL-IN-FILE");
show("the build could not be located in the book cut", "NO-BOOK-LINE");

/* A document number the file names that the book raises for something ELSE is
   its own defect, and it is invisible in the grade above because the build
   simply produces no hit. The SO-linked PO import minted `HC-PO-` plus its own
   running sequence, and those numbers collide with real AutoCount purchase
   orders (HC-PO-010026 is a bedframe on another customer's order). Size it
   here rather than leave the next reader to notice. */
const collisions = [];
for (const r of rows) {
  for (const m of r.missing) {
    if (!m.includes("none carries this Desc2")) continue;
    const doc = m.split(":")[0];
    if (r.hits.some((h) => h.doc === doc)) continue;
    collisions.push({ doc, build: r.docs.join(" + "), source: r.source });
  }
}
if (collisions.length) {
  log("");
  log(`-- a document the file names holds no line of this build in the book (${collisions.length}) --`);
  for (const c of collisions) log(`  ${c.doc}   named by ${c.build}  [${c.source.slice(-12)}]`);
}

log("");
log(n("DIFFER") === 0
  ? "VERDICT: every graded entry names the model the book names."
  : `VERDICT: ${n("DIFFER")} of ${rows.length} entries name a model the book does not.`);
