#!/usr/bin/env node
// ----------------------------------------------------------------------------
// GIVE A COMPARTMENT THAT A CORRECTION ADDED THE AUTOCOUNT LINE KEY ITS OWN
// SIBLINGS ALREADY CARRY. Nothing else.
//
// WHAT IS BROKEN. apply-sofa-compartment-corrections.mjs corrects a sofa build
// by MATCHING existing rows to the target pieces and INSERTing the pieces the
// document does not yet hold. Both of its INSERT statements name their columns
// one by one and neither names `linked_ac_dtlkey`, so every compartment that
// script has ever ADDED landed keyless beside siblings that carry the key.
//
// WHY THAT IS NOT COSMETIC, quoted from the code that decides it:
//
//   src/scm/lib/autocount-line-keys.ts:155
//     "Every ERP row behind this AutoCount line gets the SAME key. For a sofa
//      that is the build's compartments; composeEdit later accepts the build
//      only when all of them still agree on it."
//   src/scm/lib/autocount-outbox.ts:244
//     "every compartment must carry the same DtlKey or the build has no line
//      identity at all (composeEdit then refuses, loudly)."
//   src/scm/lib/autocount-relink-lines.ts:8
//     "The ERP row stays keyless, and every LATER edit of that document is
//      refused whole by composeEdit's keyless guard. The operator reads 'The
//      ERP cannot tell which lines AutoCount already has'."
//
// And it is not only the edit path. The go-live reconcile compares a sofa's
// compartments per AutoCount DtlKey, so a keyless compartment is INVISIBLE to
// it: HC-SO-013475 holds 1A(LHF)+1NA+1A(RHF) and the reconcile of run
// 34199937397 read it as "1A(LHF)+1A(RHF)". The document also joins the
// UNJUDGEABLE bucket in probe-cutover-so-do-lines' section B, where topup and
// the link repairs then correctly refuse to touch it.
//
// THE ONLY THING THIS WRITES IS A KEY THE DOCUMENT ALREADY STATES. Four gates,
// every one the book's or the row's own word, never an inference:
//
//   1  THE ROW IS A KEYLESS SOFA COMPARTMENT on a document that WAS imported
//      (the header carries linked_ac_docno). A line raised in the ERP has no
//      AutoCount counterpart and NULL is its correct value - those are never
//      touched.
//   2  ITS SIBLINGS AGREE ON ONE KEY. The build is the document's sofa rows of
//      the same model carrying the same Desc2 - the grouping
//      check-sofa-bedframe-completeness.mjs:143 uses. If the keyed siblings
//      carry MORE than one distinct key, the build has no single identity and
//      picking one would be the coin flip this repo has already paid for.
//      Refused, and counted.
//   3  THE BOOK CONFIRMS THAT KEY IS A LINE OF THIS DOCUMENT. Read from
//      data/ac-reconcile-truth.json.gz. A key that names a line on some other
//      document is not this build's identity whatever the siblings say.
//   4  THE BOOK'S TEXT FOR THAT LINE IS THE ROW'S OWN TEXT. Compared through
//      lib/sofa-desc2-match.mjs, the same normaliser the corrections use, so a
//      real newline and a written "\n" compare equal. This is what stops a key
//      from a DIFFERENT build on the same document being copied across.
//
// A WRONG KEY IS WORSE THAN A MISSING ONE - a missing key is refused loudly by
// composeEdit, a wrong one silently edits a different line in a live account
// book (backfill-ac-sofa-line-keys.mjs says exactly this). Every gate above is
// therefore a REFUSAL, never a fallback.
//
// THIS DOES NOT ENQUEUE ANYTHING. No outbox row is written, no write-back is
// triggered, no AutoCount call is made. It repairs the ERP's own record of
// which book line each row belongs to. Owner 2026-09-08: 「写回autocount的你不需
// 要理了」 - honoured; this touches the ERP only.
//
//   MODE=plan (default)  read, classify, print every candidate, write NOTHING.
//   MODE=apply           needs CONFIRM="I HAVE REVIEWED THE DRY-RUN". Writes in
//                        ONE transaction, then re-reads on a FRESH connection
//                        and asserts the SHAPE - every repaired build's rows
//                        now carry ONE key and that key is still the book's
//                        line for that build - not a row count.
//
//   DATABASE_URL           required
//   COMPANY_ID             default 1 (AED_HOUZS)
//   MAX_SNAPSHOT_AGE_DAYS  default 2 - refuses rather than write from a stale book
//   DOC                    one document, or blank for every one
//
// RE-RUN: idempotent. A second run finds the rows already keyed, plans zero
// writes and reports zero. It can never re-point an existing key, because the
// UPDATE only ever matches a row whose linked_ac_dtlkey is still NULL.
// ----------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { normaliseDesc2 } from "./lib/sofa-desc2-match.mjs";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL required"); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const MAX_AGE_DAYS = Number(process.env.MAX_SNAPSHOT_AGE_DAYS || 2);
const ONLY = (process.env.DOC || "").trim();
const APPLY = (process.env.MODE || "plan").toLowerCase() === "apply";
const CONFIRM_PHRASE = "I HAVE REVIEWED THE DRY-RUN";
const here = path.dirname(fileURLToPath(import.meta.url));

const out = (m = "") => console.log(m);
const log = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`REFUSED: MODE=apply needs CONFIRM="${CONFIRM_PHRASE}". `
    + "Run the plan first and read every row it prints; this write restores the line identity "
    + "the AutoCount edit path addresses a document by.");
  process.exit(2);
}

const SNAP = path.join(here, "data", "ac-reconcile-truth.json.gz");
if (!fs.existsSync(SNAP)) {
  console.error(`REFUSED: ${SNAP} is not present. Gate 3 and gate 4 are the book's word, and without the book there is nothing to confirm.`);
  process.exit(2);
}
const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(SNAP)).toString("utf8"));
const ageDays = (Date.now() - new Date(snap.exported_at).getTime()) / 86400000;
if (!(ageDays <= MAX_AGE_DAYS)) {
  console.error(`REFUSED: the AutoCount snapshot is ${ageDays.toFixed(2)} days old (limit ${MAX_AGE_DAYS}).`);
  process.exit(2);
}

/* THE SNAPSHOT'S ROWS ARE ARRAYS, NOT OBJECTS (docs/bugs/0674) - reading
   r.dtlKey off one returns undefined and the empty result reads exactly like
   "there is nothing to repair". Assert the field positions. */
const L = Object.fromEntries(snap.line_fields.map((n, i) => [n, i]));
for (const f of ["docNo", "dtlKey"]) {
  if (L[f] == null) { console.error(`REFUSED: the snapshot's line_fields has no "${f}".`); process.exit(2); }
}
const D = Object.fromEntries((snap.desc2_fields ?? []).map((n, i) => [n, i]));
if (D.dtlKey == null || D.desc2 == null) {
  console.error("REFUSED: the snapshot's desc2_fields is not (dtlKey, desc2); gate 4 could not be applied.");
  process.exit(2);
}

/** book DtlKey -> { type, docNo, desc2 } over the two types this repairs. */
const bookLine = new Map();
for (const type of ["SO", "PO"]) {
  const t = snap.types[type];
  const desc2 = new Map(t.desc2.map((r) => [String(r[D.dtlKey]), String(r[D.desc2] ?? "")]));
  for (const r of t.lines) {
    const k = String(r[L.dtlKey]);
    bookLine.set(k, { type, docNo: String(r[L.docNo]), desc2: desc2.get(k) ?? "" });
  }
}

const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });
const modelOf = (code) => { const c = String(code ?? "").trim().toUpperCase(); const i = c.indexOf("-"); return i < 0 ? c : c.slice(0, i); };
/* The build key check-sofa-bedframe-completeness.mjs:143 groups by, reproduced
   because that file holds it as a private function. It carries no authority
   here on its own: gates 3 and 4 re-confirm the chosen key against the BOOK, so
   a grouping mistake refuses rather than mis-writes. */
const buildKey = (doc, code, d2) => `${doc}|${modelOf(code)}|${normaliseDesc2(d2).slice(0, 140)}`;

async function readRows(client) {
  const so = await client`
    SELECT 'SO' AS side, i.id::text AS id, i.doc_no AS doc, h.linked_ac_docno AS ac_doc,
           i.item_code AS code, i.description2 AS d2, i.linked_ac_dtlkey::text AS dtl
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no AND h.company_id = ${CO}
     WHERE i.company_id = ${CO} AND i.item_group = 'sofa' AND i.cancelled IS NOT TRUE
       AND h.linked_ac_docno IS NOT NULL
       AND (${ONLY === ""} OR i.doc_no = ${ONLY})`;
  const po = await client`
    SELECT 'PO' AS side, i.id::text AS id, h.po_number AS doc, h.linked_ac_docno AS ac_doc,
           i.item_code AS code, i.description2 AS d2, i.linked_ac_dtlkey::text AS dtl
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders h ON h.id = i.purchase_order_id AND h.company_id = ${CO}
     WHERE i.item_group = 'sofa' AND h.linked_ac_docno IS NOT NULL
       AND (${ONLY === ""} OR h.po_number = ${ONLY})`;
  return [...so, ...po];
}

/** The plan, and the reasons every other keyless row was refused. */
function planFrom(rows) {
  const builds = new Map();
  for (const r of rows) {
    const k = `${r.side}|${buildKey(r.doc, r.code, r.d2)}`;
    if (!builds.has(k)) builds.set(k, []);
    builds.get(k).push(r);
  }
  const refused = { noSibling: 0, siblingsDisagree: 0, keyNotInBook: 0, keyOnAnotherDocument: 0, textDiffers: 0 };
  const refusedDetail = [];
  const plan = [];
  let keyless = 0;
  for (const [, b] of builds) {
    const blanks = b.filter((r) => !r.dtl);
    if (!blanks.length) continue;
    keyless += blanks.length;
    const keys = [...new Set(b.filter((r) => r.dtl).map((r) => String(r.dtl)))];
    const doc = b[0].doc;
    if (keys.length === 0) { refused.noSibling += blanks.length; refusedDetail.push(`${doc} ${blanks[0].code}: no sibling of this build carries a key either`); continue; }
    if (keys.length > 1) { refused.siblingsDisagree += blanks.length; refusedDetail.push(`${doc} ${blanks[0].code}: its siblings carry ${keys.length} DIFFERENT keys (${keys.join(", ")}) - the build has no single identity`); continue; }
    const key = keys[0];
    const bl = bookLine.get(key);
    if (!bl) { refused.keyNotInBook += blanks.length; refusedDetail.push(`${doc} ${blanks[0].code}: key ${key} names no line in the book cut`); continue; }
    if (bl.docNo !== String(b[0].ac_doc)) { refused.keyOnAnotherDocument += blanks.length; refusedDetail.push(`${doc} ${blanks[0].code}: key ${key} is a line of ${bl.docNo}, not of ${b[0].ac_doc}`); continue; }
    const want = normaliseDesc2(blanks[0].d2), got = normaliseDesc2(bl.desc2);
    if (want !== "" && got !== "" && want !== got) {
      refused.textDiffers += blanks.length;
      refusedDetail.push(`${doc} ${blanks[0].code}: the book's text for key ${key} is not this row's - ${JSON.stringify(got.slice(0, 48))} vs ${JSON.stringify(want.slice(0, 48))}`);
      continue;
    }
    for (const r of blanks) plan.push({ ...r, key, acDoc: bl.docNo, siblings: b.length - blanks.length });
  }
  return { plan, refused, refusedDetail, keyless, builds: builds.size };
}

async function main() {
  out(`mode=${APPLY ? "APPLY" : "PLAN"}  company=${CO}${ONLY ? `  DOC=${ONLY}` : ""}`);
  out(`AutoCount snapshot exported_at=${snap.exported_at} (${ageDays.toFixed(2)} days old); `
    + `${bookLine.size} SO+PO book line(s) indexed`);

  const rows = await readRows(sql);
  const { plan, refused, refusedDetail, keyless, builds } = planFrom(rows);

  out("");
  out(`${rows.length} live company-${CO} sofa row(s) on imported documents, in ${builds} build(s); ${keyless} carry NO AutoCount line key`);
  out("REFUSED, each for a reason the book or the build gives:");
  out(`  no sibling of the build carries a key either      ${String(refused.noSibling).padStart(5)}  (nothing to copy - a different repair)`);
  out(`  the siblings carry MORE THAN ONE key              ${String(refused.siblingsDisagree).padStart(5)}  (gate 2 - refused, not guessed)`);
  out(`  the key names no line in the book                 ${String(refused.keyNotInBook).padStart(5)}  (gate 3)`);
  out(`  the key is a line of a DIFFERENT document         ${String(refused.keyOnAnotherDocument).padStart(5)}  (gate 3)`);
  out(`  the book's text for that key is not this row's    ${String(refused.textDiffers).padStart(5)}  (gate 4 - a key from another build)`);
  out(`  PROVABLE - all four gates passed                  ${String(plan.length).padStart(5)}`);
  const accounted = Object.values(refused).reduce((a, b) => a + b, 0) + plan.length;
  if (accounted !== keyless) {
    console.error(`REFUSED: the buckets total ${accounted} but ${keyless} rows are keyless. Some row falls through `
      + "a path this script does not report, so what it would write cannot be trusted.");
    await sql.end({ timeout: 5 });
    process.exit(2);
  }
  out(`  (the buckets total ${accounted}, which is every keyless row - none falls through unreported)`);

  out("");
  out("THE PROVABLE ROWS - each one the key its own siblings already carry, confirmed against the book:");
  for (const p of plan) {
    out(`  ${String(p.side)}  ${String(p.doc).padEnd(15)} ${String(p.code).padEnd(24)} -> DtlKey ${p.key}`
      + `   [book ${p.acDoc}, ${p.siblings} sibling(s) already carry it]`);
  }
  if (refusedDetail.length) {
    out("");
    out("REFUSED, in detail:");
    for (const d of refusedDetail) out(`  ${d}`);
  }

  if (!APPLY) {
    log(`PLAN: ${plan.length} sofa compartment(s) would be given the line key their build already states. `
      + `Nothing was written. Re-run with MODE=apply and CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }
  if (plan.length === 0) {
    log("APPLY: nothing to write - every compartment already carries its build's key. This is the idempotent re-run.");
    await sql.end({ timeout: 5 });
    return;
  }

  let written = 0;
  await sql.begin(async (tx) => {
    for (const p of plan) {
      const r = p.side === "SO"
        ? await tx`UPDATE scm.mfg_sales_order_items SET linked_ac_dtlkey = ${p.key}
                    WHERE id = ${p.id} AND linked_ac_dtlkey IS NULL RETURNING id`
        : await tx`UPDATE scm.purchase_order_items SET linked_ac_dtlkey = ${p.key}
                    WHERE id = ${p.id} AND linked_ac_dtlkey IS NULL RETURNING id`;
      written += r.length;
    }
  });
  out("");
  out(`wrote ${written} of ${plan.length} planned key(s)`
    + (written === plan.length ? "" : " - the shortfall is rows another lane keyed between the plan and the write"));

  /* FRESH CONNECTION, and the SHAPE - not a row count. A count of N is equally
     true of N keys written onto rows whose build now disagrees with itself,
     which is the exact failure composeEdit refuses on. So the verification
     re-derives the BUILDS from scratch and asserts that every one this run
     touched carries exactly ONE key, and that the key is still the book's line
     for that document. */
  const verify = postgres(url, { ssl: "require", prepare: false, max: 1 });
  try {
    const after = await readRows(verify);
    const touched = new Set(plan.map((p) => `${p.side}|${buildKey(p.doc, p.code, p.d2)}`));
    const byBuild = new Map();
    for (const r of after) {
      const k = `${r.side}|${buildKey(r.doc, r.code, r.d2)}`;
      if (!touched.has(k)) continue;
      if (!byBuild.has(k)) byBuild.set(k, []);
      byBuild.get(k).push(r);
    }
    const bad = [];
    for (const [k, b] of byBuild) {
      const keys = [...new Set(b.map((r) => String(r.dtl ?? "")))];
      if (keys.length !== 1 || keys[0] === "") { bad.push(`${b[0].doc} ${b[0].code}: the build now carries ${keys.length} distinct key(s) [${keys.join(", ")}]`); continue; }
      const bl = bookLine.get(keys[0]);
      if (!bl) { bad.push(`${b[0].doc}: key ${keys[0]} names no line in the book`); continue; }
      if (bl.docNo !== String(b[0].ac_doc)) bad.push(`${b[0].doc}: key ${keys[0]} is a line of ${bl.docNo}`);
      void k;
    }
    out("");
    out(`verification on a FRESH connection: ${byBuild.size} build(s) re-derived, ${bad.length} wrong shape`);
    for (const m of bad) out(`  ${m}`);
    if (bad.length) {
      console.error("REFUSED: the write did not produce the shape it planned. Every build above needs a human.");
      await verify.end({ timeout: 5 });
      await sql.end({ timeout: 5 });
      process.exit(2);
    }
    log(`APPLIED: ${written} sofa compartment(s) now carry the AutoCount line key their build states. `
      + `Verified on a fresh connection: all ${byBuild.size} touched build(s) agree on ONE key and it is the book's own line. `
      + "No outbox row was written and no write-back was triggered.");
    await verify.end({ timeout: 5 });
  } catch (e) {
    await verify.end({ timeout: 5 }).catch(() => {});
    throw e;
  }
  await sql.end({ timeout: 5 });
}

main().catch(async (e) => {
  console.error(e);
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(2);
});
