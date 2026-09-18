#!/usr/bin/env node
/* AutoCount's SALES-ORDER line DISCOUNT, copied into the ERP.
 *
 * WHAT IS WRONG. AutoCount stores `SODTL.UnitPrice` and `SODTL.SubTotal` as two
 * columns and the discount lives in the gap between them. Every sales-order
 * importer here computes the line amount out of the undiscounted half, so a
 * migrated sales order OVERSTATES what the customer owes. The purchase side of
 * exactly this is docs/bugs/0662 and `repair-po-line-discount.mjs`.
 *
 * Measured on the 2026-09-08 08:03 (Malaysia) cut, probe run 34186980493:
 * `HC-SO-000021` holds RM 10,852.00 against the book's RM 9,876.00, and the
 * RM 976.00 is three line discounts (RM 199.00 + RM 598.00 + RM 179.00). It was
 * the only sales-order money difference on the go-live reconcile that is not a
 * missing or an extra LINE.
 *
 * THE POPULATION IS WHAT THE ERP HOLDS. `buildScope(book).SO` is the
 * OUTSTANDING orders; the ERP holds 2,882 migrated sales orders against a scope
 * of 2,789, and a document that has been delivered since it was imported keeps
 * its wrong money forever if a repair walks the scope. See
 * `repairPopulation` in lib/po-discount-plan.mjs and docs/bugs/0694-*.md.
 *
 * WHAT IT WRITES, AND WHY NOT JUST THE LINE AMOUNT. `mfg-sales-orders.ts:4251`
 * is `lineTotal = senOrZero((qty * unit) - discount)`, written to `total_sen`,
 * `total_inc_sen` and `balance_sen`. A line amount corrected without the
 * discount beside it is SELF-ERASING — the next edit through the UI recomputes
 * it from a discount of zero. So the four line columns move together, and the
 * header's `local_total_sen` plus its five category buckets are re-summed from
 * the lines, which is what those columns are DEFINED as
 * (repair-so-price-from-autocount.mjs:190).
 *
 * WHAT IT NEVER TOUCHES:
 *   `unit_price_sen`  — AutoCount's own UnitPrice is the undiscounted figure.
 *   the header's `paid_sen` / `balance_sen` — what a customer paid is a fact
 *     about the business, not an arithmetic consequence. Where a corrected total
 *     leaves them inconsistent the order is NAMED and the owner rules on it.
 *   a line whose goods have already been DELIVERED — the delivery note and its
 *     invoice were raised against the old amount. REFUSED and named.
 *   a document that is not MYR at rate 1 — a discount and an exchange rate are
 *     not distinguishable from a total alone (docs/bugs/0665: RM 13,068.55).
 *
 * MODE=plan (the default) writes nothing.
 * MODE=apply needs CONFIRM="I HAVE REVIEWED THE SO DISCOUNT PLAN".
 *
 * RE-RUN: idempotent. A second run finds each line already carrying the book's
 * own amount and its discount, plans zero changes and writes nothing.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { buildScope, currencyVerdict, decodeSnapshot } from "./lib/ac-scope.mjs";
import { repairPopulation } from "./lib/po-discount-plan.mjs";
import { planSoDocument, readBookSoDiscounts } from "./lib/so-discount-plan.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TRUTH = path.join(HERE, "data", "ac-reconcile-truth.json.gz");
const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const MAX_AGE = Number(process.env.MAX_SNAPSHOT_AGE_DAYS || 2);
const APPLY = (process.env.MODE || "plan").toLowerCase() === "apply";
const CONFIRM_PHRASE = "I HAVE REVIEWED THE SO DISCOUNT PLAN";
const note = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const plain = (m = "") => console.log(m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);
const rm = (s) => `RM ${(Number(s) / 100).toFixed(2)}`;

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}" — refusing to write.`);
  process.exit(2);
}

/* Byte-identical to repair-so-price-from-autocount.mjs:58. */
const BUCKET = {
  mattress: "mattress_sofa_sen", sofa: "mattress_sofa_sen", bedframe: "bedframe_sen",
  accessory: "accessories_sen", service: "service_sen", others: "others_sen",
};

const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });

async function main() {
  note(`mode=${APPLY ? "APPLY" : "PLAN (writes nothing)"} company=${CO}`);
  if (!fs.existsSync(TRUTH)) {
    bad("backend/scripts/data/ac-reconcile-truth.json.gz is missing. Cut it on a machine on the office network:");
    bad("  AC_CRED_FILE=<path> node backend/scripts/export-ac-reconcile-truth.mjs");
    process.exit(2);
  }
  const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(TRUTH)).toString("utf8").replace(/^﻿/, ""));
  const ageDays = (Date.now() - Date.parse(snap.exported_at)) / 86400000;
  note(`AutoCount snapshot ${snap.exported_at} (${ageDays.toFixed(2)} days old, limit ${MAX_AGE}), source ${snap.source}`);
  /* Negative age is a CLOCK problem: the exporter runs on a UTC+8 desktop and
     this runs on a UTC runner. Tolerate skew, refuse a real disagreement. */
  if (ageDays > MAX_AGE || ageDays < -0.5) {
    bad(`REFUSED: that snapshot is ${ageDays.toFixed(2)} days old. Re-cut it before moving money against it.`);
    await sql.end({ timeout: 5 });
    process.exit(2);
  }

  const book = decodeSnapshot(snap);
  const scope = buildScope(book);

  const heldRows = await sql`SELECT DISTINCT linked_ac_docno AS ac_no
      FROM scm.mfg_sales_orders
     WHERE company_id = ${CO} AND linked_ac_docno IS NOT NULL`;
  const { population, counts } = repairPopulation(scope.SO, heldRows.map((r) => r.ac_no));

  const { byDoc: bookDiscount, skipped, currencyRefused, whole, inPopulation } =
    readBookSoDiscounts(book.SO.lines, population, book.SO.headers, currencyVerdict);

  note("");
  note(`WHOLE BOOK: ${whole.lines} discounted line(s) across ${whole.docs.size} sales order(s), ${rm(whole.sen)}.`);
  note(
    `POPULATION: ${population.size} sales order(s) — ${counts.inScope} still in the outstanding scope, ` +
    `${counts.erpHeld} held by the ERP, of which ${counts.heldButOutOfScope} are held but NO LONGER IN SCOPE. ` +
    `${counts.inScopeButNotHeld} are in scope and the ERP does not hold them.`,
  );
  note(`CARRYING A DISCOUNT, IN THAT POPULATION: ${inPopulation.lines} line(s) across ${inPopulation.docs} sales order(s), ${rm(inPopulation.sen)}.`);

  if (currencyRefused.length) {
    plain("");
    bad(`CURRENCY: ${currencyRefused.length} sales order(s) REFUSED — a discount and an exchange rate are not`);
    bad("  distinguishable from a total alone, so this script does not try (docs/bugs/0665).");
    for (const r of currencyRefused) bad(`     ${r.docNo}: ${r.why}`);
    const unknown = currencyRefused.filter((r) => r.kind === "unknown");
    if (unknown.length) {
      bad(`REFUSING THE WHOLE RUN: ${unknown.length} document(s) have no currency in this snapshot. A script that cannot see the currency cannot claim a document does not have one.`);
      await sql.end({ timeout: 5 });
      process.exit(2);
    }
  }
  if (skipped.length) {
    plain(`  ${skipped.length} book line(s) SKIPPED because the book states no amount (空白不覆盖):`);
    for (const s of skipped.slice(0, 10)) plain(`     ${s}`);
  }
  if (!bookDiscount.size) {
    note("");
    note("No sales order in the population carries a line discount on this cut. Nothing to do.");
    await sql.end({ timeout: 5 });
    return;
  }

  const acNos = [...bookDiscount.keys()].sort();
  const erpRows = await sql`
    SELECT h.doc_no AS doc_no, h.linked_ac_docno AS ac_no,
           h.local_total_sen::bigint AS hdr_total_sen, h.paid_sen::bigint AS paid_sen,
           h.balance_sen::bigint AS hdr_balance_sen,
           i.id::text AS item_id, i.linked_ac_dtlkey::text AS dtlkey, i.item_code AS item_code,
           i.item_group AS item_group, i.qty::float8 AS qty,
           i.unit_price_sen::bigint AS unit_price_sen, i.discount_sen::bigint AS discount_sen,
           i.total_sen::bigint AS total_sen,
           COALESCE((SELECT SUM(d.qty)::float8 FROM scm.delivery_order_items d WHERE d.so_item_id = i.id), 0) AS delivered_qty
      FROM scm.mfg_sales_orders h
      JOIN scm.mfg_sales_order_items i ON i.doc_no = h.doc_no
     WHERE h.company_id = ${CO} AND h.linked_ac_docno = ANY(${acNos})
     ORDER BY h.doc_no, i.linked_ac_dtlkey, i.id`;

  const byDoc = new Map();
  for (const r of erpRows) {
    const ac = String(r.ac_no).trim();
    if (!byDoc.has(ac)) {
      byDoc.set(ac, {
        acNo: ac, docNo: r.doc_no, hdrTotal: Number(r.hdr_total_sen),
        paid: Number(r.paid_sen ?? 0), hdrBalance: Number(r.hdr_balance_sen ?? 0), lines: [],
      });
    }
    byDoc.get(ac).lines.push({
      itemId: r.item_id, dtlKey: r.dtlkey == null ? null : String(r.dtlkey).trim(),
      itemCode: r.item_code, itemGroup: r.item_group, qty: Number(r.qty),
      unitSen: Number(r.unit_price_sen), discountSen: Number(r.discount_sen ?? 0),
      totalSen: Number(r.total_sen ?? 0), deliveredQty: Number(r.delivered_qty ?? 0),
    });
  }

  const writes = []; const headers = []; const refusals = []; const absent = []; const table = [];
  for (const acNo of acNos) {
    const doc = byDoc.get(acNo);
    if (!doc) { absent.push(acNo); continue; }
    const p = planSoDocument({ wantByKey: bookDiscount.get(acNo), doc, rm });
    table.push({
      docNo: doc.docNo, acNo, lines: doc.lines.length, discounted: bookDiscount.get(acNo).size,
      refused: p.refusals.length, erpNow: doc.hdrTotal,
      acTotal: book.SO.headers.get(acNo)?.totalSen ?? null, planned: p.plannedTotal,
      paid: doc.paid, hdrBalance: doc.hdrBalance,
    });
    writes.push(...p.writes); refusals.push(...p.refusals);
    if (p.header) headers.push(p.header);
  }

  plain("");
  plain("═══════════ PER DOCUMENT: WHAT THE ERP SAYS NOW, WHAT AUTOCOUNT SAYS ═══════════");
  plain("");
  for (const t of table) {
    plain(`${t.docNo} (${t.acNo})  ${t.lines} line(s), ${t.discounted} discounted, ${t.refused} refused`);
    plain(`     ERP total ${rm(t.erpNow)}   AutoCount ${t.acTotal == null ? "(not in the cut)" : rm(t.acTotal)}   after this repair ${rm(t.planned)}`);
    if (t.acTotal != null && t.planned !== t.acTotal) {
      plain(`     NOTE: after the repair the header would read ${rm(t.planned)} and the book says ${rm(t.acTotal)} — the remainder is NOT a discount and is not this script's business.`);
    }
    if (Number(t.paid) !== 0) {
      plain(`     PAID ${rm(t.paid)}, header balance ${rm(t.hdrBalance)} — NOT touched. After the repair the total is ${rm(t.planned)}; if that no longer equals paid + balance the owner rules on it.`);
    }
  }
  plain("");
  for (const w of writes) {
    plain(`  ${w.docNo} key=${w.dtlKey} ${String(w.itemCode).slice(0, 34).padEnd(34)} ${w.qty} x ${rm(w.unitSen)} - ${rm(w.discountSen)} = ${rm(w.lineTotalSen)}  (was ${rm(w.wasLineTotal)})`);
  }
  if (refusals.length) {
    plain("");
    bad(`REFUSED: ${refusals.length}`);
    for (const r of refusals) bad(`   ${r}`);
  }
  if (absent.length) {
    plain("");
    bad(`In the population but absent from the ERP: ${absent.length}`);
    for (const a of absent) bad(`   ${a}`);
  }
  note("");
  note(`Lines to correct: ${writes.length}. Headers to re-sum: ${headers.length}. Refused: ${refusals.length}. Absent: ${absent.length}.`);

  if (!APPLY) { note(""); note(`PLAN ONLY — nothing written. To apply: MODE=apply CONFIRM="${CONFIRM_PHRASE}"`); await sql.end({ timeout: 5 }); return; }
  if (!writes.length) { note("nothing to write."); await sql.end({ timeout: 5 }); return; }

  let nLines = 0; let nHeads = 0;
  await sql.begin(async (tx) => {
    for (const w of writes) {
      /* Guarded on the row still holding exactly what the plan read, so a
         concurrent edit between plan and apply cannot be overwritten blind. */
      const u = await tx`UPDATE scm.mfg_sales_order_items
              SET discount_sen = ${w.discountSen}, total_sen = ${w.lineTotalSen},
                  total_inc_sen = ${w.lineTotalSen}, balance_sen = ${w.lineTotalSen}
            WHERE id = ${w.itemId} AND discount_sen = ${w.wasDiscount} AND total_sen = ${w.wasLineTotal}
            RETURNING id`;
      nLines += u.length;
    }
    for (const h of headers) {
      const lines = await tx`SELECT item_group, total_sen::bigint t FROM scm.mfg_sales_order_items WHERE doc_no = ${h.docNo}`;
      const b = { mattress_sofa_sen: 0, bedframe_sen: 0, accessories_sen: 0, service_sen: 0, others_sen: 0 };
      let total = 0;
      for (const l of lines) { total += Number(l.t); b[BUCKET[String(l.item_group)] ?? "others_sen"] += Number(l.t); }
      const u = await tx`UPDATE scm.mfg_sales_orders SET local_total_sen = ${total},
              mattress_sofa_sen = ${b.mattress_sofa_sen}, bedframe_sen = ${b.bedframe_sen},
              accessories_sen = ${b.accessories_sen}, service_sen = ${b.service_sen},
              others_sen = ${b.others_sen}
            WHERE doc_no = ${h.docNo} RETURNING doc_no`;
      nHeads += u.length;
    }
  });
  note(`APPLIED — ${nLines} of ${writes.length} line(s); ${nHeads} of ${headers.length} header(s) re-summed.`);

  /* VERIFY ON A FRESH CONNECTION, asserting the SHAPE. A row count is not a
     shape: what has to be true is that each line now carries the book's own
     amount AND the ERP's own invariant total = qty x unit - discount, and that
     the header equals the sum of its lines. */
  await sql.end({ timeout: 5 });
  const fresh = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  const wrong = []; let good = 0;
  for (const w of writes) {
    const [r] = await fresh`SELECT i.qty::float8 q, i.unit_price_sen::bigint up, i.discount_sen::bigint d,
          i.total_sen::bigint t, i.balance_sen::bigint bal, h.local_total_sen::bigint hdr,
          (SELECT COALESCE(SUM(x.total_sen),0)::bigint FROM scm.mfg_sales_order_items x WHERE x.doc_no = h.doc_no) AS lines_sum
        FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
       WHERE i.id = ${w.itemId}`;
    if (!r) { wrong.push(`${w.docNo} ${w.dtlKey}: the line is gone`); continue; }
    const faults = [];
    if (Number(r.t) !== w.lineTotalSen) faults.push(`total_sen ${r.t} != the book's ${w.lineTotalSen}`);
    if (Number(r.d) !== w.discountSen) faults.push(`discount_sen ${r.d} != ${w.discountSen}`);
    if (Number(r.t) !== Math.round(Number(r.q) * Number(r.up)) - Number(r.d)) faults.push(`the ERP's own invariant is broken: ${r.t} != ${r.q} x ${r.up} - ${r.d}`);
    if (Number(r.bal) !== Number(r.t)) faults.push(`balance_sen ${r.bal} != total_sen ${r.t}`);
    if (Number(r.hdr) !== Number(r.lines_sum)) faults.push(`header ${r.hdr} != the sum of its lines ${r.lines_sum}`);
    if (faults.length) wrong.push(`${w.docNo} ${w.dtlKey}: ${faults.join("; ")}`); else good += 1;
  }
  note(`VERIFIED ON A FRESH CONNECTION: ${good} of ${writes.length} line(s) carry the book's amount, the ERP's own invariant, and a header equal to the sum of its lines.`);
  for (const x of wrong) bad(`   WRONG SHAPE ${x}`);
  for (const t of table) {
    const [h] = await fresh`SELECT local_total_sen::bigint t, paid_sen::bigint p, balance_sen::bigint b FROM scm.mfg_sales_orders WHERE doc_no = ${t.docNo}`;
    if (!h) continue;
    const consistent = Number(h.t) === Number(h.p) + Number(h.b);
    note(`   ${t.docNo}  total ${rm(h.t)}   paid ${rm(h.p)} + balance ${rm(h.b)} ${consistent ? "= total" : `= ${rm(Number(h.p) + Number(h.b))}  <-- does not equal the total; the owner's call`}`);
  }
  await fresh.end();
  if (wrong.length) { bad("Some rows did not read back as written — do NOT run this again until that is understood."); process.exitCode = 1; }
}

main().catch(async (e) => { console.error(e); try { await sql.end({ timeout: 5 }); } catch { /* already closed */ } process.exit(1); });
