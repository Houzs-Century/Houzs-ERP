#!/usr/bin/env node
// ----------------------------------------------------------------------------
// READ-ONLY. OF THE PURCHASE-ORDER LINES THAT CARRY NO SALES ORDER, HOW MANY
// DOES THE ACCOUNT BOOK PROVABLY RESOLVE — AND HOW MANY WOULD BE A GUESS?
//
// WHY. check-ac-convert-symmetry's new section 5 found 16 document edges that
// AutoCount records and the ERP does not hold, all of them on SO->PO, the one
// edge the book keys at LINE level (PODTL.FromSODtlKey). 4a separately reports
// 369 company-1 purchase-order lines carrying no sales-order link at all. A
// NULL there is not automatically a defect — a purchase order raised on its own
// legitimately has no sales order — so the only thing that can say which of
// those 369 SHOULD have been a link is the book.
//
// This probe answers that and nothing else. It writes nothing. Its output is
// the input to a repair that has not been built, and it is deliberately
// separate from one: the count of recoverable rows has to be known before
// anybody argues about how to write them.
//
// THE FOUR WAYS A ROW FAILS TO BE PROVABLE, counted separately, because the
// distinction between them is the whole point:
//
//   1  NO BOOK ROW. The ERP line carries no linked_ac_dtlkey, or the key names
//      no line in the snapshot. Nothing to recover from. Most of the 369 are
//      expected to be here: an ERP-native purchase order was never in the book.
//   2  THE BOOK RECORDS NO SOURCE. The book row exists and its FromSODtlKey is
//      empty — AutoCount itself says this purchase order came from no sales
//      order. Writing a link here would INVENT the relationship.
//   3  THE KEY IS AMBIGUOUS. linked_ac_dtlkey is NOT unique in this ERP (0273 /
//      0280 — a sofa is one book line and one ERP row per compartment, and 296
//      sales-order keys are carried by more than one row). Where either end
//      resolves to several rows, a Map keyed by DtlKey keeps ONE of them and
//      the pairing becomes a coin flip. Refused, and counted.
//   4  THE TWO ENDS NAME DIFFERENT PRODUCTS. The bug class this repo paid for
//      on 2026-09-07: a link written on the strength of a key pair without ever
//      comparing item_code put nine sales-order lines on a purchase-order line
//      for a different bed, and a customer's REGAL read READY when a TRION
//      arrived (docs/bugs/0671, class 0672). A key match is NOT an identity
//      match, and this probe will not call one recoverable.
//
// Only a row that survives all four is counted RECOVERABLE. That is the number
// a repair may write, and it is a floor on honesty, not a target: if it comes
// back small, the answer to the owner is that the book does not record the rest,
// not that we should infer them. migration-copy-never-compute.
//
// PRIVACY: this repository and its Actions logs are PUBLIC. Document numbers of
// the failing rows are printed for the SIXTEEN named edges only — they are
// already in the symmetry check's public output — and everything else is counts.
//
// NOTHING IS WRITTEN. SELECTs only. No DDL, no transaction, no temp table.
//
//   DATABASE_URL           required
//   COMPANY_ID             default 1 (AED_HOUZS)
//   MAX_SNAPSHOT_AGE_DAYS  default 2 — refuses rather than answer from a stale book
//
// RE-RUN: idempotent and side-effect free. Safe to run any number of times.
// ----------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL required");
  process.exit(2);
}
const CO = Number(process.env.COMPANY_ID || 1);
const MAX_AGE_DAYS = Number(process.env.MAX_SNAPSHOT_AGE_DAYS || 2);
const here = path.dirname(fileURLToPath(import.meta.url));
const SNAP = path.join(here, "data", "ac-convert-edges.json.gz");

const log = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const out = (m = "") => console.log(m);

/* Item codes compared the way a human reads them — trimmed, upper-cased, inner
   whitespace collapsed. Looser would hide a real mismatch; stricter would
   report formatting as a wrong product. Same normaliser probe-link-identity
   uses, deliberately, so the two probes cannot disagree about what "the same
   product" means. */
const norm = (s) => (s ?? "").trim().toUpperCase().replace(/\s+/g, " ");

if (!fs.existsSync(SNAP)) {
  console.error(`REFUSED: ${SNAP} is not present. The book half cannot be answered without it.`);
  process.exit(2);
}
const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(SNAP)).toString("utf8"));
const ageDays = (Date.now() - new Date(snap.exported_at).getTime()) / 86400000;
if (!(ageDays <= MAX_AGE_DAYS)) {
  console.error(`REFUSED: the AutoCount snapshot is ${ageDays.toFixed(2)} days old (limit ${MAX_AGE_DAYS}). `
    + "Answering a link question from a stale book would name rows that have since been converted.");
  process.exit(2);
}
out(`AutoCount snapshot exported_at=${snap.exported_at} (${ageDays.toFixed(2)} days old)`);

/* THE SNAPSHOT'S ROWS ARE ARRAYS, NOT OBJECTS. Reading r.dtlKey off one returns
   undefined, every filter matches nothing, and the empty result reads exactly
   like a clean answer — docs/bugs/0674 is an agent that made that mistake and
   reported the emptiness as evidence. The field order comes from
   snap.line_fields, and this asserts the fields it needs are actually there
   rather than trusting the index. */
const L = Object.fromEntries(snap.line_fields.map((n, i) => [n, i]));
for (const f of ["docNo", "dtlKey", "itemKey", "fromSoDtlKey"]) {
  if (L[f] == null) {
    console.error(`REFUSED: the snapshot's line_fields has no "${f}". Its shape has changed and every `
      + "index below would read a different column, which answers a different question silently.");
    process.exit(2);
  }
}

/* The book's purchase-order lines, and its sales-order lines by DtlKey. */
const bookPoByKey = new Map();
for (const r of snap.types.PO.lines) {
  bookPoByKey.set(String(r[L.dtlKey]), {
    docNo: r[L.docNo], itemKey: r[L.itemKey], fromSoDtlKey: String(r[L.fromSoDtlKey] ?? ""),
  });
}
const bookSoByKey = new Map();
for (const r of snap.types.SO.lines) {
  bookSoByKey.set(String(r[L.dtlKey]), { docNo: r[L.docNo], itemKey: r[L.itemKey] });
}
out(`book: ${bookPoByKey.size} purchase-order lines, ${bookSoByKey.size} sales-order lines`);

const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });

async function main() {
  /* Every company-1 purchase-order line with NO sales-order link. This is the
     population 4a calls "carry no parent link at all", and asking about only
     the rows that already HAVE a link is the false negative this probe exists
     to avoid. */
  const unlinked = await sql`
    SELECT i.id, i.item_code, i.linked_ac_dtlkey, h.po_number, h.linked_ac_docno
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders h ON h.id = i.purchase_order_id AND h.company_id = ${CO}
     WHERE i.so_item_id IS NULL AND h.status <> 'CANCELLED'`;

  /* Both ERP key indexes, built as key -> ARRAY so a duplicate is VISIBLE.
     Building a Map key -> row would silently keep one of them, which is the
     coin flip 0273/0280 describe and the reason case 3 exists. */
  const erpSoByKey = new Map();
  const soRows = await sql`
    SELECT s.id, s.item_code, s.linked_ac_dtlkey, s.doc_no
      FROM scm.mfg_sales_order_items s
      JOIN scm.mfg_sales_orders o ON o.doc_no = s.doc_no AND o.company_id = ${CO}
     WHERE s.linked_ac_dtlkey IS NOT NULL AND s.cancelled IS NOT TRUE AND o.status <> 'CANCELLED'`;
  for (const r of soRows) {
    const k = String(r.linked_ac_dtlkey);
    if (!erpSoByKey.has(k)) erpSoByKey.set(k, []);
    erpSoByKey.get(k).push(r);
  }
  const erpPoByKey = new Map();
  for (const r of unlinked) {
    if (r.linked_ac_dtlkey == null) continue;
    const k = String(r.linked_ac_dtlkey);
    if (!erpPoByKey.has(k)) erpPoByKey.set(k, []);
    erpPoByKey.get(k).push(r);
  }

  out("");
  out(`company ${CO}: ${unlinked.length} live purchase-order lines carry no sales-order link`);
  out(`         ${soRows.length} live sales-order lines carry an AutoCount line key`);
  out("");

  const c = {
    noKey: 0, noBookRow: 0, bookHasNoSource: 0,
    ambiguousPo: 0, ambiguousSo: 0, soNotImported: 0, itemMismatch: 0, recoverable: 0,
  };
  /* SUBDIVIDES c.itemMismatch and is deliberately NOT part of `c`: the assertion
     below requires c's values to PARTITION the population, and a subdivision
     living in the same object would overshoot the total by exactly the number of
     mismatches and refuse a correct run. */
  const sub = { bookAgrees: 0, bookDiffers: 0 };
  const recoverableRows = [];
  const mismatchEx = [];

  for (const r of unlinked) {
    if (r.linked_ac_dtlkey == null) { c.noKey++; continue; }
    const k = String(r.linked_ac_dtlkey);
    const bookPo = bookPoByKey.get(k);
    if (!bookPo) { c.noBookRow++; continue; }
    if (!bookPo.fromSoDtlKey) { c.bookHasNoSource++; continue; }
    /* The ERP side of the PO key must be unique too: if two ERP purchase-order
       lines share this book line, the book cannot say which of them took it. */
    if ((erpPoByKey.get(k) ?? []).length > 1) { c.ambiguousPo++; continue; }
    const bookSo = bookSoByKey.get(bookPo.fromSoDtlKey);
    if (!bookSo) { c.noBookRow++; continue; }
    const cand = erpSoByKey.get(bookPo.fromSoDtlKey) ?? [];
    if (cand.length === 0) { c.soNotImported++; continue; }
    if (cand.length > 1) { c.ambiguousSo++; continue; }
    /* THE IDENTITY GATE. A key pair is not an identity match, and skipping this
       comparison is precisely what put nine sales-order lines on the wrong bed
       (docs/bugs/0671). A repair that cannot assert the two rows are the same
       product must leave the link NULL. */
    if (norm(cand[0].item_code) !== norm(r.item_code)) {
      c.itemMismatch++;
      /* WHICH SIDE IS WRONG — the LINK or the ITEM CODE? Reporting only that the
         two ERP rows disagree leaves that open, and the two answers belong to
         different people. The book settles it: AutoCount carries its own item
         key on BOTH ends of the conversion it recorded.

           book ends AGREE, ERP ends DISAGREE  -> the LINK is right and one
             side's item_code was rewritten on import. An ERP-side defect, and
             the link would be safe to write once the code is fixed.
           book ends DISAGREE too              -> AutoCount itself converted this
             purchase-order line from a sales-order line for a different
             product, which is a real substitution the book records. The ERP is
             faithful, and the link is honest.

         Either way this probe still refuses to WRITE the link — a repair must
         not turn a question into a fact. But it stops the answer being UNKNOWN. */
      /* Kept OUT of `c`: these two SUBDIVIDE c.itemMismatch, and the assertion
         below requires `c`'s values to PARTITION the population. Adding a
         subdivision to the same object would make the total overshoot by
         exactly the number of mismatches and refuse a correct run. */
      const bookAgrees = String(bookPo.itemKey ?? "") === String(bookSo.itemKey ?? "");
      if (bookAgrees) sub.bookAgrees++; else sub.bookDiffers++;
      if (mismatchEx.length < 10) {
        mismatchEx.push(`${r.po_number} ${norm(r.item_code)} -> ${cand[0].doc_no} ${norm(cand[0].item_code)}`
          + `   [book's own two ends ${bookAgrees ? "AGREE - the ERP item_code is the suspect" : "DIFFER TOO - a real substitution, the ERP is faithful"}]`);
      }
      continue;
    }
    c.recoverable++;
    recoverableRows.push({ po: r.po_number, acPo: bookPo.docNo, acSo: bookSo.docNo, so: cand[0].doc_no, code: norm(r.item_code) });
  }

  out("WHY EACH UNLINKED LINE IS NOT LINKED");
  out(`  no AutoCount line key on the ERP row      ${String(c.noKey).padStart(5)}  (an ERP-native line; the book never had it)`);
  out(`  key names no line in the book             ${String(c.noBookRow).padStart(5)}`);
  out(`  the BOOK records no source order          ${String(c.bookHasNoSource).padStart(5)}  (AutoCount says this PO came from no SO - a link here would be INVENTED)`);
  out(`  the purchase-order key is not unique      ${String(c.ambiguousPo).padStart(5)}  (0273/0280 - refused, not guessed)`);
  out(`  the sales-order key is not unique         ${String(c.ambiguousSo).padStart(5)}  (0273/0280 - refused, not guessed)`);
  out(`  the source order was not imported         ${String(c.soNotImported).padStart(5)}  (outside the cutover scope)`);
  out(`  the two ends name DIFFERENT products      ${String(c.itemMismatch).padStart(5)}  (bug class 0672 - refused)`);
  out(`  RECOVERABLE - all four gates passed       ${String(c.recoverable).padStart(5)}`);
  const accounted = Object.values(c).reduce((a, b) => a + b, 0);
  /* The classes must partition the population exactly. A probe whose buckets do
     not add up to its denominator has a path it is not reporting, and the
     missing rows would be invisible rather than merely uncounted. */
  if (accounted !== unlinked.length) {
    console.error(`REFUSED: the classes total ${accounted} but the population is ${unlinked.length}. `
      + "Some rows fall through a path this probe does not report, so its answer cannot be trusted.");
    await sql.end({ timeout: 5 });
    process.exit(2);
  }
  out(`  (the classes total ${accounted}, which is the whole population - no row falls through unreported)`);

  if (c.itemMismatch) {
    out("");
    out(`  OF THE ${c.itemMismatch} ITEM DISAGREEMENTS, WHICH SIDE IS WRONG?`);
    out(`    ${sub.bookAgrees} where the BOOK's own two ends AGREE - AutoCount converted a product into itself,`);
    out("        so an item_code was rewritten on import. The LINK is right; the defect is ERP-side.");
    out(`    ${sub.bookDiffers} where the BOOK's two ends DIFFER too - a substitution AutoCount itself recorded.`);
    out("        The ERP is faithful and the link is honest; it is simply not a same-product pair.");
    out("    NEITHER is written here. A repair must not turn a question into a fact.");
  }
  if (mismatchEx.length) {
    out("");
    out("  the key pairs whose two ends name different products (would have been wrong links):");
    for (const m of mismatchEx) out(`    ${m}`);
  }

  out("");
  out("THE RECOVERABLE ROWS, grouped by the document edge they would restore");
  const byEdge = new Map();
  for (const r of recoverableRows) {
    const k = `${r.acPo} <- ${r.acSo}`;
    byEdge.set(k, (byEdge.get(k) ?? 0) + 1);
  }
  for (const [k, n] of [...byEdge].sort()) out(`  ${k}  ${n} line(s)`);
  out(`  ${byEdge.size} document edge(s), ${recoverableRows.length} line(s)`);

  log(`RECOVERABLE: ${c.recoverable} of ${unlinked.length} unlinked purchase-order lines, restoring `
    + `${byEdge.size} document edge(s). Refused as unprovable: ${c.ambiguousPo + c.ambiguousSo} ambiguous key, `
    + `${c.itemMismatch} different product, ${c.bookHasNoSource} no source in the book.`);
  await sql.end({ timeout: 5 });
}

main().catch(async (e) => {
  console.error(e);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
