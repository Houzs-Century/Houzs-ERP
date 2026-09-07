#!/usr/bin/env node
// Create the AutoCount paperwork the ERP is missing — goods receipts for POs
// AutoCount already received, and delivery orders for the part of an order
// AutoCount already delivered — WITHOUT moving any stock.
//
// Owner approved the design 2026-08-10: "建这一个模式，GR 和 DO 一起用."
//
// WHY NO MOVEMENTS. On-hand came into the ERP once, through the AutoCount
// balance snapshot. That snapshot already counts every past receipt as IN and
// every past delivery as OUT. A GRN posting an IN here would receive the same
// units twice; a DO posting an OUT would ship them twice. So these documents
// carry the quantities, the links and the dates, and nothing else — the stock
// effect is already in the ledger.
//
// Every row is stamped migrated_no_stock = true (migration 0276). That flag is
// the instruction to every future reconciliation and repair job: this document
// has no movements ON PURPOSE. "Fixing" it doubles the inventory.
//
// BOTH WRITERS COPY item_group AND variants FROM THE PARENT, and the DO writer
// copies description2 too. That is not decoration: an audit or a repair that
// filters `WHERE item_group IN ('sofa','bedframe')` returns NOTHING when the
// column is NULL, and reads the empty set as a clean chain. The DO writer
// originally omitted all three and hid the entire SO -> DO leg for that reason
// (2026-08-11, backfill-do-line-snapshot.mjs repaired the rows it had already
// written). A child document here is a SNAPSHOT of its parent — copy the
// classification with the quantity, always.
//
// SUPERSEDED FOR GOODS RECEIPTS, 2026-09-07. `reshape-migrated-grns.mjs` now owns
// the shape of a migrated goods receipt: one document per (AutoCount receipt x
// purchase order), carrying the book's own receipt date and quantity, because the
// owner ruled the ERP must show the receipts the account book actually made
// (「是 A 的，不过只是把那些需要的搬进来，不需要的不需要搬」). The GRN arm below still
// works and is still idempotent — it skips any purchase order that already has a
// migrated receipt — but what it WRITES is the old one-per-purchase-order shape
// with `received_at = CURRENT_DATE`. Use the reshape writer for goods receipts.
//
// KIND=grn | do | both (default both). DRY-RUN by default; APPLY=1 writes.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
/* The DO matcher and writer live in lib/ so sync-ac-delta.mjs can reuse the
   rule instead of copying it. Moved 2026-09-07; the logic is unchanged. */
import {
  buildMigratedDoPlan, indexSoLines, insertMigratedDo, loadAcErpItemMap,
} from "./lib/migrated-do-writer.mjs";
/* The delivery location goes on the HEADER (owner 2026-09-07, "记在单头就好").
   The map is the SHARED one the PO importer's whId() uses — a second copy of a
   location map is how stock silently moves between branches — and the resolution
   onto a warehouse row is the tested spec of migration 0309's backfill. */
import { mixedLocationDocs, resolveAcDeliveryLocation } from "./lib/ac-do-location.mjs";

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

async function nextSeq(table, col, prefix) {
  const [{ maxno }] = await sql.unsafe(
    `SELECT COALESCE(MAX(${col}), '') AS maxno FROM scm.${table} WHERE company_id = ${CO} AND ${col} LIKE '${prefix}%'`);
  return Number(String(maxno).replace(prefix, "")) || 0;
}

// ── goods receipts for the POs AutoCount already received ────────────────────
async function doGrns() {
  log("═══ GRN — receipts AutoCount already made ═══");
  const lines = await sql`SELECT i.id, i.purchase_order_id, i.item_code, i.material_name,
      i.received_qty, i.unit_price_sen, i.item_group, i.variants, i.warehouse_id,
      p.po_number, p.linked_ac_docno, p.supplier_id, p.purchase_location_id, p.linked_ac_grn_docnos,
      p.currency
    FROM scm.purchase_order_items i JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
    WHERE p.company_id = ${CO} AND p.linked_ac_docno IS NOT NULL AND COALESCE(i.received_qty,0) > 0
    ORDER BY p.po_number, i.id`;
  const done = new Set((await sql`SELECT linked_ac_docno FROM scm.grns
      WHERE company_id = ${CO} AND migrated_no_stock = true AND linked_ac_docno IS NOT NULL`)
    .map((r) => r.linked_ac_docno));

  /* One ERP GRN per PURCHASE ORDER, not per AutoCount GR document: a single
     AutoCount receipt can span several POs, and the ERP's GRN belongs to one
     PO. The AutoCount GR numbers this stands for ride along on the header, so
     the trail back is exact even though the shape differs. */
  const byPo = new Map();
  for (const l of lines) {
    if (!byPo.has(l.purchase_order_id)) byPo.set(l.purchase_order_id, { po: l, items: [] });
    byPo.get(l.purchase_order_id).items.push(l);
  }
  const plan = [...byPo.values()].filter((g) => !done.has(g.po.linked_ac_docno));
  log(`POs with received quantity: ${byPo.size}; already mirrored: ${byPo.size - plan.length}; to create: ${plan.length}`);
  const grnUnits = plan.reduce((s2, g) => s2 + g.items.reduce((t, i) => t + Number(i.received_qty || 0), 0), 0);
  log(`lines: ${plan.reduce((s2, g) => s2 + g.items.length, 0)}; units: ${grnUnits}`);
  if (!plan.length) return;
  for (const g of plan.slice(0, 8)) log(`   ${g.po.po_number} <- ${g.po.linked_ac_docno}: ${g.items.length} line(s), ${g.items.reduce((t, i) => t + Number(i.received_qty || 0), 0)} unit(s)`);
  if (!APPLY) { log("DRY-RUN — set APPLY=1 to create. No inventory movement is written in either mode."); return; }

  /* Migrated documents KEEP AutoCount's number (owner 2026-08-10). A GRN here
     belongs to ONE purchase order while an AutoCount receipt can span several,
     so a bare AC GR number is not always unique: when it covers more than one
     imported PO the ERP number carries the PO too. Either way the number a
     human reads starts from the AutoCount document, not a fresh sequence. */
  /* An AutoCount receipt routinely covers SEVERAL purchase orders while an ERP
     GRN covers ONE, and only the POs belonging to an undelivered sales order
     were imported. Measured on the reference snapshot: of the 187 AutoCount
     receipts touching an imported PO, 118 also cover POs the ERP does not hold
     - GR-000201 receives ten and the ERP holds two of them.

     So the ERP document is legitimately SMALLER than the AutoCount one with the
     same number, and someone reconciling the two will see it. Saying so on the
     document turns a discrepancy into a stated scope. */
  const acPoCount = new Map();   // AutoCount GR doc -> how many POs it receives, AutoCount-side
  try {
    const refs = gz("ac-gr-refs.json.gz");
    const byGr = new Map();
    for (const r of refs) {
      if (!r.GrNo) continue;
      if (!byGr.has(r.GrNo)) byGr.set(r.GrNo, new Set());
      byGr.get(r.GrNo).add(r.PoNo);
    }
    for (const [gr, pos] of byGr) acPoCount.set(gr, pos.size);
  } catch { /* reference snapshot absent: the note simply omits the scope line */ }

  const grnNote = (g) => {
    const acGrs = g.po.linked_ac_grn_docnos ?? [];
    const parts = [`mirrors the AutoCount receipt for ${g.po.linked_ac_docno}`];
    if (acGrs.length) parts[0] += ` (AutoCount GR ${acGrs.join(", ")})`;
    const spans = acGrs.filter((gr) => (acPoCount.get(gr) ?? 1) > 1)
      .map((gr) => `${gr} receives ${acPoCount.get(gr)} purchase orders in AutoCount`);
    if (spans.length) {
      parts.push(`SCOPE: ${spans.join("; ")}; this document covers ONLY ${g.po.linked_ac_docno}, so its quantity is smaller than the AutoCount document of the same number. That is correct, not a shortfall.`);
    }
    parts.push("No stock movement: the units are already on hand from the balance snapshot.");
    return parts.join(" ");
  };

  const grUse = new Map();
  for (const g of plan) for (const gr of (g.po.linked_ac_grn_docnos ?? [])) grUse.set(gr, (grUse.get(gr) ?? 0) + 1);
  let seq = await nextSeq("grns", "grn_number", "HC-GRN-");
  let made = 0;
  for (const g of plan) {
    const acGrs = g.po.linked_ac_grn_docnos ?? [];
    let grnNo;
    if (acGrs.length === 1 && grUse.get(acGrs[0]) === 1) grnNo = "HC-" + acGrs[0];
    else if (acGrs.length >= 1) grnNo = "HC-" + acGrs[0] + "-" + g.po.linked_ac_docno;
    else { seq += 1; grnNo = `HC-GRN-${String(seq).padStart(6, "0")}`; }
    await sql.begin(async (tx) => {
      const [hdr] = await tx`INSERT INTO scm.grns
          (grn_number, purchase_order_id, supplier_id, warehouse_id, status, posted_at, received_at,
           currency, company_id, created_by, notes, migrated_no_stock, linked_ac_docno)
        VALUES (${grnNo}, ${g.po.purchase_order_id}, ${g.po.supplier_id},
                /* THE RECEIPT IS IN THE ORDER'S CURRENCY, not a constant. This
                   is the same rule routes/grns.ts already applies to a GRN raised
                   in the app (resolveGrnFx: "the GRN inherits its currency from
                   the source PO"); the migration writer used to hard-code 'MYR'
                   and so disagreed with the live path on a foreign order.
                   exchange_rate is deliberately NOT set here — the column
                   defaults to 1 and a rate this script invented would be a
                   fabricated one; a real receipt is gated by
                   assertForeignRatePostable instead. */
                ${g.items[0].warehouse_id ?? g.po.purchase_location_id}, 'POSTED', NOW(), CURRENT_DATE, ${g.po.currency ?? "MYR"},
                ${CO}, ${SYS_USER},
                ${grnNote(g)},
                true, ${g.po.linked_ac_docno})
        RETURNING id`;
      for (const it of g.items) {
        await tx`INSERT INTO scm.grn_items
            (grn_id, purchase_order_item_id, material_kind, item_code, material_name, item_group,
             qty_received, qty_accepted, qty_rejected, unit_price_sen, line_total_sen, variants, company_id)
          VALUES (${hdr.id}, ${it.id}, 'mfg_product', ${it.item_code}, ${it.material_name}, ${it.item_group},
                  ${it.received_qty}, ${it.received_qty}, 0, ${it.unit_price_sen},
                  ${Math.round(Number(it.received_qty) * Number(it.unit_price_sen || 0))},
                  ${it.variants ? sql.json(it.variants) : null}, ${CO})`;
      }
    });
    made += 1;
    if (made % 50 === 0) log(`  ..${made}/${plan.length}`);
  }
  log(`DONE. GRNs created: ${made}. No inventory movement written — by design.`);
}

// ── delivery orders for the part AutoCount already delivered ─────────────────
async function doDos() {
  log("");
  log("═══ DO — deliveries AutoCount already made against still-open orders ═══");
  const rows = gz("ac-partial-dos.json.gz");
  const itemMap = loadAcErpItemMap(path.join(here, "data"));

  const done = new Set((await sql`SELECT linked_ac_docno FROM scm.delivery_orders
      WHERE company_id = ${CO} AND migrated_no_stock = true AND linked_ac_docno IS NOT NULL`)
    .map((r) => r.linked_ac_docno));

  /* delivery_orders.debtor_name is NOT NULL - the document is addressed to
     someone. The AutoCount note carries it; where it does not, the sales order
     it delivers does. */
  const soDebtor = new Map((await sql`SELECT doc_no, debtor_name FROM scm.mfg_sales_orders
    WHERE company_id = ${CO} AND linked_ac_docno IS NOT NULL`).map((r) => [r.doc_no, r.debtor_name]));
  /* item_group / variants / description2 are pulled BECAUSE A DELIVERY ORDER IS
     A SNAPSHOT OF THE SALES ORDER AT DISPATCH. The first version of this writer
     named seven columns and copied none of the three, and the failure mode was
     silence: `WHERE item_group IN ('sofa','bedframe')` then matched ZERO
     delivery-order lines corpus-wide, so the whole SO -> DO leg of
     check-sofa-chain-alignment.mjs reported "aligned" while measuring an empty
     set. The GRN writer above always copied them, which is exactly why nobody
     noticed. Do not drop them again. */
  const soItems = await sql`SELECT i.id, i.item_code, i.line_no, i.qty, i.item_group, i.variants,
      i.description2, i.unit_price_sen, i.discount_sen, i.unit_cost_sen,
      h.doc_no, h.linked_ac_docno ac
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL ORDER BY i.line_no`;

  /* The matcher and the writer are lib/migrated-do-writer.mjs, shared with
     sync-ac-delta.mjs. Everything below is reporting. */
  /* allowSubstitution: the owner's 2026-09-07 ruling. A book line naming a code
     the sales order does not carry is CARRIED (marked, unlinked) instead of
     dropped - see lib/migrated-do-writer.mjs. This is the cutover cut, the set
     the ruling was made about. sync-ac-delta.mjs deliberately does NOT enable
     it: that lane is ALL-OR-NOTHING with an over-delivery assertion keyed on
     quantity, so it already REFUSES loudly rather than vanishing a document,
     and turning substitution on there changes what that assertion measures.
     Enabling it there is a separate, reviewed change. */
  const { plan, byDo, stats } = buildMigratedDoPlan({ rows, itemMap, soItems, done, allowSubstitution: true });
  const { soByKey } = indexSoLines(soItems);

  log(`AutoCount delivery lines against open orders: ${rows.length}; unmapped code ${stats.unmapped}; no ERP SO line ${stats.noSoLine}`);
  log(`duplicate-guard: ${stats.exhausted} row(s) skipped for having no unclaimed SO line left; ${stats.collapsed} duplicate line(s) refused`);
  for (const [code, n] of [...stats.missCodes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) log(`   no ERP line for ${code} x${n}`);
  /* A count of misses is not a diagnosis. For the first few, print what the ERP
     order ACTUALLY has on it, so the mismatch is visible instead of inferred. */
  for (const ex of stats.missExamples.slice(0, 5)) {
    const have = (soByKey.get(`${ex.so}|${ex.erp}`) ?? []).length;
    const onOrder = soItems.filter((it) => it.ac === ex.so).map((it) => it.item_code);
    log(`   MISS ${ex.so} wanted "${ex.erp}" (exact hits ${have}); that order's ERP lines: ${onOrder.length ? onOrder.join(" | ") : "(no lines found for this linked_ac_docno)"}`);
  }
  /* ── SUBSTITUTED CODES, NAMED ────────────────────────────────────────────
     Every one of these is a delivery the warehouse made with a different
     product than the order asked for. They are carried, not dropped, and the
     row says so — but a count alone would hide WHICH order now holds a line
     nobody has reconciled, so each is printed with its order and quantity. */
  log("");
  log(`── substituted at dispatch (code not on the order; carried, marked, NOT linked to an order line): ${stats.substituted} line(s) on ${new Set(stats.subLines.map((x) => x.doNo)).size} note(s)`);
  for (const x of stats.subLines) {
    log(`      ${x.doNo} <- ${x.erpSo} (${x.so}): ${x.code}${x.desc ? ` "${x.desc}"` : ""} qty ${x.qty} — AutoCount code ${x.acCode}; that order carries no such line`);
  }
  log("");
  log(`DO documents: ${byDo.size}; already mirrored: ${byDo.size - plan.length}; to create: ${plan.length} (${plan.reduce((s, d) => s + d.items.length, 0)} lines, ${plan.reduce((s, d) => s + d.items.reduce((t, i) => t + i.qty, 0), 0)} units)`);
  for (const d of plan.slice(0, 8)) log(`   ${d.doNo} <- ${d.so}: ${d.items.length} line(s)`);

  /* ── WHAT THE COUNTS ABOVE CANNOT SAY ────────────────────────────────────
     `byDo.size` is the number of documents that produced AT LEAST ONE line, so
     a delivery note whose every line failed to match simply is not in it — it
     is not created, not refused, not counted. There is no number anywhere in
     this run that goes down when that happens.

     Measured on production 2026-09-07 (run 34129497431): the cut holds 84
     delivery notes, this line printed "DO documents: 82", and DO-001800 and
     DO-005583 had silently ceased to exist. The AutoCount vs ERP reconcile
     then reported them as "(owner-declined)" — a gap printed as a decision,
     which is the failure mode this whole family of scripts exists to prevent.
     Both are un-cancelled, both deliver against orders with lines still
     outstanding, and both name an item code their sales order does not carry.

     The second shape is worse because it is silent on BOTH sides: a note whose
     OTHER lines matched IS created, short of the lines that did not. DO-001953
     is the live one — 4 lines in the book, 2 written — and the two it lost were
     its only lines with a quantity, so create-migrated-invoices refused its
     sales invoice as `nothing_to_invoice` and I-2411-0323 never came in either.

     Neither shape is fixed here, deliberately: matching a delivery line to a
     sales-order line it does not name is a JUDGEMENT about a substitution, and
     inventing that link is computing, not copying. What is fixed is that the
     run now SAYS so, per document, so the number is a finding and not a
     silence. */
  const short = [];
  const vanished = [];
  for (const [doNo, d] of stats.byDoc) {
    if (!d.dropped.length) continue;
    (d.kept === 0 ? vanished : short).push({ doNo, ...d });
  }
  log("");
  log(`── delivery notes this run could not carry WHOLE: ${vanished.length + short.length} of ${stats.byDoc.size} in the cut`);
  log(`   NOT CREATED AT ALL (every book line unmatched, so the document does not reach the ERP): ${vanished.length}`);
  for (const v of vanished) {
    log(`      ${v.doNo}: 0 of ${v.bookLines} line(s) matched — the ERP will have NO delivery for this AutoCount note`);
    for (const x of v.dropped) log(`         ${x.code}${x.desc ? ` "${x.desc}"` : ""} qty ${x.qty ?? "-"} <- ${x.so}: ${x.why}`);
  }
  log(`   CREATED SHORT (some lines written, some dropped — the document exists but is incomplete): ${short.length}`);
  for (const s of short) {
    log(`      ${s.doNo}: ${s.kept} of ${s.bookLines} line(s) written, ${s.dropped.length} dropped`);
    for (const x of s.dropped) log(`         ${x.code}${x.desc ? ` "${x.desc}"` : ""} qty ${x.qty ?? "-"} <- ${x.so}: ${x.why}`);
  }

  /* ── CONSERVATION, ASSERTED ──────────────────────────────────────────────
     The defect this whole section exists for was not a wrong number, it was a
     MISSING one: `byDo.size` counted the documents that survived, so the two
     that did not were absent from every total and nothing went down. A count
     nothing is subtracted from cannot be checked. So the run now closes the
     books out loud: every delivery note in the cut is either a document the ERP
     will hold, or it is NAMED above with the reason. If those two do not add
     up, the arithmetic says so here rather than a reconcile saying it in three
     weeks' time. */
  const bookDocs = stats.byDoc.size;
  const reachEbook = byDo.size + vanished.length;
  log("");
  log(`── conservation: ${bookDocs} delivery note(s) in the cut = ${byDo.size} reaching the ERP + ${vanished.length} named as NOT created`);
  if (reachEbook !== bookDocs) {
    log(`::error::CONSERVATION FAILED — ${bookDocs} note(s) in, ${reachEbook} accounted for. ${bookDocs - reachEbook} delivery note(s) are unaccounted for. Do NOT apply this run; a document is disappearing without being named.`);
    process.exitCode = 1;
    return;
  }
  const bookLines = [...stats.byDoc.values()].reduce((t, d) => t + d.bookLines, 0);
  const keptLines = [...stats.byDoc.values()].reduce((t, d) => t + d.kept, 0);
  const dropLines = [...stats.byDoc.values()].reduce((t, d) => t + d.dropped.length, 0);
  log(`── conservation: ${bookLines} book line(s) = ${keptLines} carried (${stats.substituted} of them substituted) + ${dropLines} named as dropped`);
  if (keptLines + dropLines !== bookLines) {
    log(`::error::CONSERVATION FAILED — ${bookLines} book line(s) in, ${keptLines + dropLines} accounted for. Do NOT apply this run.`);
    process.exitCode = 1;
    return;
  }
  log("");
  if (!APPLY) { log("DRY-RUN — set APPLY=1 to create. No inventory movement is written in either mode."); return; }

  /* ── THE DELIVERY LOCATION, ONTO THE HEADER ──────────────────────────────
     The book's own header field first; where the header snapshot runs behind
     the book, the document's own lines and ONLY when they agree unanimously.
     Anything else stays NULL and is NAMED — an unresolved location must be
     visibly absent, never a company-blind default, because a wrong warehouse
     reads as another branch's stock. backfill-migrated-do-warehouse.mjs applies
     the same rule to the documents already written. */
  const hdrLoc = new Map();
  for (const h of gz("ac-fidelity-do-headers.json.gz")) {
    const v = (h.SalesLocation || "").trim();
    if (v) hdrLoc.set(h.DocNo, v);
  }
  const lineLocs = new Map();
  for (const r of rows) {
    const v = (r.Location || "").trim();
    if (!v) continue;
    if (!lineLocs.has(r.DoNo)) lineLocs.set(r.DoNo, new Set());
    lineLocs.get(r.DoNo).add(v);
  }
  const warehouses = await sql`SELECT id, code, name FROM scm.warehouses WHERE company_id = ${CO}`;
  const mixedDocs = mixedLocationDocs(lineLocs);
  log(`── delivery location: documents in this cut whose lines span TWO locations: ${mixedDocs.length}`);
  for (const m of mixedDocs) log(`      MIXED ${m.doc}: lines say ${m.locations.join(" + ")}; header says ${hdrLoc.get(m.doc) ?? "(no header row)"} — the header wins, recorded as not unanimous`);

  // one AutoCount delivery note = one ERP DO, so the number carries over intact
  let made = 0;
  let noWh = 0;
  for (const d of plan) {
    const where = resolveAcDeliveryLocation(d.doNo, hdrLoc, lineLocs, warehouses);
    if (!where.warehouseId) { noWh += 1; log(`   ${d.doNo}: no delivery warehouse stamped — ${where.why}`); }
    await insertMigratedDo(sql, d, { companyId: CO, sysUser: SYS_USER, debtorFallback: soDebtor.get(d.so) ?? null,
      warehouseId: where.warehouseId, salesLocation: where.salesLocation });
    made += 1;
  }
  log(`delivery warehouse stamped on ${made - noWh} of ${made} new document(s); ${noWh} left NULL and named above`);
  log(`DONE. DOs created: ${made}. No inventory movement written — by design.`);
}

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"} kind=${KIND}`);
  if (KIND === "grn" || KIND === "both") await doGrns();
  if (KIND === "do" || KIND === "both") await doDos();
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
