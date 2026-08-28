#!/usr/bin/env node
// Put the REAL purchase-invoice price on purchase lines that carry no price.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS WRITES, AND WHAT IT DELIBERATELY DOES NOT
// ─────────────────────────────────────────────────────────────────────────────
// WRITES:  scm.purchase_order_items.unit_price_sen
//          scm.grn_items.unit_price_sen
//          ...only where the line is blank (0/NULL) today.
//
// DOES NOT WRITE: scm.inventory_lots.unit_cost_sen — and that is a finding, not
// an oversight. Every zero-cost cutover layer was matched to its OWN receipt's
// purchase invoice; that invoice almost always says 0.00 too. The split is
// MEASURED at runtime below (and pinned by tests/invoiceRealCost.node.mjs) rather
// than quoted from memory, so it can never go stale. Reading the actual invoice
// cannot cost those layers. The only way to put a number on them is to borrow a
// price from a DIFFERENT document — inference — which is exactly what this lane
// replaces. So we refuse, and we report them. A blank is visible; a plausible
// wrong number is silent forever.
//
// ─────────────────────────────────────────────────────────────────────────────
// IS THIS COSTING? BE HONEST: NO. IT IS THE PREREQUISITE FOR IT.
// ─────────────────────────────────────────────────────────────────────────────
// A migrated GRN (migrated_no_stock) posts no movement, so it opens no FIFO lot,
// so recostFromGrn returns at recost.ts:398 (`if (!lots || lots.length === 0)
// return;`) before touching anything — and the cutover stock's lots carry
// source_doc_type 'AC_CUTOVER', which that function's `.eq('source_doc_type',
// 'GRN')` filter can never match. Writing a price onto a migrated GRN line moves
// no stock value today.
//
// What it DOES do is stop the owner's requested GR -> PI conversion from writing
// a wave of zero-value invoices. A PI built from a GRN copies grn_items.
// unit_price_sen; a blank one produces a POSTED purchase invoice worth RM 0
// that books no AP entry, consumes the GRN line's invoiceable quantity, and can
// only be undone by cancelling it. Pricing the line first is what makes that
// conversion correct. For any receipt posted from here on, the same price also
// becomes the lot's real cost (grns.ts:506-507 -> the FIFO trigger).
//
// ─────────────────────────────────────────────────────────────────────────────
// SAFETY
// ─────────────────────────────────────────────────────────────────────────────
//   · DRY-RUN by default. APPLY=1 writes.
//   · Fills blanks only — never overwrites a hand-entered price.
//   · RE-RUN: inert. The UPDATE re-asserts COALESCE(unit_price_sen,0)=0 in its
//     own WHERE, so a line this run priced is no longer a candidate and a second
//     run plans and writes nothing for it.
//   · Idempotent: once written, the line is no longer a candidate.
//   · AMBIGUOUS keys (several distinct invoice prices) are LEFT BLANK and listed.
//   · The dry-run prints ONE LINE PER PLANNED WRITE, each naming the PI document
//     the price came from, so APPLY can hold no surprises. (The 2026-08-10
//     precedent, backfill-zero-cost-lots.mjs, printed only its first 20 planned
//     writes — a dry-run that does not show what APPLY will do is the worst
//     defect class in this project.)
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import {
  buildAcToErp, buildPriceIndex, resolvePrice, planWrite,
  buildGrPriceIndex, measureLayerCostability,
} from "./lib/invoice-price-core.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
/* This writes a PRICE onto purchase and GRN lines, and a purchase invoice built
   from a priced line books AP against it — reverting the commit does not take
   the number back out. stamp-real-po-costs.yml already passes CONFIRM through;
   until now nothing read it. */
const CONFIRM_PHRASE = "I HAVE REVIEWED THE DRY-RUN";
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`APPLY=1 requires CONFIRM="${CONFIRM_PHRASE}" — refusing to write.`);
  process.exit(2);
}
const CO = Number(process.env.COMPANY_ID ?? 1);
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const rm = (c) => `RM${(c / 100).toFixed(2)}`;

function parseCsv(text) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  const head = lines.shift().split(",");
  return lines.map((ln) => {
    const out = []; let cur = ""; let q = false;
    for (let i = 0; i < ln.length; i++) {
      const c = ln[i];
      if (q) { if (c === '"') { if (ln[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true;
      else if (c === ",") { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur);
    return Object.fromEntries(head.map((h, i) => [h.trim(), out[i]]));
  });
}

async function schemaOf(table) {
  const [r] = await sql`
    SELECT table_schema FROM information_schema.tables
     WHERE table_name = ${table} AND table_schema IN ('scm','public')
     ORDER BY CASE table_schema WHEN 'scm' THEN 0 ELSE 1 END LIMIT 1`;
  if (!r) { log(`FATAL — table ${table} not found in scm or public.`); await sql.end(); process.exit(3); }
  return r.table_schema;
}

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"} company_id=${CO}`);

  const payload = JSON.parse(
    zlib.gunzipSync(fs.readFileSync(path.join(here, "data", "ac-invoice-prices.json.gz")))
      .toString("utf8").replace(/^﻿/, ""));
  /* Invoice prices move in the book daily. Same trap as docs/bugs/0560/0561:
     a checkout gives the file a fresh mtime while its content ages — the only
     honest age is the generatedAt inside it, and a printed date nobody reads
     is not a guard. Regenerate with export-ac-invoice-prices.py. */
  const ageDays = (Date.now() - new Date(payload.generatedAt).getTime()) / 86400000;
  if (!(ageDays <= 2)) {
    log(`REFUSED: ac-invoice-prices.json.gz was generated ${payload.generatedAt} (${ageDays.toFixed(1)} days ago). Re-export it first.`);
    process.exit(2);
  }
  const acToErp = buildAcToErp(parseCsv(
    fs.readFileSync(path.join(here, "data", "autocount-erp-mapping-1561.csv"), "utf8")));
  const idx = buildPriceIndex(payload.rows, acToErp);
  log(`invoice extract: ${payload.rows.length} AutoCount PO lines, generated ${payload.generatedAt}`);
  log(`extract control: PO already priced ${payload.control.poAlreadyPriced}, invoice agrees ${payload.control.agree}, differs ${payload.control.differ}`);
  log(`price index: ${idx.size} (AutoCount PO, ERP item) keys carrying at least one invoice price`);
  log(`AC->ERP item map: ${acToErp.size} codes`);

  const sPo = await schemaOf("purchase_orders");
  const sPoI = await schemaOf("purchase_order_items");
  const sGrn = await schemaOf("grns");
  const sGrnI = await schemaOf("grn_items");
  const sLot = await schemaOf("inventory_lots");

  // ── candidates ────────────────────────────────────────────────────────────
  const poLines = await sql.unsafe(`
    SELECT i.id, i.unit_price_sen, i.item_code, p.po_number, p.linked_ac_docno
      FROM "${sPoI}"."purchase_order_items" i
      JOIN "${sPo}"."purchase_orders" p ON p.id = i.purchase_order_id
     WHERE p.company_id = ${CO} AND p.linked_ac_docno IS NOT NULL
     ORDER BY p.po_number, i.item_code`);

  const grnLines = await sql.unsafe(`
    SELECT gi.id, gi.unit_price_sen, gi.item_code, g.grn_number,
           g.migrated_no_stock, p.po_number, p.linked_ac_docno
      FROM "${sGrnI}"."grn_items" gi
      JOIN "${sGrn}"."grns" g ON g.id = gi.grn_id
      JOIN "${sPo}"."purchase_orders" p ON p.id = g.purchase_order_id
     WHERE g.company_id = ${CO} AND p.linked_ac_docno IS NOT NULL
     ORDER BY g.grn_number, gi.item_code`);

  log(`candidates: ${poLines.length} PO lines, ${grnLines.length} GRN lines (company ${CO}, AutoCount-linked)`);

  const plan = { po: [], grn: [] };
  const skip = { po: {}, grn: {} };
  const ambiguous = [];
  const bump = (o, k) => { o[k] = (o[k] ?? 0) + 1; };

  for (const [kind, rows, docOf] of [
    ["po", poLines, (r) => r.po_number],
    ["grn", grnLines, (r) => r.grn_number],
  ]) {
    for (const r of rows) {
      const res = resolvePrice(idx, r.linked_ac_docno, r.item_code);
      const p = planWrite(r.unit_price_sen, res);
      if (p.action === "WRITE") {
        plan[kind].push({
          id: r.id, doc: docOf(r), acPo: r.linked_ac_docno, code: r.item_code,
          centi: p.priceSen, piNo: res.piNo, piDate: res.piDate, grNo: res.grNo,
          desc2: res.desc2, migrated: r.migrated_no_stock ?? null,
        });
      } else {
        bump(skip[kind], p.reason);
        if (p.reason === "SKIP_AMBIGUOUS") {
          ambiguous.push({
            kind, doc: docOf(r), acPo: r.linked_ac_docno, code: r.item_code,
            prices: res.prices, sources: res.sources,
          });
        }
      }
    }
  }

  // ── the plan, one line per planned write ─────────────────────────────────
  for (const kind of ["po", "grn"]) {
    const label = kind === "po" ? "PURCHASE ORDER LINES" : "GRN LINES";
    log(`\n═══ ${label} — ${plan[kind].length} planned write${plan[kind].length === 1 ? "" : "s"} ═══`);
    for (const w of plan[kind]) {
      log(`WRITE ${kind} ${w.doc} [${w.acPo}] ${w.code} : blank -> ${rm(w.centi)}  from ${w.piNo}${w.piDate ? ` (${w.piDate})` : ""} via ${w.grNo ?? "?"}`);
    }
    const s = skip[kind];
    log(`-- skipped: already priced ${s.SKIP_ALREADY_PRICED ?? 0}, ambiguous ${s.SKIP_AMBIGUOUS ?? 0}, no invoice price ${s.SKIP_NO_INVOICE_PRICE ?? 0}, zero price ${s.SKIP_ZERO_PRICE ?? 0}`);
  }

  log(`\n═══ AMBIGUOUS — LEFT BLANK ON PURPOSE (${ambiguous.length}) ═══`);
  for (const a of ambiguous) {
    log(`AMBIGUOUS ${a.kind} ${a.doc} [${a.acPo}] ${a.code} : ${a.prices.map(rm).join(" | ")} from ${a.sources.map((x) => x.piNo).join(" | ")} — needs a human`);
  }

  const totalPo = plan.po.reduce((s, w) => s + w.centi, 0);
  const totalGrn = plan.grn.reduce((s, w) => s + w.centi, 0);
  log(`\nplanned writes: ${plan.po.length} PO lines (unit-price total ${rm(totalPo)}), ${plan.grn.length} GRN lines (unit-price total ${rm(totalGrn)})`);

  // ── the lots we refuse to touch, and why ─────────────────────────────────
  const [lots] = await sql.unsafe(`
    SELECT COUNT(*)::int AS n, COALESCE(SUM(qty_remaining),0)::int AS units
      FROM "${sLot}"."inventory_lots"
     WHERE company_id = ${CO} AND source_doc_type = 'AC_CUTOVER'
       AND (unit_cost_sen = 0 OR unit_cost_sen IS NULL) AND qty_remaining > 0`);
  // Why we refuse, measured here rather than asserted: match every zero-cost
  // cutover layer to the invoice for its OWN receipt and count what comes back.
  const layers = JSON.parse(
    zlib.gunzipSync(fs.readFileSync(path.join(here, "data", "ac-stock-layers.json.gz")))
      .toString("utf8").replace(/^﻿/, ""))
    .filter((l) => !/SOFA/i.test(l.ItemCode || "")); // whole-sofa balances were never imported
  const m = measureLayerCostability(layers, buildGrPriceIndex(payload.rows));

  log(`\n═══ NOT TOUCHED: ${lots.n} zero-cost AC_CUTOVER lots holding ${lots.units} units (live) ═══`);
  log(`source data holds ${m.total} zero-cost cutover layers / ${m.units} units. Matched to the`);
  log("purchase invoice for their OWN receipt:");
  log(`  own invoice ALSO says 0.00 : ${m.noInvoicePrice}`);
  log(`  layer has no receipt at all: ${m.noSourceDoc}`);
  log(`  ambiguous                  : ${m.ambiguous}`);
  log(`  resolves to a real price   : ${m.resolved.length}`);
  for (const r of m.resolved) {
    log(`    RESOLVABLE ${r.itemCode} @${r.location} qty ${r.qty} via ${r.grNo} -> ${rm(r.centi)} from ${r.piNo}`);
  }
  log(`${m.noInvoicePrice + m.noSourceDoc} of ${m.total} layers have NO truthful number anywhere on the invoice chain.`);
  log("Costing them would mean borrowing a price from a DIFFERENT document — inference —");
  log("which is exactly what this lane replaces. They are left blank and reported.");

  if (!APPLY) {
    log(`\nDRY-RUN — nothing written. Set APPLY=1 to write exactly the ${plan.po.length + plan.grn.length} lines listed above.`);
    await sql.end();
    return;
  }

  let done = 0;
  /* What was actually written, so the verification below re-reads exactly those
     rows rather than re-deriving the plan on the fresh connection. */
  const written = [];
  for (const [kind, table, schema] of [
    ["po", "purchase_order_items", sPoI],
    ["grn", "grn_items", sGrnI],
  ]) {
    for (const w of plan[kind]) {
      // Re-assert the blank in the UPDATE itself, so a concurrent hand-entry
      // between plan and write is never clobbered.
      const res = await sql.unsafe(
        `UPDATE "${schema}"."${table}" SET unit_price_sen = $1
          WHERE id = $2 AND COALESCE(unit_price_sen, 0) = 0`, [w.centi, w.id]);
      if (res.count > 0) { done++; written.push({ schema, table, id: w.id, centi: w.centi, doc: w.doc, code: w.code }); }
      else log(`SKIPPED AT WRITE (no longer blank) ${kind} ${w.doc} ${w.code}`);
    }
  }
  log(`DONE. lines priced: ${done} of ${plan.po.length + plan.grn.length} planned.`);
  await sql.end();

  /* Verify on a SECOND connection. The session that wrote is the worst witness
     that the write landed, and a count would not catch what is actually at risk
     here: a price is money, so the question is not "did N rows change" but "is
     the number on the row the number the invoice said". Asserting the VALUE and
     its type is the only answer to that. */
  if (!written.length) return;
  const check = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  try {
    const wrong = [];
    for (const [schema, table] of [[sPoI, "purchase_order_items"], [sGrnI, "grn_items"]]) {
      const mine = written.filter((w) => w.schema === schema && w.table === table);
      if (!mine.length) continue;
      const back = await check.unsafe(
        `SELECT id::text AS id, unit_price_sen, pg_typeof(unit_price_sen)::text AS t
           FROM "${schema}"."${table}" WHERE id = ANY($1::uuid[])`, [mine.map((w) => w.id)]);
      const seen = new Map(back.map((r) => [r.id, r]));
      log(`VERIFY (fresh connection) ${schema}.${table}: read back ${back.length}/${mine.length}; unit_price_sen type ${back[0]?.t ?? "n/a"}`);
      for (const w of mine) {
        const r = seen.get(String(w.id));
        if (!r) { wrong.push(`${w.doc} ${w.code}: row not readable on a fresh connection`); continue; }
        if (!Number.isInteger(Number(r.unit_price_sen))) { wrong.push(`${w.doc} ${w.code}: unit_price_sen=${r.unit_price_sen} is not an integer`); continue; }
        if (Number(r.unit_price_sen) !== Number(w.centi)) wrong.push(`${w.doc} ${w.code}: wrote ${w.centi} but the row now reads ${r.unit_price_sen}`);
      }
    }
    if (wrong.length) {
      for (const m of wrong.slice(0, 20)) console.error(`VERIFY FAILED: ${m}`);
      console.error(`VERIFY FAILED: ${wrong.length} of ${written.length} priced line(s) do not read back as written.`);
      process.exit(1);
    }
    log(`VERIFY OK - all ${written.length} priced lines read back with the exact price written.`);
  } finally {
    await check.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
