#!/usr/bin/env node
// ----------------------------------------------------------------------------
// WRITE THE SALES-ORDER LINK THE ACCOUNT BOOK ALREADY RECORDS, ON THE ONE EDGE
// WHERE THE BOOK RECORDS IT AT LINE GRAIN. Nothing else.
//
// WHY THIS EXISTS. check-ac-convert-symmetry's `not linked` column stood at 765
// ERP lines with no cause attached until section 6b split it (PR for
// docs/bugs/0691). 740 of those are the absence being CORRECT. 13 are not:
// PODTL.FromSODtlKey names a sales-order LINE, that line is in the ERP exactly
// once, and scm.purchase_order_items.so_item_id is still NULL. Those 13 are the
// only rows in the whole column the book can settle without a guess.
//
// IT IS NOT COSMETIC. `isHardBoundLine` (src/scm/lib/so-stock-allocation.ts):
// a company-1 bedframe / sofa / (SP) mattress sales line reads READY ONLY
// through its own dedicated purchase-order line, and never through the pooled
// walk. NINE of the 13 are bedframes on live orders, so nine customers' orders
// cannot light up while the link is missing, whatever is standing in the
// warehouse.
//
// EVERY GATE IS THE BOOK'S OWN WORD, NEVER AN INFERENCE:
//
//   1  THE BOOK NAMES THE SOURCE LINE. PODTL.FromSODtlKey, populated on 10,792
//      of 18,890 purchase-order lines. This is the ONE edge with a line key;
//      FromDocDtlKey is NULL on all ~220,000 rows of all six detail tables, so
//      no other edge could be repaired this way and this script refuses to try.
//   2  BOTH KEYS ARE UNIQUE IN THE ERP. 296 sales-order and 98 purchase-order
//      DtlKeys are carried by more than one ERP row (a sofa is one book line
//      and one ERP row per COMPARTMENT). Where either end resolves to several
//      rows the book cannot say which took the goods, and picking one is a coin
//      flip. Refused, and counted.
//   3  THE TWO ENDS NAME THE SAME PRODUCT. The bug class this repo paid for on
//      2026-09-07: a link written on a key pair without comparing item_code put
//      nine sales-order lines on a purchase-order line for a different bed, and
//      a customer's REGAL read READY when a TRION arrived (docs/bugs/0671,
//      class 0672). A key match is NOT an identity match.
//   4  THE TARGET IS STILL NULL. Written with `so_item_id IS NULL` in the
//      UPDATE's own predicate, so a link somebody made in the ERP - or another
//      session's repair - is never overwritten. That also makes this safe to
//      run beside the other PO/SO repair lanes.
//
// migration-copy-never-compute. Nothing here derives a link from item codes,
// quantities or line order; the book states the pair or the row is refused.
//
// CREATING A LINK MOVES READINESS, AND THIS SCRIPT DOES NOT RECOMPUTE IT.
// docs/bugs/0675: a direct SQL write does not trigger the allocation recompute.
// The apply path prints the READY / PENDING / PARTIAL counts before and after
// its own write so the delta is on the record, and then tells you to dispatch
// "Recompute SO stock allocation". It deliberately does not call the recompute
// itself - that is a separate, serialised, owner-visible operation.
//
//   MODE=plan (default)  read, classify, print every candidate, write NOTHING.
//   MODE=apply           needs CONFIRM="I HAVE REVIEWED THE DRY-RUN". Writes
//                        every provable row in ONE transaction, then re-reads on
//                        a FRESH connection and asserts the SHAPE - each written
//                        row's purchase item_code against the item_code of the
//                        sales line it now names - not a row count.
//
//   DATABASE_URL           required
//   COMPANY_ID             default 1 (AED_HOUZS)
//   MAX_SNAPSHOT_AGE_DAYS  default 2 - refuses rather than write from a stale book
//
// RE-RUN: idempotent. A second run finds the rows already linked, plans zero
// writes and reports zero. It can never re-point an existing link, because the
// UPDATE only ever matches a row whose so_item_id is still NULL.
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
const APPLY = (process.env.MODE || "plan").toLowerCase() === "apply";
const CONFIRM_PHRASE = "I HAVE REVIEWED THE DRY-RUN";
const here = path.dirname(fileURLToPath(import.meta.url));
const SNAP = path.join(here, "data", "ac-convert-edges.json.gz");

const log = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const out = (m = "") => console.log(m);

/* Item codes compared the way a human reads them - trimmed, upper-cased, inner
   whitespace collapsed. The same normaliser probe-po-so-link-recoverable uses,
   deliberately, so the probe and the repair cannot disagree about what "the
   same product" means. */
const norm = (s) => (s ?? "").trim().toUpperCase().replace(/\s+/g, " ");

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`REFUSED: MODE=apply needs CONFIRM="${CONFIRM_PHRASE}". `
    + "Run the plan first and read every row it prints; this write moves which sales orders can reach READY.");
  process.exit(2);
}

if (!fs.existsSync(SNAP)) {
  console.error(`REFUSED: ${SNAP} is not present. The link this writes is the BOOK's assertion, `
    + "and without the book there is nothing to copy.");
  process.exit(2);
}
const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(SNAP)).toString("utf8"));
const ageDays = (Date.now() - new Date(snap.exported_at).getTime()) / 86400000;
if (!(ageDays <= MAX_AGE_DAYS)) {
  console.error(`REFUSED: the AutoCount snapshot is ${ageDays.toFixed(2)} days old (limit ${MAX_AGE_DAYS}). `
    + "Writing a dedication from a stale book would name rows that have since been converted.");
  process.exit(2);
}
out(`mode=${APPLY ? "APPLY" : "PLAN"}  company=${CO}  snapshot exported_at=${snap.exported_at} (${ageDays.toFixed(2)} days old)`);

/* THE SNAPSHOT'S ROWS ARE ARRAYS, NOT OBJECTS. Reading r.dtlKey off one returns
   undefined, every filter matches nothing, and the empty result reads exactly
   like "there is nothing to repair" - docs/bugs/0674. Assert the fields are
   where the index says rather than trusting the order. */
const L = Object.fromEntries(snap.line_fields.map((n, i) => [n, i]));
for (const f of ["docNo", "dtlKey", "itemKey", "fromSoDtlKey"]) {
  if (L[f] == null) {
    console.error(`REFUSED: the snapshot's line_fields has no "${f}". Its shape has changed and every `
      + "index below would read a different column, which would write links from the wrong values.");
    process.exit(2);
  }
}

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
const bail = async (msg) => {
  console.error(`REFUSED: ${msg}`);
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(2);
};

async function readAllocationCounts(client) {
  const r = await client`
    SELECT count(*) FILTER (WHERE i.stock_status = 'READY')::int   AS ready,
           count(*) FILTER (WHERE i.stock_status = 'PENDING')::int AS pending,
           count(*) FILTER (WHERE i.stock_status = 'PARTIAL')::int AS partial
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no AND h.company_id = ${CO}`;
  return r[0];
}

async function main() {
  /* THE WHOLE UNLINKED POPULATION, not the rows that already carry a link. A
     query that inspects only linked rows cannot find the NULL ones, and that is
     the population this script exists to change. */
  const unlinked = await sql`
    SELECT i.id, i.item_code, i.item_group, i.linked_ac_dtlkey, h.po_number, h.status
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders h ON h.id = i.purchase_order_id AND h.company_id = ${CO}
     WHERE i.so_item_id IS NULL AND h.status <> 'CANCELLED'`;

  /* Both key indexes as key -> ARRAY, so a duplicate is VISIBLE. A Map of
     key -> row silently keeps one of them, which is gate 2's coin flip. */
  const erpSoByKey = new Map();
  for (const r of await sql`
    SELECT s.id, s.item_code, s.linked_ac_dtlkey, s.doc_no
      FROM scm.mfg_sales_order_items s
      JOIN scm.mfg_sales_orders o ON o.doc_no = s.doc_no AND o.company_id = ${CO}
     WHERE s.linked_ac_dtlkey IS NOT NULL AND s.cancelled IS NOT TRUE AND o.status <> 'CANCELLED'`) {
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

  const refused = { noKey: 0, noBookRow: 0, bookHasNoSource: 0, ambiguousPo: 0, ambiguousSo: 0, soNotImported: 0, itemMismatch: 0 };
  const plan = [];
  for (const r of unlinked) {
    if (r.linked_ac_dtlkey == null) { refused.noKey++; continue; }
    const k = String(r.linked_ac_dtlkey);
    const bookPo = bookPoByKey.get(k);
    if (!bookPo) { refused.noBookRow++; continue; }
    if (!bookPo.fromSoDtlKey) { refused.bookHasNoSource++; continue; }
    if ((erpPoByKey.get(k) ?? []).length > 1) { refused.ambiguousPo++; continue; }
    const bookSo = bookSoByKey.get(bookPo.fromSoDtlKey);
    if (!bookSo) { refused.noBookRow++; continue; }
    const cand = erpSoByKey.get(bookPo.fromSoDtlKey) ?? [];
    if (cand.length === 0) { refused.soNotImported++; continue; }
    if (cand.length > 1) { refused.ambiguousSo++; continue; }
    if (norm(cand[0].item_code) !== norm(r.item_code)) { refused.itemMismatch++; continue; }
    plan.push({
      poItemId: r.id,
      soItemId: cand[0].id,
      poNumber: r.po_number,
      soDocNo: cand[0].doc_no,
      code: norm(r.item_code),
      group: r.item_group,
      acPo: bookPo.docNo,
      acSo: bookSo.docNo,
      soDtlKey: bookPo.fromSoDtlKey,
    });
  }

  out("");
  out(`${unlinked.length} live company-${CO} purchase-order line(s) carry no sales-order link`);
  out("REFUSED, each for a reason the book gives:");
  out(`  no AutoCount line key on the ERP row      ${String(refused.noKey).padStart(5)}`);
  out(`  key names no line in the book             ${String(refused.noBookRow).padStart(5)}`);
  out(`  the BOOK records no source order          ${String(refused.bookHasNoSource).padStart(5)}  (a link here would be INVENTED)`);
  out(`  the purchase-order key is not unique      ${String(refused.ambiguousPo).padStart(5)}  (gate 2 - refused, not guessed)`);
  out(`  the sales-order key is not unique         ${String(refused.ambiguousSo).padStart(5)}  (gate 2 - refused, not guessed)`);
  out(`  the source order was not imported         ${String(refused.soNotImported).padStart(5)}`);
  out(`  the two ends name DIFFERENT products      ${String(refused.itemMismatch).padStart(5)}  (gate 3 - class 0672)`);
  out(`  PROVABLE - all four gates passed          ${String(plan.length).padStart(5)}`);
  const accounted = Object.values(refused).reduce((a, b) => a + b, 0) + plan.length;
  if (accounted !== unlinked.length) {
    await bail(`the buckets total ${accounted} but the population is ${unlinked.length}. Some rows fall `
      + "through a path this script does not report, so what it would write cannot be trusted.");
  }
  out(`  (the buckets total ${accounted}, which is the whole population - no row falls through unreported)`);

  out("");
  out("THE PROVABLE ROWS - each one the book's own assertion, copied:");
  for (const p of plan) {
    out(`  ${p.poNumber.padEnd(14)} ${p.code.padEnd(24)} ${String(p.group ?? "").padEnd(10)} -> ${p.soDocNo}`
      + `   [book ${p.acPo} <- ${p.acSo}, SO line ${p.soDtlKey}]`);
  }
  const bound = plan.filter((p) => ["bedframe", "sofa"].includes(String(p.group ?? "").toLowerCase())
    || (String(p.group ?? "").toLowerCase() === "mattress" && /\(SP\)\s*$/i.test(p.code)));
  out(`  ${plan.length} row(s), ${bound.length} of them HARD-BOUND - those sales lines cannot reach READY until the link exists`);

  if (!APPLY) {
    log(`PLAN: ${plan.length} purchase-order line(s) would be linked (${bound.length} hard-bound). Nothing was written. `
      + `Re-run with MODE=apply and CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }
  if (plan.length === 0) {
    log("APPLY: nothing to write - every provable link is already in place. This is the idempotent re-run.");
    await sql.end({ timeout: 5 });
    return;
  }

  const before = await readAllocationCounts(sql);
  out("");
  out(`allocation BEFORE the write: READY ${before.ready} | PENDING ${before.pending} | PARTIAL ${before.partial}`);

  /* ONE TRANSACTION, each row guarded on the state it was planned from. The
     `so_item_id IS NULL` predicate is what makes a concurrent repair safe: a row
     another lane linked first simply does not match, and the count says so. */
  let written = 0;
  await sql.begin(async (tx) => {
    for (const p of plan) {
      const r = await tx`
        UPDATE scm.purchase_order_items
           SET so_item_id = ${p.soItemId}
         WHERE id = ${p.poItemId} AND so_item_id IS NULL
        RETURNING id`;
      written += r.length;
    }
  });
  out(`wrote ${written} of ${plan.length} planned link(s)`
    + (written === plan.length ? "" : " - the shortfall is rows another lane linked between the plan and the write"));

  /* FRESH CONNECTION, and the SHAPE - not a row count. A count of 13 is equally
     true of 13 links written onto the WRONG sales lines, which is exactly the
     failure this script's gate 3 exists to prevent, so the verification asserts
     the pairing itself: every written row's purchase item_code against the
     item_code of the sales line it now names. */
  const verify = postgres(url, { ssl: "require", prepare: false, max: 1 });
  try {
    const rows = await verify`
      SELECT p.id::text AS id, p.item_code AS po_code, s.item_code AS so_code, s.doc_no
        FROM scm.purchase_order_items p
        LEFT JOIN scm.mfg_sales_order_items s ON s.id = p.so_item_id
       WHERE p.id = ANY(${plan.map((p) => p.poItemId)})`;
    const byId = new Map(rows.map((r) => [r.id, r]));
    const bad = [];
    for (const p of plan) {
      const got = byId.get(String(p.poItemId));
      if (!got) { bad.push(`${p.poNumber} ${p.code}: the row is gone`); continue; }
      if (got.doc_no == null) { bad.push(`${p.poNumber} ${p.code}: still carries no sales-order link`); continue; }
      if (norm(got.po_code) !== norm(got.so_code)) {
        bad.push(`${p.poNumber} ${norm(got.po_code)} now names ${got.doc_no} ${norm(got.so_code)} - DIFFERENT product`);
      }
    }
    out("");
    out(`verification on a FRESH connection: ${rows.length} row(s) re-read, ${bad.length} wrong shape`);
    for (const b of bad) out(`  ${b}`);
    if (bad.length) {
      console.error("REFUSED: the write did not produce the shape it planned. Every row above needs a human.");
      await verify.end({ timeout: 5 });
      await sql.end({ timeout: 5 });
      process.exit(2);
    }
    const after = await readAllocationCounts(verify);
    out("");
    out(`allocation AFTER the write:  READY ${after.ready} | PENDING ${after.pending} | PARTIAL ${after.partial}`);
    out("  A DIRECT SQL WRITE DOES NOT RECOMPUTE THE ALLOCATION (docs/bugs/0675), so these two lines are");
    out("  expected to be IDENTICAL. They are printed so the delta is on the record either way.");
    out("  Dispatch Actions -> Recompute SO stock allocation to project the new links.");
    log(`APPLIED: ${written} purchase-order line(s) now name the sales line the book records, `
      + `${bound.length} of them hard-bound. Verified on a fresh connection: every pair names the same product. `
      + `Allocation unchanged by this write (READY ${before.ready} -> ${after.ready}); run the recompute next.`);
    await verify.end({ timeout: 5 });
  } catch (e) {
    await verify.end({ timeout: 5 }).catch(() => {});
    throw e;
  }
  await sql.end({ timeout: 5 });
}

main().catch(async (e) => {
  console.error(e);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
