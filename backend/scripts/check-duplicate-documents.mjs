// READ-ONLY: system-wide DUPLICATE-DOCUMENT detector, both companies, all six
// document types (owner 2026-08-02, off the 2990-PO-2606-023 / -024 pair: same
// supplier DIGLANT, same date 2026/06/24, same MAKOTO OLIVE x5 + BRONZE x5 at
// RM2,650/line — 023 never received, 024 received AND shipped; the unexecuted
// twin inflated MRP incoming supply and its fifo-attribute allocations
// re-claimed SO demand 024 had already delivered).
//
// WHAT IT PRINTS, per candidate pair: both doc numbers, dates, counterparty,
// line-multiset match %, per-side execution state, and a one-line verdict —
//   LIKELY-DUPLICATE  exact line multiset (code+variant+qty+price), same
//                     counterparty, dates within WINDOW_DAYS
//   SIBLING-LEGIT     same qty+price multiset but fully DISJOINT item codes
//                     (the legitimate Q-size + K-size sibling-buy shape)
//   NEEDS-EYES        high overlap (>= REPORT_FLOOR) that is neither
// sorted by RISK: unexecuted duplicates of executed docs first (the 023
// class — cancel-able without touching goods), then both-executed duplicates
// (double receipt / double shipment candidates), then the rest.
//
// PLUS:
//   (H) named-PO demand verification (VERIFY_POS): does ANY open SO line
//       still demand those POs' exact SKUs in that company? Demand uses the
//       SAME done-set computeMrp uses (SO_DONE incl SHIPPED; cancelled lines
//       excluded; remaining = qty - delivered-by-DO-lines). If demand exists
//       while the PO shows unassigned, that is a pairing bug to explain — NOT
//       stock. If none, the "STOCK" tag is confirmed truthful.
//   (I) MRP SUPPLY INFLATION per LIKELY-DUPLICATE UNEXECUTED PO: for each of
//       its (code, variant) buckets, incoming supply with vs without the
//       suspect's open qty and the shortage that reappears without it — i.e.
//       exactly what MRP over-promised. Cancelling the duplicate self-corrects
//       MRP: CANCELLED / DRAFT POs are excluded from supply (mrp.ts PO_DEAD).
//       (Figures pool per company+code+variant; computeMrp buckets further by
//       warehouse, so a multi-warehouse split can shift WHERE a shortage
//       lands, never the company-wide delta this prints.)
//
// Findings feed the OWNER's cancel/keep decisions; nothing here writes. The
// corrective for confirmed duplicates is part=fifo-attribute-repair on the
// "Repair 2990 doc references" workflow (allocation rows), plus the owner's
// own cancel of the duplicate document.
//
// SELECTs only. Exit 0 for every legitimate answer; the output IS the answer.
//   DATABASE_URL  required (env, or .dev.vars for local use)
//   WINDOW_DAYS   date proximity window (default 3)
//   REPORT_FLOOR  near-miss overlap floor for NEEDS-EYES (default 0.8)
//   VERIFY_POS    section-H PO numbers (default 2990-PO-2607-001,2990-PO-2607-005)
import { readFileSync } from "node:fs";
import postgres from "postgres";
import {
  docLineMultisetKey,
  pairDuplicateCandidates,
  mrpInflationForBuckets,
} from "./lib/duplicate-docs-core.mjs";
import { variantKeyMirror } from "./lib/ledger-repair-core.mjs";
import { SO_TERMINAL_STATES } from "./lib/so-terminal-states.mjs";

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}
const url = resolveUrl();
if (!url) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

const WINDOW_DAYS = Number(process.env.WINDOW_DAYS || 3);
const REPORT_FLOOR = Number(process.env.REPORT_FLOOR || 0.8);
const VERIFY_POS = (process.env.VERIFY_POS || "2990-PO-2607-001,2990-PO-2607-005")
  .split(",").map((s) => s.trim()).filter(Boolean);

// SOs in these statuses no longer demand; POs in these no longer supply.
// The SO set is IMPORTED from the same file mrp.ts reads - "mrp.ts verbatim"
// is what this said before, and verbatim is a thing you have to keep being.
const SO_DONE = new Set(SO_TERMINAL_STATES);
const PO_DEAD = new Set(["CANCELLED", "DRAFT"]);

const up = (s) => String(s ?? "").toUpperCase();
const pct = (x) => `${Math.round(x * 100)}%`;
const listOr = (arr, dash = "-") => (arr.length ? arr.join(", ") : dash);

/* Group docs by key, pair within each group, and print. */
function reportPairs(title, docs, groupKeyOf) {
  const groups = new Map();
  for (const d of docs) {
    const k = groupKeyOf(d);
    if (!k) continue;
    const arr = groups.get(k) ?? [];
    arr.push(d);
    groups.set(k, arr);
  }
  const pairs = [];
  for (const arr of groups.values()) {
    if (arr.length < 2) continue;
    for (const p of pairDuplicateCandidates(arr, { windowDays: WINDOW_DAYS, reportFloor: REPORT_FLOOR })) {
      pairs.push(p);
    }
  }
  pairs.sort((x, y) => x.risk - y.risk || y.matchPct - x.matchPct
    || String(x.a.docNo).localeCompare(String(y.a.docNo)));
  log("");
  log(`--- ${title}: ${pairs.length} candidate pair(s) ---`);
  for (const p of pairs) {
    log(`  [${p.verdict}] ${p.a.docNo} (${p.a.date ?? "?"}) vs ${p.b.docNo} (${p.b.date ?? "?"})  counterparty=${p.a.party ?? "?"}  match=${pct(p.matchPct)}  gap=${p.gapDays?.toFixed(1)}d`);
    log(`      ${p.a.docNo}: ${p.a.exec}`);
    log(`      ${p.b.docNo}: ${p.b.exec}`);
  }
  return pairs;
}

try {
  log(`=== check-duplicate-documents (read-only)  window=${WINDOW_DAYS}d floor=${REPORT_FLOOR} ===`);
  const companies = await pg`SELECT id, code FROM public.companies ORDER BY id`;
  const coCode = new Map(companies.map((r) => [Number(r.id), r.code]));
  const co = (id) => coCode.get(Number(id)) ?? String(id);

  // ── Suppliers (names for the counterparty column) ─────────────────────────
  const suppliers = await pg`SELECT id::text AS id, name FROM scm.suppliers`;
  const supName = new Map(suppliers.map((s) => [s.id, s.name]));

  // ══ PO ═══════════════════════════════════════════════════════════════════
  const poHdrs = await pg`
    SELECT p.id::text AS id, p.po_number, p.company_id, p.supplier_id::text AS supplier_id,
           p.po_date::text AS po_date, UPPER(COALESCE(p.status::text,'')) AS status
      FROM scm.purchase_orders p
     WHERE UPPER(COALESCE(p.status::text,'')) <> 'CANCELLED'`;
  const poIds = poHdrs.map((p) => p.id);
  const poLines = poIds.length ? await pg`
    SELECT purchase_order_id::text AS doc_id, item_code, item_group, variants,
           qty, received_qty, unit_price_sen, warehouse_id::text AS warehouse_id
      FROM scm.purchase_order_items WHERE purchase_order_id::text = ANY(${poIds})` : [];
  const poGrns = poIds.length ? await pg`
    SELECT purchase_order_id::text AS doc_id, grn_number
      FROM scm.grns WHERE purchase_order_id::text = ANY(${poIds})
       AND UPPER(COALESCE(status::text,'')) <> 'CANCELLED'` : [];
  const poNumbers = poHdrs.map((p) => p.po_number).filter(Boolean);
  const poDelivered = poNumbers.length ? await pg`
    SELECT l.batch_no AS po_number, c.source_doc_no, SUM(c.qty_consumed)::int AS qty
      FROM scm.inventory_lots l
      JOIN scm.inventory_lot_consumptions c ON c.lot_id = l.id
     WHERE l.batch_no = ANY(${poNumbers}) AND c.source_doc_type = 'DO'
     GROUP BY l.batch_no, c.source_doc_no` : [];
  const poAllocs = poIds.length ? await pg`
    SELECT i.purchase_order_id::text AS doc_id, COUNT(a.id)::int AS n,
           COUNT(a.so_item_id)::int AS n_so
      FROM scm.purchase_order_item_allocations a
      JOIN scm.purchase_order_items i ON i.id = a.purchase_order_item_id
     WHERE i.purchase_order_id::text = ANY(${poIds})
     GROUP BY i.purchase_order_id` : [];

  const linesByPo = new Map();
  for (const l of poLines) {
    const arr = linesByPo.get(l.doc_id) ?? [];
    arr.push(l);
    linesByPo.set(l.doc_id, arr);
  }
  const grnsByPo = new Map();
  for (const g of poGrns) {
    const arr = grnsByPo.get(g.doc_id) ?? [];
    arr.push(g.grn_number);
    grnsByPo.set(g.doc_id, arr);
  }
  const deliveredByPoNo = new Map();
  for (const d of poDelivered) {
    const arr = deliveredByPoNo.get(d.po_number) ?? [];
    arr.push(`${d.source_doc_no ?? "?"} x${d.qty}`);
    deliveredByPoNo.set(d.po_number, arr);
  }
  const allocsByPo = new Map(poAllocs.map((a) => [a.doc_id, a]));

  const poDocs = poHdrs.map((p) => {
    const grns = grnsByPo.get(p.id) ?? [];
    const dels = deliveredByPoNo.get(p.po_number) ?? [];
    const al = allocsByPo.get(p.id);
    return {
      id: p.id,
      docNo: p.po_number,
      date: p.po_date,
      companyId: Number(p.company_id),
      party: supName.get(p.supplier_id) ?? p.supplier_id ?? "?",
      partyId: p.supplier_id ?? "",
      status: p.status,
      executed: grns.length > 0 || dels.length > 0,
      exec: `status=${p.status} | GRNs: ${listOr(grns)} | delivered: ${listOr(dels)} | allocations: ${al ? `${al.n} (${al.n_so} SO-linked)` : "0"}`,
      lines: (linesByPo.get(p.id) ?? []).map((l) => ({
        itemCode: l.item_code,
        variantKey: variantKeyMirror(l.item_group, l.variants ?? null),
        qty: Number(l.qty ?? 0),
        unitPriceSen: l.unit_price_sen == null ? null : Number(l.unit_price_sen),
      })),
    };
  });
  const poPairs = reportPairs("PO pairs (same company + supplier)", poDocs,
    (d) => `${d.companyId}::${d.partyId}`);
  /* The prime suspect named by the owner — checked DIRECTLY at ANY status
     (the pair scan above excludes CANCELLED docs, and the 2026-08-02 source
     verdict says 023 was cancelled in the SOURCE system: an operator
     re-creation 9 minutes before 024, cancelled there, imported verbatim
     with the same UUID). Expected Houzs status for -023: CANCELLED. */
  log("");
  {
    const sus = await pg`
      SELECT p.id::text AS id, p.po_number, p.po_date::text AS po_date,
             UPPER(COALESCE(p.status::text,'')) AS status, p.created_at
        FROM scm.purchase_orders p
       WHERE p.po_number IN ('2990-PO-2606-023','2990-PO-2606-024')
       ORDER BY p.po_number`;
    const s023 = sus.find((r) => r.po_number === "2990-PO-2606-023");
    const s024 = sus.find((r) => r.po_number === "2990-PO-2606-024");
    if (!s023 || !s024) {
      log(`PRIME SUSPECT 2990-PO-2606-023 vs -024: ${!s023 ? "-023 NOT FOUND. " : ""}${!s024 ? "-024 NOT FOUND." : ""}`);
    } else {
      const susLines = await pg`
        SELECT purchase_order_id::text AS doc_id, item_code, item_group, variants, qty, unit_price_sen
          FROM scm.purchase_order_items WHERE purchase_order_id::text IN (${s023.id}, ${s024.id})`;
      const keyOf = (docId) => docLineMultisetKey(susLines.filter((l) => l.doc_id === docId).map((l) => ({
        itemCode: l.item_code,
        variantKey: variantKeyMirror(l.item_group, l.variants ?? null),
        qty: Number(l.qty ?? 0),
        unitPriceSen: l.unit_price_sen == null ? null : Number(l.unit_price_sen),
      })));
      const multisetMatch = keyOf(s023.id) === keyOf(s024.id);
      const alloc023 = await pg`
        SELECT COUNT(a.id)::int AS n FROM scm.purchase_order_item_allocations a
          JOIN scm.purchase_order_items i ON i.id = a.purchase_order_item_id
         WHERE i.purchase_order_id = ${s023.id}::uuid`;
      log(`PRIME SUSPECT 2990-PO-2606-023 vs -024: statuses ${s023.status} / ${s024.status}; line multiset ${multisetMatch ? "IDENTICAL" : "DIFFERENT"}; created ${s023.created_at?.toISOString?.() ?? s023.created_at} vs ${s024.created_at?.toISOString?.() ?? s024.created_at}; -023 allocation rows: ${alloc023[0]?.n ?? 0}.`);
      if (s023.status === "CANCELLED") {
        log(`  SOURCE VERDICT CONFIRMED: -023 is CANCELLED in Houzs — the source system's own cancel (operator re-creation), carried by the import. NO owner cancel action is needed. Remaining cleanup: its ${alloc023[0]?.n ?? 0} allocation row(s) via part=fifo-attribute-repair (a cancelled PO must not claim SO demand).`);
        log(`  MRP IMPACT: ZERO — CANCELLED is PO_DEAD (mrp.ts), so -023's lines were never counted as incoming supply. See section (I) below for the explicit confirmation.`);
      } else {
        log(`  IMPORT DRIFT: the source system says -023 was CANCELLED there, but Houzs reads ${s023.status}. REPORT ONLY — this check changes nothing; the status correction is the owner's decision (and until then -023 DOES inflate MRP supply — section (I) quantifies it).`);
      }
    }
  }

  // ══ GRN ══════════════════════════════════════════════════════════════════
  const grnHdrs = await pg`
    SELECT g.id::text AS id, g.grn_number, g.company_id, g.supplier_id::text AS supplier_id,
           g.purchase_order_id::text AS po_id, g.received_at::date::text AS grn_date,
           UPPER(COALESCE(g.status::text,'')) AS status
      FROM scm.grns g
     WHERE UPPER(COALESCE(g.status::text,'')) <> 'CANCELLED'`;
  const grnIds = grnHdrs.map((g) => g.id);
  const grnLines = grnIds.length ? await pg`
    SELECT grn_id::text AS doc_id, item_code, item_group, variants,
           qty_accepted AS qty, unit_price_sen
      FROM scm.grn_items WHERE grn_id::text = ANY(${grnIds})` : [];
  const grnMoves = grnIds.length ? await pg`
    SELECT source_doc_id::text AS doc_id, COUNT(*)::int AS n
      FROM scm.inventory_movements
     WHERE source_doc_type = 'GRN' AND source_doc_id::text = ANY(${grnIds})
     GROUP BY source_doc_id` : [];
  const grnPis = grnIds.length ? await pg`
    SELECT grn_id::text AS doc_id, invoice_number
      FROM scm.purchase_invoices
     WHERE grn_id::text = ANY(${grnIds}) AND UPPER(COALESCE(status::text,'')) <> 'CANCELLED'` : [];
  const grnLinesBy = new Map();
  for (const l of grnLines) {
    const arr = grnLinesBy.get(l.doc_id) ?? [];
    arr.push(l);
    grnLinesBy.set(l.doc_id, arr);
  }
  const grnMovesBy = new Map(grnMoves.map((m) => [m.doc_id, Number(m.n)]));
  const grnPisBy = new Map();
  for (const x of grnPis) {
    const arr = grnPisBy.get(x.doc_id) ?? [];
    arr.push(x.invoice_number);
    grnPisBy.set(x.doc_id, arr);
  }
  const grnDocs = grnHdrs.map((g) => ({
    id: g.id,
    docNo: g.grn_number,
    date: g.grn_date,
    companyId: Number(g.company_id),
    party: supName.get(g.supplier_id) ?? g.supplier_id ?? "?",
    // Same PO first (double-receipt of one order); else same supplier.
    partyId: g.po_id ? `po:${g.po_id}` : `sup:${g.supplier_id ?? ""}`,
    status: g.status,
    executed: (grnMovesBy.get(g.id) ?? 0) > 0 || (grnPisBy.get(g.id) ?? []).length > 0,
    exec: `status=${g.status} | posted movements: ${grnMovesBy.get(g.id) ?? 0} | PIs: ${listOr(grnPisBy.get(g.id) ?? [])}`,
    lines: (grnLinesBy.get(g.id) ?? []).map((l) => ({
      itemCode: l.item_code,
      variantKey: variantKeyMirror(l.item_group, l.variants ?? null),
      qty: Number(l.qty ?? 0),
      unitPriceSen: l.unit_price_sen == null ? null : Number(l.unit_price_sen),
    })),
  }));
  reportPairs("GRN pairs (same PO, else same supplier — double-receipt candidates)", grnDocs,
    (d) => `${d.companyId}::${d.partyId}`);

  // ══ SO ═══════════════════════════════════════════════════════════════════
  const soHdrs = await pg`
    SELECT s.doc_no, s.company_id, s.debtor_code, s.debtor_name,
           s.so_date::text AS so_date, UPPER(COALESCE(s.status::text,'')) AS status
      FROM scm.mfg_sales_orders s
     WHERE UPPER(COALESCE(s.status::text,'')) <> 'CANCELLED'`;
  const soDocNos = soHdrs.map((s) => s.doc_no);
  const soLines = soDocNos.length ? await pg`
    SELECT doc_no AS doc_id, item_code, item_group, variants, qty, unit_price_sen
      FROM scm.mfg_sales_order_items
     WHERE doc_no = ANY(${soDocNos}) AND cancelled = false` : [];
  const soDos = soDocNos.length ? await pg`
    SELECT so_doc_no AS doc_id, do_number FROM scm.delivery_orders
     WHERE so_doc_no = ANY(${soDocNos}) AND UPPER(COALESCE(status::text,'')) <> 'CANCELLED'` : [];
  const soSis = soDocNos.length ? await pg`
    SELECT so_doc_no AS doc_id, invoice_number FROM scm.sales_invoices
     WHERE so_doc_no = ANY(${soDocNos}) AND UPPER(COALESCE(status::text,'')) <> 'CANCELLED'` : [];
  const soLinesBy = new Map();
  for (const l of soLines) {
    const arr = soLinesBy.get(l.doc_id) ?? [];
    arr.push(l);
    soLinesBy.set(l.doc_id, arr);
  }
  const soDosBy = new Map();
  for (const x of soDos) {
    const arr = soDosBy.get(x.doc_id) ?? [];
    arr.push(x.do_number);
    soDosBy.set(x.doc_id, arr);
  }
  const soSisBy = new Map();
  for (const x of soSis) {
    const arr = soSisBy.get(x.doc_id) ?? [];
    arr.push(x.invoice_number);
    soSisBy.set(x.doc_id, arr);
  }
  const soDocs = soHdrs.map((s) => ({
    id: s.doc_no,
    docNo: s.doc_no,
    date: s.so_date,
    companyId: Number(s.company_id),
    party: s.debtor_name ?? s.debtor_code ?? "?",
    partyId: (s.debtor_code ?? s.debtor_name ?? "").trim().toUpperCase(),
    status: s.status,
    executed: (soDosBy.get(s.doc_no) ?? []).length > 0 || (soSisBy.get(s.doc_no) ?? []).length > 0,
    exec: `status=${s.status} | DOs: ${listOr(soDosBy.get(s.doc_no) ?? [])} | SIs: ${listOr(soSisBy.get(s.doc_no) ?? [])}`,
    lines: (soLinesBy.get(s.doc_no) ?? []).map((l) => ({
      itemCode: l.item_code,
      variantKey: variantKeyMirror(l.item_group, l.variants ?? null),
      qty: Number(l.qty ?? 0),
      unitPriceSen: l.unit_price_sen == null ? null : Number(l.unit_price_sen),
    })),
  }));
  reportPairs("SO pairs (same company + customer)", soDocs, (d) => `${d.companyId}::${d.partyId}`);

  // ══ DO ═══════════════════════════════════════════════════════════════════
  const doHdrs = await pg`
    SELECT d.id::text AS id, d.do_number, d.company_id, d.so_doc_no,
           d.debtor_code, d.debtor_name, d.do_date::text AS do_date,
           UPPER(COALESCE(d.status::text,'')) AS status
      FROM scm.delivery_orders d
     WHERE UPPER(COALESCE(d.status::text,'')) <> 'CANCELLED'`;
  const doIds = doHdrs.map((d) => d.id);
  const doLines = doIds.length ? await pg`
    SELECT delivery_order_id::text AS doc_id, item_code, item_group, variants, qty, unit_price_sen
      FROM scm.delivery_order_items WHERE delivery_order_id::text = ANY(${doIds})` : [];
  const doMoves = doIds.length ? await pg`
    SELECT source_doc_id::text AS doc_id, COUNT(*)::int AS n
      FROM scm.inventory_movements
     WHERE source_doc_type = 'DO' AND movement_type = 'OUT' AND source_doc_id::text = ANY(${doIds})
     GROUP BY source_doc_id` : [];
  const doSis = doIds.length ? await pg`
    SELECT delivery_order_id::text AS doc_id, invoice_number
      FROM scm.sales_invoices
     WHERE delivery_order_id::text = ANY(${doIds}) AND UPPER(COALESCE(status::text,'')) <> 'CANCELLED'` : [];
  const doLinesBy = new Map();
  for (const l of doLines) {
    const arr = doLinesBy.get(l.doc_id) ?? [];
    arr.push(l);
    doLinesBy.set(l.doc_id, arr);
  }
  const doMovesBy = new Map(doMoves.map((m) => [m.doc_id, Number(m.n)]));
  const doSisBy = new Map();
  for (const x of doSis) {
    const arr = doSisBy.get(x.doc_id) ?? [];
    arr.push(x.invoice_number);
    doSisBy.set(x.doc_id, arr);
  }
  const doDocs = doHdrs.map((d) => ({
    id: d.id,
    docNo: d.do_number,
    date: d.do_date,
    companyId: Number(d.company_id),
    party: d.so_doc_no ?? d.debtor_name ?? d.debtor_code ?? "?",
    partyId: d.so_doc_no ? `so:${d.so_doc_no}` : `cust:${(d.debtor_code ?? d.debtor_name ?? "").trim().toUpperCase()}`,
    status: d.status,
    executed: (doMovesBy.get(d.id) ?? 0) > 0 || (doSisBy.get(d.id) ?? []).length > 0,
    exec: `status=${d.status} | OUT movements: ${doMovesBy.get(d.id) ?? 0} | SIs: ${listOr(doSisBy.get(d.id) ?? [])}`,
    lines: (doLinesBy.get(d.id) ?? []).map((l) => ({
      itemCode: l.item_code,
      variantKey: variantKeyMirror(l.item_group, l.variants ?? null),
      qty: Number(l.qty ?? 0),
      unitPriceSen: l.unit_price_sen == null ? null : Number(l.unit_price_sen),
    })),
  }));
  reportPairs("DO pairs (same SO, else same customer — double-shipment candidates)", doDocs,
    (d) => `${d.companyId}::${d.partyId}`);

  // ══ SI ═══════════════════════════════════════════════════════════════════
  const siHdrs = await pg`
    SELECT s.id::text AS id, s.invoice_number, s.company_id, s.debtor_code, s.debtor_name,
           s.invoice_date::text AS invoice_date, s.total_sen,
           UPPER(COALESCE(s.status::text,'')) AS status
      FROM scm.sales_invoices s
     WHERE UPPER(COALESCE(s.status::text,'')) <> 'CANCELLED'`;
  const siIds = siHdrs.map((s) => s.id);
  const siLines = siIds.length ? await pg`
    SELECT sales_invoice_id::text AS doc_id, item_code, item_group, variants, qty, unit_price_sen
      FROM scm.sales_invoice_items WHERE sales_invoice_id::text = ANY(${siIds})` : [];
  const siLinesBy = new Map();
  for (const l of siLines) {
    const arr = siLinesBy.get(l.doc_id) ?? [];
    arr.push(l);
    siLinesBy.set(l.doc_id, arr);
  }
  const siDocs = siHdrs.map((s) => ({
    id: s.id,
    docNo: s.invoice_number,
    date: s.invoice_date,
    companyId: Number(s.company_id),
    party: s.debtor_name ?? s.debtor_code ?? "?",
    partyId: (s.debtor_code ?? s.debtor_name ?? "").trim().toUpperCase(),
    status: s.status,
    executed: ["POSTED", "PARTIALLY_PAID", "PAID"].includes(s.status),
    exec: `status=${s.status} | total=RM${(Number(s.total_sen ?? 0) / 100).toFixed(2)}`,
    lines: (siLinesBy.get(s.id) ?? []).map((l) => ({
      itemCode: l.item_code,
      variantKey: variantKeyMirror(l.item_group, l.variants ?? null),
      qty: Number(l.qty ?? 0),
      unitPriceSen: l.unit_price_sen == null ? null : Number(l.unit_price_sen),
    })),
  }));
  reportPairs("SI pairs (same company + customer — double-billing candidates)", siDocs,
    (d) => `${d.companyId}::${d.partyId}`);

  // ══ PI ═══════════════════════════════════════════════════════════════════
  const piHdrs = await pg`
    SELECT p.id::text AS id, p.invoice_number, p.company_id, p.supplier_id::text AS supplier_id,
           p.grn_id::text AS grn_id, p.invoice_date::text AS invoice_date, p.total_sen,
           UPPER(COALESCE(p.status::text,'')) AS status
      FROM scm.purchase_invoices p
     WHERE UPPER(COALESCE(p.status::text,'')) <> 'CANCELLED'`;
  const piIds = piHdrs.map((p) => p.id);
  const piLines = piIds.length ? await pg`
    SELECT purchase_invoice_id::text AS doc_id, item_code, item_group, qty, unit_price_sen
      FROM scm.purchase_invoice_items WHERE purchase_invoice_id::text = ANY(${piIds})` : [];
  const piLinesBy = new Map();
  for (const l of piLines) {
    const arr = piLinesBy.get(l.doc_id) ?? [];
    arr.push(l);
    piLinesBy.set(l.doc_id, arr);
  }
  const piDocs = piHdrs.map((p) => ({
    id: p.id,
    docNo: p.invoice_number,
    date: p.invoice_date,
    companyId: Number(p.company_id),
    party: supName.get(p.supplier_id) ?? p.supplier_id ?? "?",
    partyId: p.grn_id ? `grn:${p.grn_id}` : `sup:${p.supplier_id ?? ""}`,
    status: p.status,
    executed: ["POSTED", "PARTIALLY_PAID", "PAID"].includes(p.status),
    exec: `status=${p.status} | total=RM${(Number(p.total_sen ?? 0) / 100).toFixed(2)}`,
    lines: (piLinesBy.get(p.id) ?? []).map((l) => ({
      itemCode: l.item_code,
      // purchase_invoice_items carries no variants blob — '' is honest.
      variantKey: "",
      qty: Number(l.qty ?? 0),
      unitPriceSen: l.unit_price_sen == null ? null : Number(l.unit_price_sen),
    })),
  }));
  reportPairs("PI pairs (same GRN, else same supplier — double-billing candidates)", piDocs,
    (d) => `${d.companyId}::${d.partyId}`);

  // ══ (H) named-PO demand verification ═════════════════════════════════════
  log("");
  log(`--- (H) named-PO demand verification: ${VERIFY_POS.join(", ")} ---`);
  for (const poNo of VERIFY_POS) {
    const hdr = poHdrs.find((p) => p.po_number === poNo);
    if (!hdr) { log(`  ${poNo}: NOT FOUND (or cancelled) — skipped.`); continue; }
    const lines = linesByPo.get(hdr.id) ?? [];
    const codes = [...new Set(lines.map((l) => l.item_code).filter(Boolean))];
    log(`  ${poNo} (company ${co(hdr.company_id)}, status ${hdr.status}) lines: ${lines.map((l) => `${l.item_code} x${l.qty}`).join(", ")}`);
    if (codes.length === 0) continue;
    const demand = await pg`
      SELECT i.doc_no, i.item_code, i.qty, UPPER(COALESCE(s.status::text,'')) AS so_status,
             COALESCE((SELECT SUM(di.qty) FROM scm.delivery_order_items di
                        JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
                       WHERE di.so_item_id = i.id
                         AND UPPER(COALESCE(d.status::text,'')) <> 'CANCELLED'), 0)::int AS delivered
        FROM scm.mfg_sales_order_items i
        JOIN scm.mfg_sales_orders s ON s.doc_no = i.doc_no
       WHERE i.item_code = ANY(${codes}) AND i.cancelled = false
         AND s.company_id = ${hdr.company_id}
       ORDER BY i.doc_no, i.item_code`;
    const open = demand.filter((d) => !SO_DONE.has(d.so_status) && Number(d.qty ?? 0) - Number(d.delivered ?? 0) > 0);
    if (open.length === 0) {
      log(`    open demand for these SKUs: NONE (checked ${demand.length} SO line(s), all done/served) — stock-replenishment CONFIRMED; the "STOCK" tag stands. MRP layer (c) will float-assign when matching demand appears.`);
    } else {
      log(`    open demand EXISTS (${open.length} line(s)) — if MRP still shows ${poNo} unassigned, that is a PAIRING BUG to explain, not stock:`);
      for (const d of open) {
        log(`      ${d.doc_no} (${d.so_status}) ${d.item_code}: qty ${d.qty}, delivered ${d.delivered}, remaining ${Number(d.qty) - Number(d.delivered)}`);
      }
    }
  }

  // ══ (I) MRP supply inflation from LIKELY-DUPLICATE unexecuted POs ════════
  log("");
  log(`--- (I) MRP supply inflation from LIKELY-DUPLICATE unexecuted POs ---`);
  /* Incident-specific confirmation (2026-08-02 source verdict): 023 first. */
  {
    const inc = await pg`
      SELECT UPPER(COALESCE(status::text,'')) AS status,
             (SELECT COALESCE(SUM(GREATEST(0, i.qty - COALESCE(i.received_qty,0))),0)::int
                FROM scm.purchase_order_items i WHERE i.purchase_order_id = p.id) AS open_qty
        FROM scm.purchase_orders p WHERE p.po_number = '2990-PO-2606-023'`;
    if (inc.length === 1) {
      const st = inc[0].status;
      log(PO_DEAD.has(st)
        ? `  2990-PO-2606-023: status ${st} -> MRP impact ZERO, confirmed — dead statuses are excluded from incoming supply (mrp.ts PO_DEAD), so its ${inc[0].open_qty} open unit(s) never counted and never will. MRP was NOT inflated by this PO.`
        : `  2990-PO-2606-023: status ${st} (IMPORT DRIFT — source says CANCELLED) -> its ${inc[0].open_qty} open unit(s) ARE currently counted as incoming supply; the buckets below quantify what that hides.`);
    }
  }
  const inflationSuspects = poPairs
    .filter((p) => p.verdict === "LIKELY-DUPLICATE")
    .flatMap((p) => [p.a, p.b].filter((d) => !d.executed && !PO_DEAD.has(d.status)));
  const seen = new Set();
  if (inflationSuspects.length === 0) log("  no OTHER unexecuted LIKELY-DUPLICATE PO is feeding MRP supply.");
  for (const s of inflationSuspects) {
    if (seen.has(s.docNo)) continue;
    seen.add(s.docNo);
    const hdr = poHdrs.find((p) => p.po_number === s.docNo);
    if (!hdr) continue;
    const sLines = linesByPo.get(hdr.id) ?? [];
    const buckets = [];
    for (const l of sLines) {
      const code = l.item_code;
      if (!code) continue;
      const vk = variantKeyMirror(l.item_group, l.variants ?? null);
      const suspectOpen = Math.max(0, Number(l.qty ?? 0) - Number(l.received_qty ?? 0));
      if (suspectOpen <= 0) continue;
      // Company-wide pooled figures per (code, variant) — see header note.
      const [supplyRows, stockRows, demandRows] = await Promise.all([
        pg`SELECT COALESCE(SUM(GREATEST(0, i.qty - COALESCE(i.received_qty,0))),0)::int AS n
             FROM scm.purchase_order_items i
             JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
            WHERE p.company_id = ${hdr.company_id} AND i.item_code = ${code}
              AND UPPER(COALESCE(p.status::text,'')) NOT IN ('CANCELLED','DRAFT')`,
        pg`SELECT COALESCE(SUM(qty_remaining),0)::int AS n
             FROM scm.inventory_lots
            WHERE company_id = ${hdr.company_id} AND item_code = ${code} AND qty_remaining > 0`,
        pg`SELECT COALESCE(SUM(GREATEST(0, i.qty - COALESCE((SELECT SUM(di.qty) FROM scm.delivery_order_items di
                    JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
                   WHERE di.so_item_id = i.id AND UPPER(COALESCE(d.status::text,'')) <> 'CANCELLED'),0))),0)::int AS n
             FROM scm.mfg_sales_order_items i
             JOIN scm.mfg_sales_orders so ON so.doc_no = i.doc_no
            WHERE so.company_id = ${hdr.company_id} AND i.item_code = ${code} AND i.cancelled = false
              AND UPPER(COALESCE(so.status::text,'')) <> ALL(${SO_TERMINAL_STATES})`,
      ]);
      buckets.push({
        bucket: `${co(hdr.company_id)} ${code}${vk ? ` [${vk}]` : ""}`,
        demandQty: Number(demandRows[0]?.n ?? 0),
        stockQty: Number(stockRows[0]?.n ?? 0),
        supplyQty: Number(supplyRows[0]?.n ?? 0),
        suspectOpenQty: suspectOpen,
      });
    }
    const rows = mrpInflationForBuckets(buckets);
    log(`  ${s.docNo} (${s.exec}):`);
    for (const r of rows) {
      log(`    ${r.bucket}: demand ${r.demandQty}, stock ${r.stockQty}, incoming ${r.supplyWith} -> ${r.supplyWithout} without the suspect; shortage ${r.shortageWith} -> ${r.shortageWithout}${r.shortageHiddenBySuspect > 0 ? `  (** ${r.shortageHiddenBySuspect} unit(s) of shortage HIDDEN by the suspect **)` : ""}`);
    }
    log(`    Cancelling ${s.docNo} self-corrects MRP: CANCELLED is a dead status and its lines stop counting as incoming supply. No UI flag needed once cancelled; flagging duplicate-SUSPECT supply rows in the MRP page is noted as a follow-up, not done here.`);
  }

  log("");
  log("VERDICT: findings above feed the owner's cancel/keep decisions. Corrective for a confirmed duplicate: part=fifo-attribute-repair (allocation rows) + owner cancels the duplicate document. Read-only run — nothing was written.");
} finally {
  await pg.end({ timeout: 5 });
}
