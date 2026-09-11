#!/usr/bin/env node
// ----------------------------------------------------------------------------
// WRITE THE SALES-ORDER LINK THE BOOK RECORDS, ON THE ONE SHAPE
// repair-po-so-link-from-book.mjs HAS TO REFUSE: A SOFA.
//
// WHY THIS EXISTS AND IS NOT A LOOSENING OF THAT SCRIPT. `PODTL.FromSODtlKey`
// names a sales-order LINE, and repair-po-so-link-from-book.mjs copies that
// edge - but its gate 2 refuses whenever either key resolves to more than ONE
// ERP row, because a Map keyed by DtlKey would keep one of them and the pairing
// would be a coin flip. EVERY SOFA IS IN THAT BUCKET BY CONSTRUCTION: one book
// line becomes one ERP row per compartment. So the whole sofa population is
// unrepairable by that tool, by design, and the refusal is correct at the grain
// it works at.
//
// This asks the narrower question, at COMPARTMENT grain: inside ONE pair of book
// lines, does every item code appear exactly once on each side? Where it does,
// the pairing is not a choice at all - each purchase compartment has exactly one
// sales compartment of the same product to be, and writing it is the book's own
// edge plus an exact identity match. Where it does not, it stays refused.
//
// IT IS NOT COSMETIC. `isHardBoundLine` (src/scm/lib/so-stock-allocation.ts): a
// company-1 bedframe / sofa / (SP) mattress sales line reads READY ONLY through
// its own dedicated purchase-order line. A sofa piece whose real purchase order
// is not linked can never light up whatever arrives, and MRP will ask purchasing
// to raise a SECOND purchase order for goods already on the way. Measured on
// production 2026-09-08 (probe run 34202130553): 7 such lines on 4 orders, all
// 7 PENDING.
//
// FIVE GATES, EVERY ONE A REFUSAL RATHER THAN A FALLBACK:
//
//   1  THE BOOK NAMES THE SOURCE LINE. `PODTL.FromSODtlKey`. This is the ONE
//      edge the book keys at line grain; no other edge could be repaired this
//      way and this script refuses to try.
//   2  BOTH ENDS RESOLVE. The book's purchase line and its named sales line are
//      both in the ERP, and the sales order is not cancelled.
//   3  EVERY ITEM CODE IS UNIQUE ON BOTH SIDES OF THE PAIR. Two rows of the same
//      compartment on one side is the coin flip gate 2 of the other script
//      exists to refuse, and it stays refused here.
//   4  THE TWO SIDES CARRY THE SAME SET OF PRODUCTS, and the same NUMBER of
//      rows. A purchase side holding a compartment the sales side does not is
//      not a link problem - it is a build disagreement, and it needs the
//      drawing, not a script. (Live example: HC-PO-010085 carries
//      9058-1A(LHF)+2A(RHF) where HC-SO-010287 carries 9058-2A(LHF)+1A(RHF) -
//      the same sofa MIRRORED. Which side is right is the owner's.)
//   5  THE TARGET IS STILL NULL. Written into the UPDATE's own predicate, so a
//      link somebody made in the ERP - or another lane's repair - is never
//      overwritten, and this is safe to run beside them.
//
// migration-copy-never-compute. Nothing here derives a link from quantities or
// line order; the book states the pair, the item codes state which row is which,
// or the row is refused.
//
// CREATING A LINK MOVES READINESS, AND THIS SCRIPT DOES NOT RECOMPUTE IT
// (docs/bugs/0675: a direct SQL write does not trigger the allocation
// recompute). It prints the READY / PENDING / PARTIAL counts either side of its
// own write so the delta is on the record, and then tells you to dispatch
// "Recompute SO stock allocation". Doing the recompute here would fold a
// separate, serialised, owner-visible operation into a repair.
//
// IT ENQUEUES NOTHING. No outbox row, no AutoCount call. Owner 2026-09-08:
// 「写回autocount的你不需要理了」.
//
//   MODE=plan (default)  read, classify, print every candidate, write NOTHING.
//   MODE=apply           needs CONFIRM="I HAVE REVIEWED THE DRY-RUN". Writes
//                        every provable row in ONE transaction, then re-reads on
//                        a FRESH connection and asserts the SHAPE - each written
//                        row's purchase item_code against the item_code of the
//                        sales line it now names, and that no sales line ended up
//                        named by two purchase rows - not a row count.
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

import { judgeCompartmentPair, normCode } from "./lib/sofa-po-so-pair.mjs";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL required"); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const MAX_AGE_DAYS = Number(process.env.MAX_SNAPSHOT_AGE_DAYS || 2);
const APPLY = (process.env.MODE || "plan").toLowerCase() === "apply";
const CONFIRM_PHRASE = "I HAVE REVIEWED THE DRY-RUN";
const here = path.dirname(fileURLToPath(import.meta.url));

const out = (m = "") => console.log(m);
const log = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

/* ONE normaliser and ONE pairing rule, shared with the probe through
   lib/sofa-po-so-pair.mjs. They were two copies for twenty minutes on
   2026-09-08 and disagreed on production about HC-PO-010040 <- SO-012277; that
   module's header records which reading is right and why. */
const norm = normCode;

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`REFUSED: MODE=apply needs CONFIRM="${CONFIRM_PHRASE}". `
    + "Run the plan first and read every row it prints; this write moves which sales orders can reach READY.");
  process.exit(2);
}

const SNAP = path.join(here, "data", "ac-reconcile-truth.json.gz");
if (!fs.existsSync(SNAP)) {
  console.error(`REFUSED: ${SNAP} is not present. The link this writes is the BOOK's assertion, and without the book there is nothing to copy.`);
  process.exit(2);
}
const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(SNAP)).toString("utf8"));
const ageDays = (Date.now() - new Date(snap.exported_at).getTime()) / 86400000;
if (!(ageDays <= MAX_AGE_DAYS)) {
  console.error(`REFUSED: the AutoCount snapshot is ${ageDays.toFixed(2)} days old (limit ${MAX_AGE_DAYS}). `
    + "Writing a dedication from a stale book would name rows that have since been converted.");
  process.exit(2);
}

/* THE SNAPSHOT'S ROWS ARE ARRAYS, NOT OBJECTS (docs/bugs/0674) - reading
   r.dtlKey off one returns undefined and the empty result reads exactly like
   "there is nothing to repair". Assert the field positions. */
const L = Object.fromEntries(snap.line_fields.map((n, i) => [n, i]));
for (const f of ["docNo", "dtlKey", "itemKey", "fromSoDtlKey"]) {
  if (L[f] == null) { console.error(`REFUSED: the snapshot's line_fields has no "${f}".`); process.exit(2); }
}
const H = Object.fromEntries(snap.header_fields.map((n, i) => [n, i]));
const poCancelled = new Map(snap.types.PO.headers.map((r) => [String(r[H.docNo]), String(r[H.cancelled]) === "T"]));

const bookPoByKey = new Map();
for (const r of snap.types.PO.lines) {
  bookPoByKey.set(String(r[L.dtlKey]), {
    docNo: String(r[L.docNo]), itemKey: String(r[L.itemKey] ?? ""),
    fromSoDtlKey: String(r[L.fromSoDtlKey] ?? ""),
    cancelled: poCancelled.get(String(r[L.docNo])) === true,
  });
}
const bookSoByKey = new Map(snap.types.SO.lines.map((r) => [String(r[L.dtlKey]), { docNo: String(r[L.docNo]) }]));

const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });

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
  out(`mode=${APPLY ? "APPLY" : "PLAN"}  company=${CO}  snapshot exported_at=${snap.exported_at} (${ageDays.toFixed(2)} days old)`);
  out(`book: ${bookPoByKey.size} purchase-order lines, ${bookSoByKey.size} sales-order lines`);

  const unlinked = await sql`
    SELECT i.id::text AS id, i.item_code, i.item_group, i.linked_ac_dtlkey::text AS dtl, h.po_number
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders h ON h.id = i.purchase_order_id AND h.company_id = ${CO}
     WHERE i.so_item_id IS NULL AND UPPER(COALESCE(h.status::text, '')) <> 'CANCELLED'`;
  /* The ERP purchase rows of a book line INCLUDING the ones already linked: a
     compartment somebody linked by hand still occupies its sales row, and
     planning without it would try to give that row a second purchase line. */
  const erpPoByKey = new Map();
  for (const r of await sql`
    SELECT i.id::text AS id, i.item_code, i.linked_ac_dtlkey::text AS dtl, i.so_item_id::text AS so_item_id, h.po_number
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders h ON h.id = i.purchase_order_id AND h.company_id = ${CO}
     WHERE i.linked_ac_dtlkey IS NOT NULL AND UPPER(COALESCE(h.status::text, '')) <> 'CANCELLED'`) {
    if (!erpPoByKey.has(r.dtl)) erpPoByKey.set(r.dtl, []);
    erpPoByKey.get(r.dtl).push(r);
  }
  const erpSoByKey = new Map();
  for (const r of await sql`
    SELECT s.id::text AS id, s.item_code, s.linked_ac_dtlkey::text AS dtl, s.doc_no, s.stock_status,
           UPPER(COALESCE(o.status::text, '')) AS so_status
      FROM scm.mfg_sales_order_items s
      JOIN scm.mfg_sales_orders o ON o.doc_no = s.doc_no AND o.company_id = ${CO}
     WHERE s.company_id = ${CO} AND s.linked_ac_dtlkey IS NOT NULL AND s.cancelled IS NOT TRUE
       AND UPPER(COALESCE(o.status::text, '')) <> 'CANCELLED'`) {
    if (!erpSoByKey.has(r.dtl)) erpSoByKey.set(r.dtl, []);
    erpSoByKey.get(r.dtl).push(r);
  }

  const refused = { noKey: 0, noBookRow: 0, bookHasNoSource: 0, bookPoCancelled: 0, soNotImported: 0,
    singleRowPair: 0, duplicateCode: 0, differentProducts: 0, countsDiffer: 0, alreadyTaken: 0 };
  const refusedDetail = [];
  const plan = [];
  const judged = new Set();

  for (const r of unlinked) {
    if (!r.dtl) { refused.noKey++; continue; }
    const bp = bookPoByKey.get(r.dtl);
    if (!bp) { refused.noBookRow++; continue; }
    if (bp.cancelled) { refused.bookPoCancelled++; continue; }
    if (!bp.fromSoDtlKey) { refused.bookHasNoSource++; continue; }
    if (!bookSoByKey.has(bp.fromSoDtlKey)) { refused.noBookRow++; continue; }
    const soRows = erpSoByKey.get(bp.fromSoDtlKey) ?? [];
    if (!soRows.length) { refused.soNotImported++; continue; }
    const poRows = erpPoByKey.get(r.dtl) ?? [];
    /* The 1:1 shape belongs to repair-po-so-link-from-book.mjs. Two tools
       writing the same row is how a repair becomes a race; this one takes only
       what that one refuses. */
    if (poRows.length === 1 && soRows.length === 1) { refused.singleRowPair++; continue; }

    const pairId = `${r.dtl}|${bp.fromSoDtlKey}`;
    const first = !judged.has(pairId);
    judged.add(pairId);
    const note = (msg) => { if (first) refusedDetail.push(msg); };
    const acSo = bookSoByKey.get(bp.fromSoDtlKey).docNo;

    /* ONE pairing rule, shared with probe-staff-reported-flow.mjs. It takes
       EVERY purchase row carrying the key, LINKED ROWS INCLUDED - a compartment
       somebody already dedicated still occupies its sales row, and leaving it
       out both under-counts the purchase side and hides the collision gate 5
       exists to catch. That is not a preference: the two tools held separate
       copies for twenty minutes on 2026-09-08 and disagreed on production about
       this very pair. lib/sofa-po-so-pair.mjs has the trace and the test. */
    const j = judgeCompartmentPair(poRows, soRows);
    if (j.verdict !== "provable") {
      refused[j.verdict]++;
      note(`${r.po_number} <- ${acSo}: ${j.why}`);
      continue;
    }
    const target = j.pairs.find((x) => x.po.id === r.id)?.so;
    if (!target) { refused.differentProducts++; note(`${r.po_number} ${norm(r.item_code)}: no sales compartment of that product`); continue; }
    /* A sales compartment another purchase row already holds is taken. Gate 3
       makes this unreachable on a clean pair; it is asserted rather than
       assumed because "unreachable" is what every double-write believed. */
    const taken = poRows.some((p) => p.so_item_id === target.id);
    if (taken || plan.some((p) => p.soItemId === target.id)) {
      refused.alreadyTaken++;
      note(`${r.po_number} ${norm(r.item_code)}: ${target.doc_no}'s matching compartment is already dedicated`);
      continue;
    }
    plan.push({ poItemId: r.id, soItemId: target.id, poNumber: r.po_number, soDocNo: target.doc_no,
      code: norm(r.item_code), group: r.item_group, stockStatus: target.stock_status,
      soStatus: target.so_status, acPo: bp.docNo, acSo, soDtlKey: bp.fromSoDtlKey });
  }

  out("");
  out(`${unlinked.length} live company-${CO} purchase-order line(s) carry no sales-order link`);
  out("REFUSED, each for a reason the book or the pair gives:");
  out(`  no AutoCount line key on the ERP row            ${String(refused.noKey).padStart(5)}`);
  out(`  the key names no line in the book               ${String(refused.noBookRow).padStart(5)}`);
  out(`  the book's purchase order is CANCELLED          ${String(refused.bookPoCancelled).padStart(5)}`);
  out(`  the BOOK records no source order                ${String(refused.bookHasNoSource).padStart(5)}  a link here would be INVENTED`);
  out(`  the source order was not imported               ${String(refused.soNotImported).padStart(5)}`);
  out(`  a 1:1 pair - the other repair's job, not this   ${String(refused.singleRowPair).padStart(5)}`);
  out(`  a compartment code appears twice on one side    ${String(refused.duplicateCode).padStart(5)}  (gate 3)`);
  out(`  the two sides carry DIFFERENT products          ${String(refused.differentProducts).padStart(5)}  (gate 4 - needs the drawing)`);
  out(`  the two sides hold a different NUMBER of rows   ${String(refused.countsDiffer).padStart(5)}  (gate 4)`);
  out(`  the matching sales compartment is already taken ${String(refused.alreadyTaken).padStart(5)}  (gate 5)`);
  out(`  PROVABLE - every gate passed                    ${String(plan.length).padStart(5)}`);
  const accounted = Object.values(refused).reduce((a, b) => a + b, 0) + plan.length;
  if (accounted !== unlinked.length) {
    console.error(`REFUSED: the buckets total ${accounted} but the population is ${unlinked.length}. Some row falls `
      + "through a path this script does not report, so what it would write cannot be trusted.");
    await sql.end({ timeout: 5 });
    process.exit(2);
  }
  out(`  (the buckets total ${accounted}, which is the whole population - no row falls through unreported)`);

  out("");
  out("THE PROVABLE ROWS - the book's own edge, with the compartment code saying which row is which:");
  for (const p of plan) {
    out(`  ${p.poNumber.padEnd(14)} ${p.code.padEnd(24)} ${String(p.group ?? "").padEnd(9)} -> ${p.soDocNo}`
      + `  [SO ${p.soStatus}, line ${p.stockStatus}]   book ${p.acPo} <- ${p.acSo}, SO line ${p.soDtlKey}`);
  }
  if (refusedDetail.length) {
    out("");
    out("THE MULTI-ROW PAIRS THAT STAY REFUSED, one line each:");
    for (const d of refusedDetail) out(`  ${d}`);
  }

  if (!APPLY) {
    log(`PLAN: ${plan.length} purchase-order line(s) would be linked at compartment grain. Nothing was written. `
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

  let written = 0;
  await sql.begin(async (tx) => {
    for (const p of plan) {
      const r = await tx`UPDATE scm.purchase_order_items SET so_item_id = ${p.soItemId}
                          WHERE id = ${p.poItemId} AND so_item_id IS NULL RETURNING id`;
      written += r.length;
    }
  });
  out(`wrote ${written} of ${plan.length} planned link(s)`
    + (written === plan.length ? "" : " - the shortfall is rows another lane linked between the plan and the write"));

  /* FRESH CONNECTION, and the SHAPE. A count of N is equally true of N links
     written onto the WRONG sales compartments - the failure gate 4 exists to
     prevent - so this asserts the pairing itself, and additionally that no
     sales compartment ended up named by TWO purchase rows, which is the failure
     mode compartment-grain pairing could produce and 1:1 pairing could not. */
  const verify = postgres(url, { ssl: "require", prepare: false, max: 1 });
  try {
    const rows = await verify`
      SELECT p.id::text AS id, p.item_code AS po_code, p.so_item_id::text AS so_item_id,
             s.item_code AS so_code, s.doc_no
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
    const dupes = await verify`
      SELECT so_item_id::text AS so_item_id, count(*)::int AS n
        FROM scm.purchase_order_items
       WHERE so_item_id = ANY(${plan.map((p) => p.soItemId)})
       GROUP BY so_item_id HAVING count(*) > 1`;
    for (const d of dupes) bad.push(`sales line ${d.so_item_id} is now named by ${d.n} purchase rows`);

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
    log(`APPLIED: ${written} sofa purchase line(s) now name the sales compartment the book records. `
      + `Verified on a fresh connection: every pair names the same product and no sales line is named twice. `
      + `Allocation unchanged by this write (READY ${before.ready} -> ${after.ready}); run the recompute next. `
      + "No outbox row was written and no AutoCount call was made.");
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
