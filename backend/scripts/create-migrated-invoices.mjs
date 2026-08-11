#!/usr/bin/env node
// Complete the ERP's own document chain: turn the goods receipts and delivery
// orders CARRIED OVER from AutoCount into the purchase invoices and sales
// invoices AutoCount already raised from them.
//
// Owner 2026-08-11: "那些 GR 已经 convert 成 purchase invoice 了，所以你应该要转成
// purchase invoice，DO 也应该要转成 sales invoice 吧？跟着它的链路，它的
// documentation relationship map 去完善调到完." Narrowed twice — "我说的是我们ERP
// 的DO to Invoice / 我们ERP的GR to PI" and "而不是全部" — so this converts OUR
// documents. It does NOT import AutoCount's 4,789 purchase-invoice / 9,245
// sales-invoice history; the owner ruled that out ("这个不要").
//
// WHY THIS SCRIPT AND NOT THE CONVERT ROUTE. POST /from-grn and POST /from-dos
// exist and work, and both now REFUSE a migrated source on purpose
// (routes/purchase-invoices.ts, routes/sales-invoices.ts). Three things go wrong
// if a migrated document goes through them: the invoice is numbered
// PI-YYMM-NNNN instead of HC-<AutoCount's number>, breaking the owner's standing
// rule that everything carried over keeps AutoCount's numbering; it posts a
// journal entry for money AutoCount already booked; and it enqueues an
// AutoCount write-back that duplicates the invoice in the live account book.
// So migrated invoices are written here, following migration 0276's pattern —
// the invoice carries AutoCount's number, is flagged migrated_no_stock, posts no
// GL and is never enqueued — and the DECISIONS come from the same
// src/scm/lib/migrated-chain.ts the routes import, so the two cannot drift.
//
// NO STOCK IN EITHER DIRECTION. An invoice never moves inventory in this ERP
// (PI is AP-only, SI is AR-only), so nothing here can double-count stock. What
// it must not double-count is MONEY, and that is what migrated_no_stock stops.
//
// DRY-RUN by default; APPLY=1 writes. The dry-run prints exactly the lines APPLY
// would write, one per document. Idempotent: an AutoCount invoice already
// mirrored is skipped, so a second run creates nothing.
//
// Run it with tsx so the shared rules import directly:
//   npx tsx scripts/create-migrated-invoices.mjs
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { planMigratedInvoices } from "../src/scm/lib/migrated-chain.ts";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const KIND = (process.env.KIND || "both").toLowerCase();
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const CO = 1;
const SYS_USER = "00000000-0000-4000-8000-000000000001";
const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", f))).toString("utf8").replace(/^﻿/, ""));
const rm = (sen) => `RM ${(sen / 100).toFixed(2)}`;
const n = (x) => Number(x || 0);

/* The AutoCount relationship map: which purchase invoice was raised from which
   receipt, which sales invoice from which delivery, and what each was worth.
   Exported read-only from live AED_HOUZS (PIDTL/PI + IVDTL/IV) — see
   docs/autocount-cutover-ledger.md. It is committed rather than queried because
   AutoCount is reachable only over the owner's ZeroTier link, which CI is not
   on, and because a check that reads a moving target cannot be re-run to
   reproduce a past verdict. */
const REFS = gz("ac-invoice-refs.json.gz");

/* AutoCount stores money as a decimal; the ERP stores sen. Round once, here, so
   the comparison against our integer sen is exact rather than float-fuzzy. */
const acTotals = {};
for (const [doc, m] of Object.entries({ ...REFS.piMeta, ...REFS.ivMeta })) {
  acTotals[doc] = Math.round(Number(m.netTotal) * 100);
}
const cancelled = new Set(
  Object.entries({ ...REFS.piMeta, ...REFS.ivMeta }).filter(([, m]) => m.cancelled).map(([d]) => d));
const liveInvoices = (list) => (list ?? []).filter((x) => !cancelled.has(x));
const deadInvoices = (list) => (list ?? []).filter((x) => cancelled.has(x));

/* ── Sources ──────────────────────────────────────────────────────────────── */

async function loadGrnSources() {
  const rows = await sql`
    SELECT g.id, g.grn_number, g.supplier_id, g.currency, g.exchange_rate, g.received_at,
           g.purchase_order_id, p.linked_ac_grn_docnos AS ac_grs
    FROM scm.grns g JOIN scm.purchase_orders p ON p.id = g.purchase_order_id
    WHERE g.company_id = ${CO} AND g.migrated_no_stock = true
    ORDER BY g.grn_number`;
  const items = await sql`
    SELECT i.id, i.grn_id, i.material_kind, i.material_code, i.material_name, i.item_group,
           i.description, i.description2, i.uom, i.unit_price_centi, i.discount_centi,
           i.qty_accepted, i.invoiced_qty, i.returned_qty, i.purchase_order_item_id,
           i.variants, i.gap_inches, i.divan_height_inches, i.divan_price_sen,
           i.leg_height_inches, i.leg_price_sen, i.custom_specials, i.line_suffix,
           i.special_order_price_sen
    FROM scm.grn_items i JOIN scm.grns g ON g.id = i.grn_id
    WHERE g.company_id = ${CO} AND g.migrated_no_stock = true`;
  const byDoc = new Map();
  for (const it of items) { if (!byDoc.has(it.grn_id)) byDoc.set(it.grn_id, []); byDoc.get(it.grn_id).push(it); }

  return rows.map((g) => {
    /* The AutoCount receipt number is the head of our GRN number: HC-<GR> when
       that receipt covers one imported PO, HC-<GR>-<PO> when it covers more.
       Derived rather than read from grns.linked_ac_docno, which holds the PO's
       AutoCount number and not the receipt's despite what migration 0276's
       comment says. */
    const acGr = (g.ac_grs ?? []).find(
      (gr) => g.grn_number === `HC-${gr}` || g.grn_number.startsWith(`HC-${gr}-`)) ?? null;
    const raw = REFS.grToPi[acGr] ?? [];
    const lines = (byDoc.get(g.id) ?? []).map((i) => ({
      lineId: i.id,
      itemCode: i.material_code,
      /* Remaining, not accepted: a receipt can be invoiced across several
         invoices, and anything returned to the supplier is not billable. */
      qty: n(i.qty_accepted) - n(i.invoiced_qty) - n(i.returned_qty),
      unitPriceCenti: n(i.unit_price_centi),
      discountCenti: n(i.discount_centi),
      sourceLineKey: i.purchase_order_item_id,
      _row: i,
    }));
    return {
      docNo: g.grn_number, acDocNo: acGr,
      acInvoiceNos: liveInvoices(raw), acCancelledInvoiceNos: deadInvoices(raw),
      /* Rule 5 — the merged header names one supplier, and writePi takes it from
         whichever source document sorts first. Hand the planner the party so a
         disagreement is refused instead of resolved by sort order. */
      partyKey: g.supplier_id ?? null,
      lines, _head: g,
    };
  });
}

async function loadDoSources() {
  const rows = await sql`
    SELECT d.id, d.do_number, d.linked_ac_docno, d.debtor_code, d.debtor_name, d.currency,
           d.so_doc_no, d.delivered_at, d.do_date, d.salesperson_id, d.venue, d.venue_id,
           d.customer_so_no, d.po_doc_no, d.sales_location, d.ref, d.note
    FROM scm.delivery_orders d
    WHERE d.company_id = ${CO} AND d.migrated_no_stock = true
    ORDER BY d.do_number`;
  /* s.unit_price_centi is the RECOVERY source for a price the cutover dropped.
     create-migrated-documents.mjs inserts a delivery-order line with seven
     columns and unit_price_centi is not one of them, so all 59 migrated DO lines
     read RM 0.00 — a stored zero, not a null, so nothing downstream can tell it
     from a genuinely free line. Every one of those lines does carry so_item_id,
     and the DO line price is by definition a snapshot of that order line's
     price, so reading it back is restoring the snapshot the migration failed to
     take, not inventing a number. It is also independently PROVEN per invoice:
     the total gate then has to agree with what AutoCount actually billed, and an
     invoice whose recovered prices are wrong fails that test rather than being
     written. Only the UNIT price is taken — never the order line's discount,
     which belongs to the order's full quantity and not to a partial delivery. */
  const items = await sql`
    SELECT i.id, i.delivery_order_id, i.item_code, i.item_group, i.description, i.description2,
           i.uom, i.qty, i.unit_price_centi, i.discount_centi, i.unit_cost_centi, i.so_item_id,
           i.variants, i.gap_inches, i.divan_height_inches, i.divan_price_sen,
           i.leg_height_inches, i.leg_price_sen, i.custom_specials, i.line_suffix,
           i.special_order_price_sen,
           s.unit_price_centi AS so_unit_price_centi
    FROM scm.delivery_order_items i
    JOIN scm.delivery_orders d ON d.id = i.delivery_order_id
    LEFT JOIN scm.mfg_sales_order_items s ON s.id = i.so_item_id
    WHERE d.company_id = ${CO} AND d.migrated_no_stock = true`;
  const byDoc = new Map();
  for (const it of items) {
    if (!byDoc.has(it.delivery_order_id)) byDoc.set(it.delivery_order_id, []);
    byDoc.get(it.delivery_order_id).push(it);
  }
  return rows.map((d) => {
    const raw = REFS.doToIv[d.linked_ac_docno] ?? [];
    const lines = (byDoc.get(d.id) ?? []).map((i) => {
      const recovered = n(i.unit_price_centi) === 0 && n(i.so_unit_price_centi) > 0;
      return {
        lineId: i.id,
        itemCode: i.item_code,
        qty: n(i.qty),
        unitPriceCenti: recovered ? n(i.so_unit_price_centi) : n(i.unit_price_centi),
        discountCenti: n(i.discount_centi),
        sourceLineKey: i.so_item_id,
        _row: i,
        _priceRecovered: recovered,
      };
    });
    return {
      docNo: d.do_number, acDocNo: d.linked_ac_docno,
      acInvoiceNos: liveInvoices(raw), acCancelledInvoiceNos: deadInvoices(raw),
      /* Rule 5 — same reason as the receipt side: writeSi takes debtor_code from
         whichever delivery sorts first, so a group that disagrees is refused. */
      partyKey: d.debtor_code ?? null,
      lines, _head: d,
    };
  });
}

/* ── Report ───────────────────────────────────────────────────────────────── */

function report(kind, sources, plans, blocked, already, lineIndex) {
  const label = kind === "PI" ? "PURCHASE INVOICES (from migrated goods receipts)"
    : "SALES INVOICES (from migrated delivery orders)";
  log("");
  log(`=== ${label} ===`);
  log(`source documents: ${sources.length}`);

  const writes = plans.filter((p) => p.eligible && !already.has(p.acInvoiceNo));
  const done = plans.filter((p) => already.has(p.acInvoiceNo));

  /* ONE LINE PER PLANNED WRITE. This is the contract: whatever prints here is
     exactly what APPLY inserts, and nothing else is inserted. */
  log(`${APPLY ? "CREATING" : "WOULD CREATE"}: ${writes.length}`);
  for (const p of writes) {
    const recovered = p.sourceDocNos
      .flatMap((d) => lineIndex.get(d) ?? []).filter((l) => l._priceRecovered).length;
    /* A zero-value invoice is called out rather than left to look like a bug:
       AutoCount really did bill RM 0.00 on it, and the gate passed BECAUSE both
       sides agree, not because both are missing. */
    const notes = [
      p.valueCenti === 0 ? "ZERO-VALUE — AutoCount billed RM 0.00 on this invoice too" : null,
      recovered ? `${recovered} line price(s) recovered from the sales order` : null,
    ].filter(Boolean);
    log(`  ${APPLY ? "CREATE" : "WOULD CREATE"} ${p.invoiceNumber}  (AutoCount ${p.acInvoiceNo})  `
      + `${rm(p.valueCenti)}  ${p.lineCount} line(s), ${p.qty} unit(s)  from ${p.sourceDocNos.join(" + ")}`
      + (notes.length ? `  [${notes.join("; ")}]` : ""));
  }
  if (done.length) {
    log(`already mirrored, skipped (idempotent): ${done.length}`);
    for (const p of done.slice(0, 10)) log(`  SKIP ${p.invoiceNumber} — already exists`);
  }

  const byReason = new Map();
  for (const b of blocked) { if (!byReason.has(b.reason)) byReason.set(b.reason, []); byReason.get(b.reason).push(b); }
  const refused = plans.filter((p) => !p.eligible);
  log(`refused: ${blocked.length} source document(s)`);
  for (const [reason, list] of [...byReason.entries()].sort((a, b) => b[1].length - a[1].length)) {
    log(`  ${reason}: ${list.length}`);
    for (const b of list.slice(0, reason === "total_disagrees_with_autocount" ? 25 : 8)) {
      const both = b.acValueCenti === undefined ? ""
        : `  ours ${rm(b.valueCenti)} vs AutoCount ${b.acValueCenti < 0 ? "(no total)" : rm(b.acValueCenti)}`;
      log(`     ${b.docNo}${b.acDocNo ? ` (AutoCount ${b.acDocNo})` : ""}`
        + `${b.acInvoiceNos.length ? ` -> ${b.acInvoiceNos.join(", ")}` : ""}${both}`);
    }
    if (list.length > (reason === "total_disagrees_with_autocount" ? 25 : 8)) {
      log(`     ... and ${list.length - (reason === "total_disagrees_with_autocount" ? 25 : 8)} more`);
    }
  }

  /* Rule 4 of the brief, reported explicitly rather than left inside a bucket
     count: which of our documents AutoCount never invoiced. */
  const never = sources.filter((s) => s.acDocNo && liveInvoices(REFS[kind === "PI" ? "grToPi" : "doToIv"][s.acDocNo]).length === 0);
  log(`AutoCount never invoiced these ${never.length} document(s) — they get no invoice here:`);
  for (const s of never.slice(0, 60)) log(`     ${s.docNo} (AutoCount ${s.acDocNo})`);
  if (never.length > 60) log(`     ... and ${never.length - 60} more`);

  return { writes, refusedPlans: refused };
}

/* ── Writers ──────────────────────────────────────────────────────────────── */

/**
 * Which AutoCount invoices this ERP has already mirrored — the idempotency read.
 *
 * Migration 0280 adds the two columns. Before it is applied there are no mirrors
 * by definition, and a DRY-RUN must still be runnable then (that is the whole
 * point of reviewing the plan before the migration ships). The absence is
 * DETECTED and ANNOUNCED rather than caught and swallowed: a query that failed
 * for some other reason must not read as "nothing exists yet", because that is
 * the difference between skipping a duplicate and creating one.
 */
async function existingMirrors(table) {
  const [{ present }] = await sql`
    SELECT COUNT(*)::int AS present FROM information_schema.columns
    WHERE table_schema = 'scm' AND table_name = ${table} AND column_name = 'migrated_no_stock'`;
  if (!present) {
    log(`  NOTE: scm.${table}.migrated_no_stock does not exist yet (migration 0280 not applied), `
      + `so nothing has been mirrored and APPLY would refuse to run.`);
    return null;
  }
  const rows = await sql.unsafe(
    `SELECT linked_ac_docno FROM scm.${table} WHERE company_id = ${CO} AND migrated_no_stock = true`);
  return new Set(rows.map((r) => r.linked_ac_docno).filter(Boolean));
}

async function writePi(plan, lineIndex, headIndex) {
  const meta = REFS.piMeta[plan.acInvoiceNo] ?? {};
  const lines = plan.sourceDocNos.flatMap((d) => lineIndex.get(d) ?? []);
  const head = headIndex.get(plan.sourceDocNos[0]);
  await sql.begin(async (tx) => {
    const [h] = await tx`
      INSERT INTO scm.purchase_invoices
        (invoice_number, invoice_date, supplier_id, purchase_order_id, grn_id, status,
         currency, exchange_rate, subtotal_centi, tax_centi, total_centi, paid_centi,
         company_id, created_by, notes, migrated_no_stock, linked_ac_docno)
      VALUES (${plan.invoiceNumber}, ${meta.date || head.received_at || new Date().toISOString().slice(0, 10)},
              ${head.supplier_id}, ${head.purchase_order_id}, ${head.id}, 'POSTED',
              ${head.currency || 'MYR'}, ${head.exchange_rate ?? 1},
              ${plan.valueCenti}, 0, ${plan.valueCenti}, 0,
              ${CO}, ${SYS_USER},
              ${`Carried over from AutoCount ${plan.acInvoiceNo}`}, true, ${plan.acInvoiceNo})
      RETURNING id`;
    const rows = lines.map((l) => ({
      purchase_invoice_id: h.id, grn_item_id: l._row.id, company_id: CO,
      material_kind: l._row.material_kind, material_code: l._row.material_code,
      material_name: l._row.material_name, item_group: l._row.item_group,
      description: l._row.description, description2: l._row.description2,
      uom: l._row.uom ?? 'UNIT', qty: l.qty, unit_price_centi: l.unitPriceCenti,
      discount_centi: l.discountCenti ?? 0,
      line_total_centi: Math.max(0, l.qty * l.unitPriceCenti - (l.discountCenti ?? 0)),
      variants: l._row.variants, gap_inches: l._row.gap_inches,
      divan_height_inches: l._row.divan_height_inches, divan_price_sen: l._row.divan_price_sen ?? 0,
      leg_height_inches: l._row.leg_height_inches, leg_price_sen: l._row.leg_price_sen ?? 0,
      custom_specials: l._row.custom_specials, line_suffix: l._row.line_suffix,
      special_order_price_sen: l._row.special_order_price_sen ?? 0,
    }));
    await tx`INSERT INTO scm.purchase_invoice_items ${tx(rows)}`;
    /* Consume the receipt lines so they drop out of the outstanding picker —
       the same bookkeeping the route's recomputeGrnInvoiced does. */
    for (const l of lines) {
      await tx`UPDATE scm.grn_items SET invoiced_qty = COALESCE(invoiced_qty,0) + ${l.qty} WHERE id = ${l._row.id}`;
    }
  });
}

async function writeSi(plan, lineIndex, headIndex) {
  const meta = REFS.ivMeta[plan.acInvoiceNo] ?? {};
  const lines = plan.sourceDocNos.flatMap((d) => lineIndex.get(d) ?? []);
  const head = headIndex.get(plan.sourceDocNos[0]);
  await sql.begin(async (tx) => {
    const [h] = await tx`
      INSERT INTO scm.sales_invoices
        (invoice_number, invoice_date, delivery_order_id, so_doc_no, debtor_code, debtor_name,
         status, currency, subtotal_centi, discount_centi, tax_centi, total_centi,
         local_total_centi, paid_centi, line_count, company_id, created_by, note,
         migrated_no_stock, linked_ac_docno)
      VALUES (${plan.invoiceNumber}, ${meta.date || head.do_date || new Date().toISOString().slice(0, 10)},
              ${head.id}, ${head.so_doc_no}, ${head.debtor_code}, ${head.debtor_name ?? head.debtor_code ?? '(unknown)'},
              'SENT', ${head.currency || 'MYR'}, ${plan.valueCenti}, 0, 0, ${plan.valueCenti},
              ${plan.valueCenti}, 0, ${lines.length}, ${CO}, ${SYS_USER},
              ${`Carried over from AutoCount ${plan.acInvoiceNo}`}, true, ${plan.acInvoiceNo})
      RETURNING id`;
    const rows = lines.map((l, i) => ({
      sales_invoice_id: h.id, do_item_id: l._row.id, company_id: CO, line_no: i + 1,
      item_code: l._row.item_code, item_group: l._row.item_group,
      description: l._row.description, description2: l._row.description2,
      uom: l._row.uom ?? 'UNIT', qty: l.qty, unit_price_centi: l.unitPriceCenti,
      discount_centi: l.discountCenti ?? 0,
      line_total_centi: Math.max(0, l.qty * l.unitPriceCenti - (l.discountCenti ?? 0)),
      unit_cost_centi: n(l._row.unit_cost_centi),
      line_cost_centi: n(l._row.unit_cost_centi) * l.qty,
      variants: l._row.variants, gap_inches: l._row.gap_inches,
      divan_height_inches: l._row.divan_height_inches, divan_price_sen: l._row.divan_price_sen ?? 0,
      leg_height_inches: l._row.leg_height_inches, leg_price_sen: l._row.leg_price_sen ?? 0,
      custom_specials: l._row.custom_specials, line_suffix: l._row.line_suffix,
      special_order_price_sen: l._row.special_order_price_sen ?? 0,
    }));
    await tx`INSERT INTO scm.sales_invoice_items ${tx(rows)}`;
  });
}

/* ── Main ─────────────────────────────────────────────────────────────────── */

async function run(kind) {
  const sources = kind === "PI" ? await loadGrnSources() : await loadDoSources();
  const already = await existingMirrors(kind === "PI" ? "purchase_invoices" : "sales_invoices");
  const lineIndex = new Map(sources.map((s) => [s.docNo, s.lines.filter((l) => l.qty > 0)]));
  const headIndex = new Map(sources.map((s) => [s.docNo, s._head]));
  const { plans, blocked } = planMigratedInvoices(sources, acTotals);
  /* A null here means migration 0280 has not run. Planning and reporting are
     still meaningful (that is the review the dry-run exists for); WRITING is
     not, because the columns that mark a row migrated do not exist yet. */
  if (APPLY && already === null) {
    console.error("REFUSING TO APPLY: migration 0280 has not been applied — "
      + "scm.purchase_invoices/sales_invoices have no migrated_no_stock column, so an invoice "
      + "written now could not be marked as carried over and WOULD post to the GL.");
    process.exit(3);
  }
  const { writes } = report(kind, sources, plans, blocked, already ?? new Set(), lineIndex);

  if (!APPLY) return writes.length;
  for (const p of writes) {
    if (kind === "PI") await writePi(p, lineIndex, headIndex);
    else await writeSi(p, lineIndex, headIndex);
    log(`  CREATED ${p.invoiceNumber}`);
  }
  return writes.length;
}

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"} kind=${KIND}  (AutoCount map exported ${REFS._exportedAt ?? "?"})`);
  let total = 0;
  if (KIND === "pi" || KIND === "both") total += await run("PI");
  if (KIND === "do" || KIND === "si" || KIND === "both") total += await run("SI");
  log("");
  log(APPLY
    ? `APPLIED — ${total} invoice(s) created. No inventory movement and no journal entry was written in either mode.`
    : `DRY-RUN — ${total} invoice(s) would be created. Set APPLY=1 to write. `
      + `No inventory movement and no journal entry is written in either mode.`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
