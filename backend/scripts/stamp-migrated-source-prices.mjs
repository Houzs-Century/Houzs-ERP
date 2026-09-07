#!/usr/bin/env node
/* stamp-migrated-source-prices — the migrated goods receipts and delivery
 * orders read RM 0.00 where AutoCount states a price. Copy the book's own line
 * money onto them.
 *
 * WHAT IS WRONG. `create-migrated-documents.mjs` carried the QUANTITY of the
 * outstanding receipts and deliveries and dropped the MONEY. The migrated
 * invoice converter's total gate then refuses every one of them, and its own
 * report says why: *"a price the cutover dropped — writable once the AutoCount
 * invoice price is stamped on the source lines"*. Measured against prod on
 * 2026-09-07 (dry-run of `create-migrated-invoices.mjs`, KIND=both): of 270
 * purchase-invoice total mismatches **95 are ours RM 0.00**, and of 4
 * sales-invoice mismatches **2 are**.
 *
 * WHERE THE PRICE COMES FROM — the RECEIPT line, not the purchase order.
 * Read from the committed 2026-09-07 snapshot: on all 180 zero-priced migrated
 * receipt lines the book's PO line reads `UnitPrice 0.00, SubTotal 0.00`.
 * Houzs does not price factory purchase orders in AutoCount. The money first
 * appears on GRDTL, and the purchase invoice bills GRDTL's SubTotal:
 *
 *     PO-001068 DtlKey 145254  qty 1  UnitPrice 0.00      SubTotal 0.00
 *     GR-000815 DtlKey 209355  qty 1  UnitPrice 3,373.45  SubTotal 2,867.43
 *     PI-001531                                           NetTotal 2,867.43
 *
 * so `SubTotal` is the value and `qty x UnitPrice` is not — the same line
 * discount that docs/bugs/0662 and docs/bugs/0664 are about. All three columns
 * are written (`unit_price_sen`, `discount_sen`, `line_total_sen`) because the
 * app recomputes `line_total = qty*unit - discount` on every edit
 * (grns.ts:1654, :1885, :2256): a line total written alone is self-erasing.
 *
 * ⚠ ONLY WHERE THE WHOLE INVOICE THEN RECONCILES. A migrated receipt is a
 * PARTIAL mirror — the cutover imported the outstanding purchase order, and
 * AutoCount's receipt routinely spans several. Measured: the 95 zero-priced
 * receipts fall into 41 AutoCount purchase invoices, and for 20 of them the
 * book's own receipt lines for OUR purchase order sum to LESS than the invoice
 * (PI-006897 bills RM 10,893.00 against a receipt line set worth RM 2,224.00).
 * Those are the multi-purchase-order fragments already with the owner. This
 * script does not touch them, deliberately: a correct price there would move
 * them out of the converter's "ours RM 0.00" bucket and into "both sides priced
 * and genuinely differ", making an owner-held decision read as a new problem.
 * So the gate is arithmetic — a document is stamped only when, after stamping,
 * the ERP group's total EQUALS what AutoCount billed on that invoice.
 *
 * THE CROSS-CHECK IS NOT CIRCULAR. The line money comes from
 * `ac-reconcile-truth.json.gz` (GRDTL/DODTL) and the invoice total from
 * `ac-invoice-refs.json.gz` (PI/IV headers). Two independent exports of the
 * same book agreeing to the sen is the evidence; a document where they do not
 * agree is left alone.
 *
 * ⚠ CURRENCY IS A REFUSAL, NOT A CONVERSION. A document that is not MYR at
 * rate 1 never reaches the planner, and a snapshot with no currency at all
 * refuses the whole run. A discount and an exchange rate are not
 * distinguishable from a total alone — docs/bugs/0665, RM 13,068.55.
 *
 * ⚠ ONE AUTOCOUNT LINE IS MANY ERP ROWS. A sofa is one GRDTL row and one ERP
 * row per compartment sharing one `linked_ac_dtlkey`. The price rides the LEAD
 * piece and the siblings stay at 0, which is what
 * `import-ac-outstanding-po.mjs:290` already does; spreading it would multiply
 * the document by its piece count (docs/bugs/0673, RM 2,216,501, caught in
 * dry-run). Every decision is in `lib/migrated-source-price-plan.mjs`.
 *
 * WHAT THIS DOES NOT TOUCH, said plainly:
 *   * PURCHASE ORDER lines. The book holds no price on them; 空白不覆盖.
 *   * STOCK. Every document here is `migrated_no_stock = true`; the cutover
 *     wrote no inventory movement for them and this writes none either.
 *   * The GL. No journal entry is posted, here or by the invoices that follow.
 *   * A line that already carries money. The selection is zero-priced lines and
 *     a priced one is never overwritten.
 *
 *   DATABASE_URL   required
 *   COMPANY_ID     default 1 (AED_HOUZS is company 1)
 *   KIND           gr | do | both (default both)
 *   MODE           plan (default) | apply
 *   CONFIRM        on apply, exactly: THE PRICE COMES FROM THE AUTOCOUNT LINE
 *   MAX_SNAPSHOT_AGE_DAYS  default 2
 *
 * RE-RUN: idempotent. The selection is `unit_price_sen = 0`, so a second run
 * finds every stamped line already priced, plans nothing and writes nothing.
 * Each UPDATE is additionally guarded on the row still holding the exact zeros
 * the plan read, so a row somebody edited in between is SKIPPED and named.
 *
 * -- REVERSAL: the previous values were all 0 (the selection is zero-priced
 * lines and the guard asserts it), so the undo is
 * `UPDATE scm.grn_items SET unit_price_sen = 0, discount_sen = 0,
 * line_total_sen = 0 WHERE id = ANY(<the ids this run printed>)` plus
 * `subtotal_sen = 0, total_sen = 0` on the receipt headers it printed (they
 * were 0 too: all 320 migrated receipts read 0 before this ran). The apply
 * prints every id it touches for exactly this reason.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import postgres from 'postgres';

import { decodeSnapshot, currencyVerdict } from './lib/ac-scope.mjs';
import { planSourceDocument } from './lib/migrated-source-price-plan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, 'data');
const TRUTH = 'ac-reconcile-truth.json.gz';
const INVREFS = 'ac-invoice-refs.json.gz';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const KIND = String(process.env.KIND || 'both').toLowerCase();
const MAX_AGE = Number(process.env.MAX_SNAPSHOT_AGE_DAYS || 2);
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'THE PRICE COMES FROM THE AUTOCOUNT LINE';

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const plain = (m) => console.log(m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);
const rm = (s) => `RM ${(s / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (x) => Number(x || 0);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}" — refusing to write.`);
  process.exit(2);
}

function loadGz(file) {
  const p = path.join(DATA, file);
  if (!fs.existsSync(p)) {
    bad(`backend/scripts/data/${file} is missing. Cut it on a machine on the office network.`);
    process.exit(2);
  }
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8').replace(/^﻿/, ''));
}

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

/** Group an ERP document's rows the way AutoCount sees them: one group per book
 *  line, which for a sofa is several ERP rows sharing one `linked_ac_dtlkey`. */
function buildGroups(rows) {
  const byKey = new Map();
  for (const r of rows) {
    const k = r.groupKey ?? `row:${r.lineId}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  return [...byKey.entries()]
    /* Ascending AutoCount DtlKey is ascending line order on the document it came
       from, which is the order the book states its lines in. The alignment is
       still verified on QUANTITY — this only decides where to start. */
    .sort((a, b) => {
      const na = Number(a[0]); const nb = Number(b[0]);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return String(a[0]).localeCompare(String(b[0]));
    })
    .map(([key, rs]) => ({
      key,
      qty: rs.reduce((m, r) => Math.max(m, Number(r.qty)), 0),
      itemCodes: rs.map((r) => r.itemCode),
      rows: rs,
    }));
}

/** What one ERP document is worth right now, by the invoice gate's own rule. */
const docValue = (rows) => rows.reduce(
  (t, r) => t + Math.max(0, Math.round(Number(r.qty) * num(r.unitSen)) - num(r.discountSen)), 0,
);

async function loadReceipts(book) {
  const heads = await sql`
    SELECT g.id::text AS id, g.grn_number, g.subtotal_sen::bigint AS subtotal_sen,
           g.total_sen::bigint AS total_sen, p.linked_ac_grn_docnos AS ac_grs,
           p.linked_ac_docno AS ac_po
      FROM scm.grns g JOIN scm.purchase_orders p ON p.id = g.purchase_order_id
     WHERE g.company_id = ${CO} AND g.migrated_no_stock = true
     ORDER BY g.grn_number`;
  const items = await sql`
    SELECT i.id::text AS id, i.grn_id::text AS grn_id, i.item_code,
           i.qty_accepted::float8 AS qty_accepted, i.qty_received::float8 AS qty_received,
           i.invoiced_qty::float8 AS invoiced_qty, i.returned_qty::float8 AS returned_qty,
           i.unit_price_sen::bigint AS unit_price_sen, i.discount_sen::bigint AS discount_sen,
           i.line_total_sen::bigint AS line_total_sen,
           po.linked_ac_dtlkey::text AS group_key
      FROM scm.grn_items i
      JOIN scm.grns g ON g.id = i.grn_id
      LEFT JOIN scm.purchase_order_items po ON po.id = i.purchase_order_item_id
     WHERE g.company_id = ${CO} AND g.migrated_no_stock = true
     ORDER BY i.created_at, i.id`;
  const byDoc = new Map();
  for (const i of items) {
    if (!byDoc.has(i.grn_id)) byDoc.set(i.grn_id, []);
    byDoc.get(i.grn_id).push({
      lineId: i.id,
      itemCode: i.item_code,
      /* The quantity the invoice gate counts (create-migrated-invoices.mjs). */
      qty: num(i.qty_accepted) - num(i.invoiced_qty) - num(i.returned_qty),
      qtyReceived: num(i.qty_received),
      invoicedQty: num(i.invoiced_qty),
      returnedQty: num(i.returned_qty),
      unitSen: num(i.unit_price_sen),
      discountSen: num(i.discount_sen),
      lineTotalSen: num(i.line_total_sen),
      groupKey: i.group_key,
    });
  }
  return heads.map((h) => {
    const acGr = (h.ac_grs ?? []).find(
      (g) => h.grn_number === `HC-${g}` || h.grn_number.startsWith(`HC-${g}-`)) ?? null;
    const rows = byDoc.get(h.id) ?? [];
    /* Scoped to the purchase order OUR receipt mirrors: AutoCount's receipt
       covers every order it received that day, ours covers one. */
    const bookLines = (book.GR.lines.get(acGr) ?? [])
      .filter((l) => l.fromDocType === 'PO' && l.fromDocNo === h.ac_po)
      .sort((a, b) => a.seq - b.seq);
    return {
      kind: 'GR',
      id: h.id,
      docNo: h.grn_number,
      acDocNo: acGr,
      acScopeNo: h.ac_po,
      header: { subtotalSen: num(h.subtotal_sen), totalSen: num(h.total_sen) },
      currency: currencyVerdict(acGr ? book.GR.headers.get(acGr) : null),
      rows,
      groups: buildGroups(rows),
      bookLines,
    };
  });
}

async function loadDeliveries(book) {
  const heads = await sql`
    SELECT d.id::text AS id, d.do_number, d.linked_ac_docno AS ac_do,
           d.local_total_sen::bigint AS local_total_sen
      FROM scm.delivery_orders d
     WHERE d.company_id = ${CO} AND d.migrated_no_stock = true
     ORDER BY d.do_number`;
  const items = await sql`
    SELECT i.id::text AS id, i.delivery_order_id::text AS do_id, i.item_code,
           i.qty::float8 AS qty, i.unit_price_sen::bigint AS unit_price_sen,
           i.discount_sen::bigint AS discount_sen, i.line_total_sen::bigint AS line_total_sen,
           s.linked_ac_dtlkey::text AS group_key, s.unit_price_sen::bigint AS so_unit_price_sen
      FROM scm.delivery_order_items i
      JOIN scm.delivery_orders d ON d.id = i.delivery_order_id
      LEFT JOIN scm.mfg_sales_order_items s ON s.id = i.so_item_id
     WHERE d.company_id = ${CO} AND d.migrated_no_stock = true
     ORDER BY i.line_no, i.created_at, i.id`;
  const byDoc = new Map();
  for (const i of items) {
    if (!byDoc.has(i.do_id)) byDoc.set(i.do_id, []);
    byDoc.get(i.do_id).push({
      lineId: i.id,
      itemCode: i.item_code,
      qty: num(i.qty),
      qtyReceived: num(i.qty),
      invoicedQty: 0,
      returnedQty: 0,
      /* The converter recovers a dropped delivery price from the SALES ORDER
         line before it gives up (create-migrated-invoices.mjs:203). A line it
         can recover is not this script's business — only one the order cannot
         answer for either. */
      unitSen: num(i.unit_price_sen) || num(i.so_unit_price_sen),
      discountSen: num(i.discount_sen),
      lineTotalSen: num(i.line_total_sen),
      groupKey: i.group_key,
    });
  }
  return heads.map((h) => {
    const rows = byDoc.get(h.id) ?? [];
    const bookLines = (book.DO.lines.get(h.ac_do) ?? []).slice().sort((a, b) => a.seq - b.seq);
    return {
      kind: 'DO',
      id: h.id,
      docNo: h.do_number,
      acDocNo: h.ac_do,
      acScopeNo: h.ac_do,
      header: { localTotalSen: num(h.local_total_sen) },
      currency: currencyVerdict(h.ac_do ? book.DO.headers.get(h.ac_do) : null),
      rows,
      groups: buildGroups(rows),
      bookLines,
    };
  });
}

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'} company=${CO} kind=${KIND}`);

  const snap = loadGz(TRUTH);
  const refs = loadGz(INVREFS);
  const truthAge = (Date.now() - Date.parse(snap.exported_at)) / 86400000;
  const refsAge = (Date.now() - Date.parse(refs._exportedAt)) / 86400000;
  note(`AutoCount line snapshot ${snap.exported_at} (${truthAge.toFixed(2)} days old)`);
  note(`AutoCount invoice map   ${refs._exportedAt} (${refsAge.toFixed(2)} days old)`);
  /* Negative age is a CLOCK problem, not a fresh snapshot: the exporter runs on
     a UTC+8 desktop and this runs on a UTC runner. */
  for (const [what, age] of [['line snapshot', truthAge], ['invoice map', refsAge]]) {
    if (age > MAX_AGE || age < -0.5) {
      bad(`REFUSED: the ${what} is ${age.toFixed(2)} days old (limit ${MAX_AGE}). Re-cut it before moving money against it.`);
      await sql.end({ timeout: 5 });
      process.exit(2);
    }
  }

  const book = decodeSnapshot(snap);
  const acInvoiceTotal = {};
  const cancelled = new Set();
  for (const [doc, m] of Object.entries({ ...refs.piMeta, ...refs.ivMeta })) {
    acInvoiceTotal[doc] = Math.round(Number(m.netTotal) * 100);
    if (m.cancelled) cancelled.add(doc);
  }

  const docs = [];
  if (KIND === 'gr' || KIND === 'both') docs.push(...await loadReceipts(book));
  if (KIND === 'do' || KIND === 'both') docs.push(...await loadDeliveries(book));
  note(`migrated source documents read: ${docs.length}`);

  /* Which AutoCount invoice each document belongs to. A document invoiced across
     several has no line key to split by, so the converter refuses it and so does
     this: there is nothing here that can decide which invoice priced which line. */
  const invoiceOf = (d) => {
    const raw = (d.kind === 'GR' ? refs.grToPi[d.acDocNo] : refs.doToIv[d.acDocNo]) ?? [];
    const liveOnes = [...new Set(raw.map((x) => String(x).trim()).filter((x) => x && !cancelled.has(x)))];
    return liveOnes.length === 1 ? liveOnes[0] : null;
  };

  const unknownCurrency = [];
  const foreignCurrency = [];
  const planByDoc = new Map();
  const refusals = [];

  for (const d of docs) {
    if (!d.acDocNo) continue;
    /* Nothing to do: every line already carries money. */
    if (!d.rows.some((r) => num(r.unitSen) === 0)) continue;
    if (d.currency.kind === 'unknown') { unknownCurrency.push(`${d.docNo}: ${d.currency.why}`); continue; }
    if (d.currency.kind === 'foreign') { foreignCurrency.push(`${d.docNo} (AutoCount ${d.acDocNo}): ${d.currency.why}`); continue; }
    const p = planSourceDocument({ doc: d, bookLines: d.bookLines, rm });
    refusals.push(...p.refusals);
    if (p.writes.length) planByDoc.set(d.docNo, p);
  }

  if (unknownCurrency.length) {
    plain('');
    bad(`REFUSING THE WHOLE RUN: ${unknownCurrency.length} document(s) have no currency in this snapshot.`);
    bad('  A script that cannot see the currency cannot claim a document does not have one (docs/bugs/0665).');
    for (const u of unknownCurrency.slice(0, 10)) bad(`     ${u}`);
    await sql.end({ timeout: 5 });
    process.exit(2);
  }
  if (foreignCurrency.length) {
    plain('');
    bad(`CURRENCY: ${foreignCurrency.length} document(s) REFUSED — a discount and an exchange rate are not`);
    bad('  distinguishable from a total alone, so this script does not try.');
    for (const f of foreignCurrency) bad(`     ${f}`);
  }

  /* ── the invoice gate: only stamp where the whole group then reconciles ── */
  const byInvoice = new Map();
  for (const d of docs) {
    const inv = invoiceOf(d);
    if (!inv) continue;
    if (!byInvoice.has(inv)) byInvoice.set(inv, []);
    byInvoice.get(inv).push(d);
  }

  const accepted = [];
  const shortOfInvoice = [];
  for (const [inv, group] of byInvoice) {
    const planned = group.filter((d) => planByDoc.has(d.docNo));
    if (!planned.length) continue;
    const acTotal = acInvoiceTotal[inv];
    const after = group.reduce((t, d) => {
      const p = planByDoc.get(d.docNo);
      if (!p) return t + docValue(d.rows);
      const stamped = new Map(p.writes.map((w) => [w.lineId, w.lineTotalSen]));
      return t + d.rows.reduce((s, r) => s + (stamped.has(r.lineId)
        ? stamped.get(r.lineId)
        : Math.max(0, Math.round(Number(r.qty) * num(r.unitSen)) - num(r.discountSen))), 0);
    }, 0);
    const before = group.reduce((t, d) => t + docValue(d.rows), 0);
    const row = { inv, acTotal, before, after, docs: group.map((d) => d.docNo), planned: planned.map((d) => d.docNo) };
    if (acTotal != null && after === acTotal) accepted.push(row); else shortOfInvoice.push(row);
  }

  const acceptedDocs = new Set(accepted.flatMap((a) => a.planned));
  const writes = [];
  for (const [docNo, p] of planByDoc) if (acceptedDocs.has(docNo)) writes.push(...p.writes);

  /* ── the report ────────────────────────────────────────────────────────── */
  plain('');
  plain('═════════ WHAT AUTOCOUNT BILLED, AND WHAT OUR DOCUMENTS WOULD BE WORTH ═════════');
  plain('');
  plain('AutoCount invoice   AutoCount billed      ours now        ours after      source document(s)');
  for (const a of [...accepted].sort((x, y) => x.inv.localeCompare(y.inv))) {
    plain(`${String(a.inv).padEnd(19)} ${rm(a.acTotal).padStart(16)} ${rm(a.before).padStart(15)} ${rm(a.after).padStart(15)}      ${a.docs.join(' + ')}`);
  }
  plain('');
  note(`STAMPING ${writes.length} line(s) across ${acceptedDocs.size} document(s) / ${accepted.length} AutoCount invoice(s).`);
  note(`After this, those ${accepted.length} invoice(s) reconcile to the sen and become convertible.`);

  if (shortOfInvoice.length) {
    plain('');
    note(`LEFT ALONE — ${shortOfInvoice.length} AutoCount invoice(s) whose ERP side cannot reach the billed total:`);
    note('  our receipt mirrors ONE purchase order and AutoCount\'s receipt spans several, so the invoice bills more');
    note('  than our lines cover. A price cannot fix that; these are the multi-purchase-order fragments with the owner.');
    for (const s of [...shortOfInvoice].sort((x, y) => x.inv.localeCompare(y.inv))) {
      plain(`     ${String(s.inv).padEnd(14)} AutoCount ${rm(s.acTotal ?? 0).padStart(13)}  ours would be ${rm(s.after).padStart(13)}   ${s.planned.join(' + ')}`);
    }
  }

  if (refusals.length) {
    plain('');
    plain('REFUSED — printed in full, never guessed at:');
    for (const r of refusals) bad(`  ${r}`);
  }

  plain('');
  plain('LINE BY LINE:');
  for (const w of writes) {
    plain(
      `  ${String(w.docNo).padEnd(24)} ${String(w.itemCode ?? '-').padEnd(22)} qty ${String(w.qty).padStart(3)} `
      + `@ ${rm(w.unitSen).padStart(13)} - discount ${rm(w.discountSen).padStart(11)} = ${rm(w.lineTotalSen).padStart(13)}`
      + `  [AutoCount DtlKey ${w.dtlKey}]`
      + (w.siblingsLeftAtZero.length ? `  siblings left at RM 0.00: ${w.siblingsLeftAtZero.join(', ')}` : ''),
    );
  }

  if (!APPLY) {
    plain('');
    note(`PLAN ONLY — nothing written. To apply: MODE=apply CONFIRM="${CONFIRM_PHRASE}"`);
    await sql.end({ timeout: 5 });
    return;
  }

  /* ── the write ─────────────────────────────────────────────────────────── */
  plain('');
  note(`=== APPLYING ${writes.length} line(s) ===`);
  const byId = new Map(docs.map((d) => [d.docNo, d]));
  let wroteLines = 0;
  const touchedDocs = new Set();
  for (const w of writes) {
    const d = byId.get(w.docNo);
    const table = d.kind === 'GR' ? 'grn_items' : 'delivery_order_items';
    /* Guarded on the row still holding exactly the zeros the plan read. A row a
       person priced between the plan and the apply is SKIPPED, not overwritten. */
    const back = d.kind === 'GR'
      ? await sql`
        UPDATE scm.grn_items
           SET unit_price_sen = ${w.unitSen}, discount_sen = ${w.discountSen}, line_total_sen = ${w.lineTotalSen}
         WHERE id = ${w.lineId}::uuid AND company_id = ${CO}
           AND COALESCE(unit_price_sen, 0) = ${w.wasUnitSen}
           AND COALESCE(discount_sen, 0) = ${w.wasDiscountSen}
           AND COALESCE(line_total_sen, 0) = ${w.wasLineTotalSen}
         RETURNING id::text AS id`
      : await sql`
        UPDATE scm.delivery_order_items
           SET unit_price_sen = ${w.unitSen}, discount_sen = ${w.discountSen}, line_total_sen = ${w.lineTotalSen}
         WHERE id = ${w.lineId}::uuid AND company_id = ${CO}
           AND COALESCE(unit_price_sen, 0) = ${w.wasUnitSen}
           AND COALESCE(discount_sen, 0) = ${w.wasDiscountSen}
           AND COALESCE(line_total_sen, 0) = ${w.wasLineTotalSen}
         RETURNING id::text AS id`;
    if (back.length) { wroteLines++; touchedDocs.add(w.docNo); plain(`  WROTE ${table} ${w.lineId}  ${w.docNo} ${w.itemCode} -> ${rm(w.lineTotalSen)}`); }
    else bad(`  SKIP ${w.docNo} ${w.itemCode} — the row no longer holds the zeros the plan read`);
  }
  note(`  lines written: ${wroteLines} of ${writes.length}`);

  /* The header, re-summed the way the app's own recompute does it: a plain sum
     of line_total_sen over EVERY line of the document (grns.ts:726 for a
     receipt, and local_total_sen for a delivery — the category buckets are
     recomputeDoTotals' one home and a second copy here is how two answers
     start, same call repair-migrated-do-prices.mjs made). */
  let wroteHeaders = 0;
  for (const docNo of touchedDocs) {
    const d = byId.get(docNo);
    const back = d.kind === 'GR'
      ? await sql`
        UPDATE scm.grns g
           SET subtotal_sen = s.total, total_sen = s.total, updated_at = now()
          FROM (SELECT COALESCE(SUM(line_total_sen), 0)::bigint AS total FROM scm.grn_items WHERE grn_id = ${d.id}::uuid) s
         WHERE g.id = ${d.id}::uuid AND g.company_id = ${CO}
         RETURNING g.grn_number AS doc_no, g.total_sen::bigint AS total_sen`
      : await sql`
        UPDATE scm.delivery_orders d
           SET local_total_sen = s.total, updated_at = now()
          FROM (SELECT COALESCE(SUM(line_total_sen), 0)::bigint AS total FROM scm.delivery_order_items WHERE delivery_order_id = ${d.id}::uuid) s
         WHERE d.id = ${d.id}::uuid AND d.company_id = ${CO}
         RETURNING d.do_number AS doc_no, d.local_total_sen::bigint AS total_sen`;
    if (back.length) { wroteHeaders++; plain(`  HEADER ${back[0].doc_no} -> ${rm(Number(back[0].total_sen))}`); }
    else bad(`  SKIP header ${docNo} — not updated`);
  }
  note(`  headers written: ${wroteHeaders} of ${touchedDocs.size}`);

  await sql.end({ timeout: 5 });

  /* ── verified on a FRESH connection, on the SHAPE ───────────────────────── */
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    plain('');
    note('=== VERIFIED ON A FRESH CONNECTION ===');
    /* Not a row count. Three properties are re-read as VALUES and asserted:
         1. every stamped line satisfies the app's own invariant
            line_total_sen = qty*unit_price_sen - discount_sen;
         2. the line total equals AutoCount's own amount for that line;
         3. the document's stamped lines sum to what AutoCount billed on the
            invoice they belong to.
       A repair that reported "N of N" while producing the wrong shape is the
       precedent this exists for (docs/jsonb-double-encoding-coe.md). */
    const grIds = writes.filter((w) => byId.get(w.docNo).kind === 'GR').map((w) => w.lineId);
    const doIds = writes.filter((w) => byId.get(w.docNo).kind === 'DO').map((w) => w.lineId);
    const back = [
      ...(grIds.length ? await check`
        SELECT i.id::text AS id, g.grn_number AS doc_no, i.qty_accepted::float8 AS qty,
               i.unit_price_sen::bigint AS unit_price_sen, i.discount_sen::bigint AS discount_sen,
               i.line_total_sen::bigint AS line_total_sen
          FROM scm.grn_items i JOIN scm.grns g ON g.id = i.grn_id
         WHERE i.id = ANY(${grIds}::uuid[])` : []),
      ...(doIds.length ? await check`
        SELECT i.id::text AS id, d.do_number AS doc_no, i.qty::float8 AS qty,
               i.unit_price_sen::bigint AS unit_price_sen, i.discount_sen::bigint AS discount_sen,
               i.line_total_sen::bigint AS line_total_sen
          FROM scm.delivery_order_items i JOIN scm.delivery_orders d ON d.id = i.delivery_order_id
         WHERE i.id = ANY(${doIds}::uuid[])` : []),
    ];
    const want = new Map(writes.map((w) => [w.lineId, w]));
    let invariantBroken = 0; let notBook = 0;
    for (const r of back) {
      const w = want.get(r.id);
      const shape = Math.round(Number(r.qty) * Number(r.unit_price_sen)) - Number(r.discount_sen);
      if (shape !== Number(r.line_total_sen)) {
        invariantBroken++;
        bad(`  ${r.doc_no} ${r.id}: qty*unit - discount = ${shape} but line_total_sen reads ${r.line_total_sen}`);
      }
      if (Number(r.line_total_sen) !== w.lineTotalSen) {
        notBook++;
        bad(`  ${r.doc_no} ${r.id}: line_total_sen reads ${rm(Number(r.line_total_sen))}, AutoCount says ${rm(w.lineTotalSen)}`);
      }
    }
    note(`  ${back.length} of ${writes.length} stamped line(s) re-read; invariant broken on ${invariantBroken}, disagreeing with the book on ${notBook}`);
    for (const r of back.slice(0, 10)) {
      note(`  ${r.doc_no} ${r.id}: qty ${r.qty} @ ${rm(Number(r.unit_price_sen))} - ${rm(Number(r.discount_sen))} = ${rm(Number(r.line_total_sen))}`);
    }

    let invoicesAgreeing = 0;
    for (const a of accepted) {
      const gr = a.docs.filter((n) => byId.get(n).kind === 'GR').map((n) => byId.get(n).id);
      const dd = a.docs.filter((n) => byId.get(n).kind === 'DO').map((n) => byId.get(n).id);
      const sums = [
        ...(gr.length ? await check`SELECT COALESCE(SUM(line_total_sen), 0)::bigint AS t FROM scm.grn_items WHERE grn_id = ANY(${gr}::uuid[])` : []),
        ...(dd.length ? await check`SELECT COALESCE(SUM(line_total_sen), 0)::bigint AS t FROM scm.delivery_order_items WHERE delivery_order_id = ANY(${dd}::uuid[])` : []),
      ];
      const total = sums.reduce((t, r) => t + Number(r.t), 0);
      const ok = total === a.acTotal;
      if (ok) invoicesAgreeing++;
      (ok ? note : bad)(`  ${a.inv}: our source line(s) now sum to ${rm(total)}, AutoCount billed ${rm(a.acTotal)}${ok ? '' : ' — THESE DISAGREE'}`);
    }
    note(`  ${invoicesAgreeing} of ${accepted.length} AutoCount invoice(s) now reconcile to the sen.`);
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
