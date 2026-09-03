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
// KIND=grn | do | both (default both). DRY-RUN by default; APPLY=1 writes.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const KIND = (process.env.KIND || "both").toLowerCase();
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const CO = 1;
const SYS_USER = "00000000-0000-4000-8000-000000000001";
const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");
const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", f))).toString("utf8").replace(/^﻿/, ""));

function parseCsvLine(line) {
  const out = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) { const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c; } }
  out.push(cur); return out;
}

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
      p.po_number, p.linked_ac_docno, p.supplier_id, p.purchase_location_id, p.linked_ac_grn_docnos
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
                ${g.items[0].warehouse_id ?? g.po.purchase_location_id}, 'POSTED', NOW(), CURRENT_DATE, 'MYR',
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
  const csv = fs.readFileSync(path.join(here, "data", "autocount-erp-mapping-1561.csv"), "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  csv.shift();
  const byAc = new Map();
  for (const ln of csv) { const f = parseCsvLine(ln); if (f[0]) byAc.set(norm(f[0]), (f[1] || "").trim()); }

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
     set. The GRN writer above (:145) always copied them, which is exactly why
     nobody noticed. Do not drop them again. */
  const soItems = await sql`SELECT i.id, i.item_code, i.line_no, i.qty, i.item_group, i.variants,
      i.description2, i.unit_price_sen, i.discount_sen, i.unit_cost_sen,
      h.doc_no, h.linked_ac_docno ac
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL ORDER BY i.line_no`;
  const soByKey = new Map();
  const soByModel = new Map();
  for (const it of soItems) {
    const code = norm(it.item_code);
    const k = `${it.ac}|${code}`;
    if (!soByKey.has(k)) soByKey.set(k, []);
    soByKey.get(k).push(it);
    /* A sofa arrives in the ERP as one line per COMPARTMENT, so an AutoCount
       delivery line naming the whole model can never match a code. Index the
       build by its model prefix as well, exactly as the photo importer does. */
    const dash = code.indexOf("-");
    if (dash < 0) continue;
    const mk = `${it.ac}|${code.slice(0, dash)}`;
    if (!soByModel.has(mk)) soByModel.set(mk, []);
    soByModel.get(mk).push(it);
  }
  const sofaModelOf = (erp) => {
    const ALIAS = { "5530": "9028", "5536": "9058", "5537": "8030", "5540": "8030" };
    const m = (erp || "").replace(/-1S$/i, "").toUpperCase();
    return ALIAS[m] || m;
  };

  const byDo = new Map();
  let noSoLine = 0, unmapped = 0, exhausted = 0, collapsed = 0;
  const missExamples = [];
  const missCodes = new Map(); // a silent miss count hid this same class of bug twice already
  /* TWO WAYS THIS WRITER INSERTED THE SAME DELIVERY LINE TWICE, both fixed here.
     Measured on production 2026-08-11: 8 migrated documents, 18 surplus lines,
     every one an EXACT duplicate of its twin - same item, same qty, same
     so_item_id - so they are a double INSERT, not two real AutoCount lines.

       1. `targets` took cands[0] unconditionally, so a SECOND AutoCount row of
          the same item code on the same order produced a second delivery line
          pointing at the FIRST sales-order line. Consuming the candidates in
          order fixes the duplicate AND the mis-link underneath it: two rows of
          one code are two deliveries against two different lines.
       2. the sofa branch re-pushed EVERY compartment of a build each time
          another AutoCount row named the same model, multiplying a 3-piece
          sofa by however many rows AutoCount wrote.

     HC-SO-001920 is the visible one: 1 unit ordered, 4 delivery lines. */
  const taken = new Map();      // `DoNo|SoNo|code`  -> candidate SO lines already claimed
  const modelDone = new Set();  // `DoNo|SoNo|model` -> the whole build is already on this DO
  for (const r of rows) {
    const erp = byAc.get(norm(r.ItemCode));
    if (!erp) { unmapped++; continue; }
    /* Exact code first, then the build's compartment lines. A sofa AutoCount
       shipped as one whole unit corresponds to EVERY compartment of that build
       here, so all of them are marked delivered - otherwise the pieces stay
       outstanding and the set can be shipped a second time. */
    const cands = soByKey.get(`${r.SoNo}|${norm(erp)}`) ?? [];
    let targets = null;
    if (cands.length) {
      const ck = `${r.DoNo}|${r.SoNo}|${norm(erp)}`;
      const used = taken.get(ck) ?? 0;
      /* Out of distinct sales-order lines to claim. Reusing one is what created
         the duplicates, so the row is skipped and counted LOUDLY instead - the
         same choice backfill-ac-line-keys.mjs makes when a group's counts
         disagree, and for the same reason: a wrong link is worse than none. */
      if (used >= cands.length) { exhausted++; continue; }
      taken.set(ck, used + 1);
      targets = [cands[used]];
    } else {
      const mk = `${r.DoNo}|${r.SoNo}|${sofaModelOf(erp)}`;
      if (modelDone.has(mk)) { collapsed++; continue; }
      const pieces = soByModel.get(`${r.SoNo}|${sofaModelOf(erp)}`);
      if (pieces && pieces.length) { modelDone.add(mk); targets = pieces; }
    }
    if (!targets || !targets.length) {
      noSoLine++;
      missCodes.set(erp, (missCodes.get(erp) ?? 0) + 1);
      if (missExamples.length < 5) missExamples.push({ so: r.SoNo, erp: norm(erp) });
      continue;
    }
    if (!byDo.has(r.DoNo)) byDo.set(r.DoNo, { doNo: r.DoNo, date: r.DoDate, so: targets[0].doc_no,
      debtorCode: r.DebtorCode || null, debtorName: (r.DebtorName || "").trim() || null, items: [] });
    for (const t of targets) {
      byDo.get(r.DoNo).items.push({ code: t.item_code, name: r.LineDesc, qty: Math.round(Number(r.Qty || 0)),
        soItemId: t.id, group: t.item_group ?? null, variants: t.variants ?? null, desc2: t.description2 ?? null,
        /* The MONEY, from the same row the normal create path reads it from.
           Omitted until docs/bugs/0617-the-migrated-delivery-orders-carried-no-money-at-all.md
           while the GRN writer above always carried it. */
        unitPriceSen: t.unit_price_sen ?? 0, discountSen: t.discount_sen ?? 0, unitCostSen: t.unit_cost_sen ?? 0 });
    }
  }
  /* The invariant, asserted rather than inferred. Whatever the mapping above
     decides, one document may not carry the same sales-order line at the same
     quantity twice. The two fixes above remove the known causes; this refuses
     the SHAPE, so a future mapping path cannot reintroduce it silently. */
  for (const d of byDo.values()) {
    const seen = new Set(); const keep = [];
    for (const it of d.items) {
      const k = `${it.soItemId}|${norm(it.code)}|${it.qty}`;
      if (seen.has(k)) { collapsed++; continue; }
      seen.add(k); keep.push(it);
    }
    d.items = keep;
  }

  const plan = [...byDo.values()].filter((d) => !done.has(d.doNo));
  log(`AutoCount delivery lines against open orders: ${rows.length}; unmapped code ${unmapped}; no ERP SO line ${noSoLine}`);
  log(`duplicate-guard: ${exhausted} row(s) skipped for having no unclaimed SO line left; ${collapsed} duplicate line(s) refused`);
  for (const [code, n] of [...missCodes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) log(`   no ERP line for ${code} x${n}`);
  /* A count of misses is not a diagnosis. For the first few, print what the ERP
     order ACTUALLY has on it, so the mismatch is visible instead of inferred. */
  for (const ex of missExamples.slice(0, 5)) {
    const have = (soByKey.get(`${ex.so}|${ex.erp}`) ?? []).length;
    const onOrder = soItems.filter((it) => it.ac === ex.so).map((it) => it.item_code);
    log(`   MISS ${ex.so} wanted "${ex.erp}" (exact hits ${have}); that order's ERP lines: ${onOrder.length ? onOrder.join(" | ") : "(no lines found for this linked_ac_docno)"}`);
  }
  log(`DO documents: ${byDo.size}; already mirrored: ${byDo.size - plan.length}; to create: ${plan.length} (${plan.reduce((s, d) => s + d.items.length, 0)} lines, ${plan.reduce((s, d) => s + d.items.reduce((t, i) => t + i.qty, 0), 0)} units)`);
  for (const d of plan.slice(0, 8)) log(`   ${d.doNo} <- ${d.so}: ${d.items.length} line(s)`);
  if (!APPLY) { log("DRY-RUN — set APPLY=1 to create. No inventory movement is written in either mode."); return; }

  // one AutoCount delivery note = one ERP DO, so the number carries over intact
  let made = 0;
  for (const d of plan) {
    const doNo = "HC-" + d.doNo;
    await sql.begin(async (tx) => {
      const [hdr] = await tx`INSERT INTO scm.delivery_orders
          (do_number, so_doc_no, debtor_code, debtor_name, status, do_date, currency,
           company_id, created_by, notes, migrated_no_stock, linked_ac_docno)
        VALUES (${doNo}, ${d.so}, ${d.debtorCode},
                ${d.debtorName ?? soDebtor.get(d.so) ?? "(unnamed)"},
                'DELIVERED', ${(d.date || "").slice(0, 10) || null}, 'MYR',
                ${CO}, ${SYS_USER},
                ${`mirrors AutoCount delivery ${d.doNo}. No stock movement: the balance snapshot already counts these units as delivered.`},
                true, ${d.doNo})
        RETURNING id`;
      /* THE PRICE COLUMNS ARE NOT OPTIONAL. They were omitted here while the GRN
         half of this same script (doGrns, above) wrote unit_price_sen and
         line_total_sen — one file, two answers. They default to 0 NOT NULL, so
         the omission is silent, and it is NOT cosmetic: the DO line's price
         prefills a new Sales Invoice (do-line-remaining.ts:326 ->
         SalesInvoiceFromDo.tsx:321), the SI price-drift guard skips a zero by
         design ("no ratio to drift from"), and migrated_no_stock gates the SI
         and the PI but NOT the DO->SI path. An operator invoicing one of these
         would have been prefilled RM 0.00 with nothing said. See
         docs/bugs/0617-the-migrated-delivery-orders-carried-no-money-at-all.md.
         The source is the SO line, which is exactly where the normal create path
         takes it from (delivery-orders-mfg.ts:4058, fed by
         soDeliverableRemaining). */
      let hdrTotal = 0;
      for (const it of d.items) {
        const unit = Math.round(Number(it.unitPriceSen ?? 0));
        const cost = Math.round(Number(it.unitCostSen ?? 0));
        /* THE DISCOUNT IS DELIBERATELY NOT CARRIED, and this is the one place
           this writer departs from the interactive create path
           (delivery-orders-mfg.ts:4048 does `(qty * unit) - discount`).
           `mfg_sales_order_items.discount_sen` is a LINE-level amount, not a
           per-unit one, and one migrated SO line is routinely split across
           several AutoCount delivery notes (that is what `taken`/`used` above
           is counting). Copying the whole discount onto each split would deduct
           it once per delivery. Dividing it needs a rule nobody has written.
           A per-UNIT price is well defined and is what the invoice prefill
           needs; the discount stays 0 and the operator sees the undiscounted
           figure rather than an invented one. Say it out loud rather than
           quietly picking a split. */
        const disc = 0;
        const lineTotal = Math.max(0, Math.round(Number(it.qty) * unit));
        hdrTotal += lineTotal;
        await tx`INSERT INTO scm.delivery_order_items
            (delivery_order_id, so_item_id, item_code, description, uom, qty, company_id,
             item_group, variants, description2,
             unit_price_sen, discount_sen, line_total_sen, unit_cost_sen, line_cost_sen)
          VALUES (${hdr.id}, ${it.soItemId}, ${it.code}, ${it.name || null}, 'UNIT', ${it.qty}, ${CO},
                  ${it.group}, ${it.variants ? sql.json(it.variants) : null}, ${it.desc2},
                  ${unit}, ${disc}, ${lineTotal}, ${cost}, ${Math.round(Number(it.qty) * cost)})`;
      }
      /* The header total is Sigma line_total_sen everywhere else
         (delivery-orders-mfg.ts:461). Written here so the list's Amount column
         and its Revenue tile do not read RM 0.00 over priced lines. The category
         buckets and margin are deliberately left to the app's own recompute —
         restating that split here would be a second copy of a rule that already
         has one home. */
      await tx`UPDATE scm.delivery_orders
                  SET local_total_sen = ${hdrTotal}, line_count = ${d.items.length}
                WHERE id = ${hdr.id}`;
    });
    made += 1;
  }
  log(`DONE. DOs created: ${made}. No inventory movement written — by design.`);
}

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"} kind=${KIND}`);
  if (KIND === "grn" || KIND === "both") await doGrns();
  if (KIND === "do" || KIND === "both") await doDos();
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
