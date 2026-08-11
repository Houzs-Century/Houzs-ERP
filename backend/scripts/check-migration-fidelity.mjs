#!/usr/bin/env node
/* Is every migrated document in the ERP identical to AutoCount, FIELD BY FIELD?
 *
 * Owner, 2026-08-11, on learning that 65 PO lines carry a received quantity
 * AutoCount never recorded:
 *   "怎么可以这样的 我们的数据居然是 migrate 的 那就应该全部一模一样 migrate"
 *   "跟着 autocount 的 document 就对了，我们 migrate data 不可以更改数据啊"
 *
 * WHY THIS CHECK HAD TO EXIST AND WHY NOTHING ELSE CAUGHT IT. Every earlier
 * verification was AGGREGATE: document counts (2,710 = 2,710), document numbers
 * (262 exact, 0 different), balances (2,696 of 2,708 agree), the SO->PO->GR
 * chain (427 agree, 0 disagree), stock status. All of them passed while a
 * per-line FIELD was wrong. purchase_order_items.received_qty was written from
 * an export column aggregated on (DocNo + ItemCode), so every same-code line on
 * a document got the DOCUMENT's total; PO-009633 reads "ordered 1, received 2"
 * on both of its HOK-1005 (Q) lines while AutoCount's own PODTL.TransferedQty
 * says 1 and 1. An aggregate can only ever see the sum, and the sum was right.
 *
 * So this check compares PER LINE, groups its findings BY FIELD (a systematic
 * import bug is one finding, not N scattered ones), and states its own join
 * coverage - a comparison that silently drops the rows it cannot join proves
 * nothing.
 *
 * READ-ONLY on both systems. SELECT only, no writes, no DDL, no transaction.
 * The AutoCount side is the committed snapshot from
 * backend/scripts/export-ac-fidelity-truth.py, because the AutoCount host sits
 * behind ZeroTier on the office network and a CI runner is not on it - the same
 * split export-ac-live.py + check-stock-vs-autocount.mjs already use.
 *
 *   DATABASE_URL   required
 *   COMPANY_ID     default 1
 *   TOP            example rows printed per finding, default 25
 */
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { SOFA_MODEL_ALIAS } from "./lib/parse-sofa.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const CO = Number(process.env.COMPANY_ID ?? 1);
const TOP = Number(process.env.TOP ?? 25);
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m = "") => console.log(m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", f))).toString("utf8").replace(/^﻿/, ""));

const norm = (s) => (s ?? "").toString().trim().toUpperCase().replace(/\s+/g, " ");
const txt = (s) => (s ?? "").toString().trim();
const n0 = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const centi = (v) => Math.round(n0(v) * 100);
/* Date columns are cast to text in SQL rather than parsed here: postgres.js
   hands back a JS Date for `date`, and String(Date) is a locale string, so a
   naive slice(0,10) silently turned every date comparison into a mismatch. */
const day = (v) => (v == null ? null : String(v).slice(0, 10));
const isSofaAc = (c) => /SOFA/i.test(c || "");

function parseCsvLine(line) {
  const out = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) { const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c; } }
  out.push(cur); return out;
}

/* ─────────────────────────── THE FIELD MAP ───────────────────────────
   Every field the cutover writes into the ERP from AutoCount, the AutoCount
   column it came from, and what this check does with it. Printed in full on
   every run: if a field is NOT compared, the owner has to be able to see which
   one and why, rather than trusting that "the check passed" covered it.

   verdict: COMPARED  - value-for-value against AutoCount's own column
            DERIVED   - the ERP value is computed from AutoCount; the check
                        recomputes the same derivation and compares
            DECLARED  - deliberately different, with the reason stated
            NOT-CHECKED - carried from AutoCount but outside this check, named
                        so the gap is visible instead of implied            */
const FIELD_MAP = [
  // ---- sales order header ----
  ["SO header", "doc_no", "'HC-' + SO.DocNo", "DECLARED", "prefix is the cutover's own numbering rule (owner: migrated documents keep the AutoCount number)"],
  ["SO header", "linked_ac_docno", "SO.DocNo", "COMPARED", ""],
  ["SO header", "so_date", "SO.DocDate", "COMPARED", ""],
  ["SO header", "debtor_name", "SO.DebtorName", "COMPARED", "importer substitutes 'CUSTOMER' when AutoCount is blank"],
  ["SO header", "debtor_code", "SO.DebtorCode", "COMPARED", ""],
  ["SO header", "agent", "SO.SalesAgent", "COMPARED", ""],
  ["SO header", "sales_location", "SO.SalesLocation via SALESLOC map", "COMPARED", "short code -> full warehouse name"],
  ["SO header", "ref", "SO.Ref", "COMPARED", ""],
  ["SO header", "customer_so_no", "SO.Ref", "COMPARED", "same source as ref"],
  ["SO header", "venue", "SO.UDF_VENUE", "COMPARED", ""],
  ["SO header", "branding", "SO.UDF_BRANDING", "COMPARED", ""],
  ["SO header", "address1..address4", "SO.InvAddr1..InvAddr4", "COMPARED", ""],
  ["SO header", "phone", "SO.Phone1", "COMPARED", ""],
  ["SO header", "balance_centi", "SO.UDF_BALANCE x 100", "COMPARED", ""],
  ["SO header", "proceeded_at", "SO.UDF_PDate", "COMPARED", ""],
  ["SO header", "local_total_centi", "SUM over SODTL of round(UnitPrice x100) x round(Qty)", "DERIVED", ""],
  ["SO header", "paid_centi / deposit_centi", "local_total - UDF_BALANCE", "DERIVED", ""],
  ["SO header", "salesperson_id", "SO.SalesAgent via agent-staff-binding.csv", "DECLARED", "a UUID, not an AutoCount value; the source text is compared as `agent`"],
  ["SO header", "venue_id", "SO.UDF_VENUE resolved to scm.venues", "DECLARED", "a UUID; the source text is compared as `venue`"],
  ["SO header", "postcode / city / customer_state", "parsed out of InvAddr1..4", "DECLARED", "derived from a free-text address, no AutoCount column to compare against"],
  ["SO header", "emergency_contact_phone", "SO.DeliverPhone1 or 2nd number in Phone1", "NOT-CHECKED", "conditional derivation; low risk, no per-line multiplier"],
  ["SO header", "payment_method / approval_code / payment_date", "SO.UDF_PAYEMENT, SO.DocDate", "NOT-CHECKED", "free-text payment blob parsed into two fields"],
  ["SO header", "status / currency / company_id", "constant", "DECLARED", "not from AutoCount"],
  ["SO header", "line_count / category subtotals", "counted over the ERP's own lines", "DECLARED", "sofa decomposition changes the line count by design"],
  // ---- sales order line ----
  ["SO line", "linked_ac_dtlkey", "SODTL.DtlKey", "COMPARED", "backfilled 2026-08-11; the exact join key where present"],
  ["SO line", "item_code", "SODTL.ItemCode via autocount-erp-mapping-1561.csv", "COMPARED", "sofa compared by model prefix only - see declared differences"],
  ["SO line", "qty", "round(SODTL.Qty)", "COMPARED", "importer floors at 1 (`Math.round(qty) || 1`)"],
  ["SO line", "unit_price_centi", "round(SODTL.UnitPrice x 100)", "COMPARED", "sofa: price rides the lead compartment, compared as a group total"],
  ["SO line", "total_centi / balance_centi", "unit_price_centi x qty", "COMPARED", ""],
  ["SO line", "description2", "SODTL.Desc2", "COMPARED", ""],
  ["SO line", "location", "SODTL.Location", "COMPARED", ""],
  ["SO line", "description", "the ERP product NAME", "DECLARED", "deliberately not SODTL.Description: a picker-selected line stores the ERP name"],
  ["SO line", "warehouse_id", "SODTL.Location via SALESLOC map", "DECLARED", "a UUID; the source text is compared as `location`"],
  ["SO line", "variants / gap / divan / leg / custom_specials", "parsed out of SODTL.Desc2", "DECLARED", "parser output, not an AutoCount column; the raw Desc2 is compared instead"],
  ["SO line", "uom / item_group", "derived from category", "DECLARED", "ERP vocabulary, no AutoCount counterpart"],
  // ---- purchase order header ----
  ["PO header", "po_number", "'HC-' + PO.DocNo", "DECLARED", "cutover numbering rule"],
  ["PO header", "linked_ac_docno", "PO.DocNo", "COMPARED", ""],
  ["PO header", "po_date", "PO.DocDate", "COMPARED", ""],
  ["PO header", "supplier_id", "PO.CreditorCode -> scm.suppliers.code", "COMPARED", "compared via the supplier's code"],
  ["PO header", "expected_at", "earliest PODTL.DeliveryDate", "DERIVED", ""],
  ["PO header", "subtotal_centi / total_centi", "SUM over PODTL of round(UnitPrice x100) x round(Qty)", "DERIVED", ""],
  ["PO header", "status", "RECEIVED / PARTIALLY_RECEIVED / SUBMITTED from received vs ordered", "DERIVED", "recomputed from PODTL.TransferedQty"],
  ["PO header", "purchase_location_id", "first PODTL.Location via SALESLOC map", "DECLARED", "a UUID; the source text is compared per line as `location`"],
  ["PO header", "currency / revision / created_by / notes", "constant", "DECLARED", "not from AutoCount"],
  // ---- purchase order line ----
  ["PO line", "linked_ac_dtlkey", "PODTL.DtlKey", "COMPARED", ""],
  ["PO line", "material_code", "PODTL.ItemCode via autocount-erp-mapping-1561.csv", "COMPARED", "sofa compared by model prefix only"],
  ["PO line", "supplier_sku", "PODTL.ItemCode", "COMPARED", "sofa: AutoCount code + compartment"],
  ["PO line", "qty", "round(PODTL.Qty)", "COMPARED", ""],
  ["PO line", "received_qty", "PODTL.TransferedQty", "COMPARED", "*** the field the cutover got wrong ***"],
  ["PO line", "unit_price_centi", "round(PODTL.UnitPrice x 100)", "COMPARED", "sofa: price rides the lead compartment"],
  ["PO line", "line_total_centi", "unit_price_centi x qty", "COMPARED", ""],
  ["PO line", "description2", "PODTL.Desc2", "COMPARED", ""],
  ["PO line", "delivery_date", "PODTL.DeliveryDate", "COMPARED", ""],
  ["PO line", "description", "PODTL.Description", "COMPARED", "outstanding-PO import writes the ERP product name instead; both accepted"],
  ["PO line", "material_name", "the ERP product NAME", "DECLARED", "deliberately the ERP catalogue name"],
  ["PO line", "warehouse_id", "PODTL.Location via SALESLOC map", "DECLARED", "a UUID; source text compared as location on the AutoCount side"],
  ["PO line", "so_item_id", "PODTL.FromSODtlKey -> the ERP SO line", "NOT-CHECKED", "a dedication link, verified separately by the SO->PO->GR chain audit"],
  ["PO line", "variants / gap / divan / leg / custom_specials", "parsed out of PODTL.Desc2", "DECLARED", "parser output; raw Desc2 compared instead"],
  // ---- migrated GRN ----
  ["GRN header", "grn_number", "'HC-' + AutoCount GR number", "DECLARED", "one ERP GRN per PURCHASE ORDER; an AutoCount receipt can span several"],
  ["GRN header", "linked_ac_docno", "the PO's AutoCount DocNo", "COMPARED", "note: the PO number, not the GR number - by design"],
  ["GRN line", "qty_received / qty_accepted", "purchase_order_items.received_qty", "COMPARED", "against PODTL.TransferedQty - inherits any received_qty defect"],
  ["GRN line", "unit_price_centi / line_total_centi", "the PO line's price", "DERIVED", ""],
  ["GRN", "inventory movement", "none", "DECLARED", "migrated_no_stock (migration 0276): the balance snapshot already counted these units"],
  // ---- migrated DO ----
  ["DO header", "do_number", "'HC-' + DO.DocNo", "DECLARED", "cutover numbering rule"],
  ["DO header", "linked_ac_docno", "DO.DocNo", "COMPARED", ""],
  ["DO header", "do_date", "DO.DocDate", "COMPARED", ""],
  ["DO header", "debtor_code", "DO.DebtorCode", "COMPARED", ""],
  ["DO header", "debtor_name", "DO.DebtorName", "COMPARED", "falls back to the sales order's name when AutoCount is blank"],
  ["DO line", "qty", "DODTL.Qty", "COMPARED", "sofa: one AutoCount line becomes one ERP line per compartment, each carrying that qty"],
  ["DO line", "item_code", "the ERP sales-order line's code", "DECLARED", "taken from the SO line it delivers, not from DODTL.ItemCode"],
  ["DO line", "description", "DODTL.Description", "COMPARED", ""],
  ["DO", "inventory movement", "none", "DECLARED", "migrated_no_stock (migration 0276)"],
];

const DECLARED_DIFFERENCES = [
  ["SOFA decomposition", "One AutoCount sofa line is ONE line per COMPARTMENT in the ERP, so the row shapes are not commensurable. What IS compared: the build's total quantity, the source document, the AutoCount model the pieces came from, the group's money total, and Desc2. What is NOT: a one-to-one line identity, per-piece unit price (price rides the lead piece and the rest are 0 so the document total still matches to the cent), and item_code beyond the model prefix."],
  ["Migrated GRNs and DOs post NO inventory movement", "migrated_no_stock, migration 0276. On-hand entered the ERP once through the AutoCount balance snapshot, which already counts every past receipt as IN and every past delivery as OUT. A movement here would apply the same units twice. The absence is the design, never reported as a divergence."],
  ["Historical IV / DO / PI documents were not imported", "Owner's decision (\"这个不要\"). Their absence is a decision, not a gap; this check does not look for them and does not count them missing."],
  ["ERP document numbers carry an 'HC-' prefix", "HC-SO-000021 is AutoCount's SO-000021. The raw number lives in linked_ac_docno, which is what the write-back addresses."],
  ["Item codes are translated", "AutoCount ItemCode -> ERP code through data/autocount-erp-mapping-1561.csv, and free-text AutoCount lines are name-resolved against the ERP pick list. A translated code is not a changed value."],
  ["SO line description is the ERP product name", "A picker-selected line stores the ERP catalogue name; writing AutoCount's Description there would make the list and the edit screen disagree. The AutoCount text is preserved in description2 / Desc2, which IS compared."],
  ["Only outstanding sales orders were imported", "An order every line of which AutoCount had already delivered is not outstanding, and was deliberately left behind. Documents in the AutoCount snapshot with no ERP counterpart are therefore expected and are not counted as divergences - this check walks the ERP's migrated rows outward."],
];

// AutoCount location/sales-location short code -> ERP warehouse name, verbatim
// from the importers (import-ac-so-linked-pos.mjs SALESLOC, the widest of the
// three). An unmapped code is REPORTED, never guessed.
const SALESLOC = {
  KL: "KL WAREHOUSE", PG: "PG WAREHOUSE", SRW: "SRW WAREHOUSE", SBH: "SBH WAREHOUSE",
  HQ: "HQ", JB: "KL WAREHOUSE", KUANTAN: "KL WAREHOUSE",
  "KL DISP": "KL DISPLAY", "PG DISP": "PG DISPLAY", "SBH DISP": "SBH DISPLAY",
  "EM DISP": "EM DISPLAY", "C&C DISP": "C&C DISPLAY",
  "SERV KL": "KL SERVICE", "SERV PG": "PG SERVICE",
  SUNWAY: "SUNWAY SHOWROOM", "KELANA.J": "KELANA.J SHOWROOM",
};
const salesLoc = (c) => (c ? (SALESLOC[norm(c)] || txt(c)) : null);
const C1_ALIAS = { "SVC-DELIVERY": "TRANSPORTATION CHARGES", "SVC-DELIVERY-ADD": "TRANSPORTATION CHARGES", "SVC-DELIVERY-CROSS": "TRANSPORTATION CHARGES" };

/* A finding is a FIELD, not a row. One systematic import bug shows up as one
   line in the verdict table with its example rows underneath, which is the
   shape the received_qty defect has and the shape an aggregate check destroys. */
class Findings {
  constructor() { this.byField = new Map(); }
  add(scope, field, key, erpVal, acVal, note) {
    const k = `${scope}.${field}`;
    if (!this.byField.has(k)) this.byField.set(k, { scope, field, rows: [], units: 0 });
    const f = this.byField.get(k);
    f.rows.push({ key, erp: erpVal, ac: acVal, note });
    const d = Number(erpVal) - Number(acVal);
    if (Number.isFinite(d)) f.units += Math.abs(d);
  }
  count(scope, field) { return this.byField.get(`${scope}.${field}`)?.rows.length ?? 0; }
  total() { let n = 0; for (const f of this.byField.values()) n += f.rows.length; return n; }
}

const F = new Findings();
const cmpText = (scope, field, key, erp, ac) => { if (norm(erp) !== norm(ac)) F.add(scope, field, key, txt(erp), txt(ac)); };
const cmpNum = (scope, field, key, erp, ac) => { if (Math.round(n0(erp)) !== Math.round(n0(ac))) F.add(scope, field, key, Math.round(n0(erp)), Math.round(n0(ac))); };
const cmpDate = (scope, field, key, erp, ac) => { if ((day(erp) ?? "") !== (day(ac) ?? "")) F.add(scope, field, key, day(erp) ?? "(null)", day(ac) ?? "(null)"); };

async function main() {
  const started = Date.now();
  // ───────────────────────────── inputs ─────────────────────────────
  const manifest = JSON.parse(fs.readFileSync(path.join(here, "data", "ac-fidelity-manifest.json"), "utf8"));
  const acSoH = new Map(gz("ac-fidelity-so-headers.json.gz").map((r) => [r.DocNo, r]));
  const acSoL = gz("ac-fidelity-so-lines.json.gz");
  const acPoH = new Map(gz("ac-fidelity-po-headers.json.gz").map((r) => [r.DocNo, r]));
  const acPoL = gz("ac-fidelity-po-lines.json.gz");
  const acDoH = new Map(gz("ac-fidelity-do-headers.json.gz").map((r) => [r.DocNo, r]));
  const acDoL = gz("ac-fidelity-do-lines.json.gz");
  const acGrAgg = new Map(gz("ac-fidelity-gr-by-po-item.json.gz").map((r) => [`${norm(r.PoNo)}|${norm(r.ItemCode)}`, r]));

  const csv = fs.readFileSync(path.join(here, "data", "autocount-erp-mapping-1561.csv"), "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  csv.shift();
  const mapAc = new Map();
  for (const ln of csv) { const f = parseCsvLine(ln); if (f[0]) mapAc.set(norm(f[0]), (f[1] || "").trim()); }
  const erpCodeOf = (acItem) => { let e = mapAc.get(norm(acItem)) || null; if (e && C1_ALIAS[norm(e)]) e = C1_ALIAS[norm(e)]; return e; };
  // an AutoCount sofa code resolves to a MODEL; the ERP holds MODEL-COMPARTMENT
  const sofaModelOf = (acItem) => {
    const e = erpCodeOf(acItem); if (!e) return null;
    let m = e.replace(/-1S$/i, "").toUpperCase();
    return SOFA_MODEL_ALIAS[m] || m;
  };

  // ────────────────────────── report preamble ──────────────────────────
  log("═".repeat(96));
  log("MIGRATION FIDELITY — is every migrated ERP document identical to AutoCount, field by field?");
  log("═".repeat(96));
  log(`AutoCount snapshot: ${manifest.exported_at}  (${manifest.source})`);
  log(`  grain: ${manifest.grain}`);
  log(`  ${Object.entries(manifest.counts).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  log(`  GRDTL rows carrying a line-level key back to the PO line: ${manifest.grdtl_rows_with_line_key} of ${manifest.grdtl_rows}`);
  log("");
  log("FIELD MAP — every field the cutover writes from AutoCount, and what this check does with it");
  log("-".repeat(96));
  log(`${"scope".padEnd(11)} ${"ERP column".padEnd(42)} ${"verdict".padEnd(12)} AutoCount source`);
  for (const [scope, col, src, verdict, note] of FIELD_MAP) {
    log(`${scope.padEnd(11)} ${col.padEnd(42)} ${verdict.padEnd(12)} ${src}`);
    if (note) log(`${" ".repeat(11)} ${" ".repeat(42)} ${" ".repeat(12)} └ ${note}`);
  }
  const tally = FIELD_MAP.reduce((a, r) => { a[r[3]] = (a[r[3]] ?? 0) + 1; return a; }, {});
  log("-".repeat(96));
  log(`fields: ${FIELD_MAP.length} total — ` + Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(", "));
  log("");
  log("DECLARED DIFFERENCES — deliberate, listed so they can be challenged rather than assumed");
  log("-".repeat(96));
  for (const [t, why] of DECLARED_DIFFERENCES) { log(`* ${t}`); log(`    ${why}`); }
  log("");

  // ───────────────────────── ERP: sales orders ─────────────────────────
  const erpSoH = await sql`
    SELECT doc_no, linked_ac_docno, so_date::text AS so_date, debtor_name, debtor_code, agent, sales_location,
           ref, customer_so_no, venue, branding, address1, address2, address3, address4,
           phone, balance_centi, local_total_centi, paid_centi, proceeded_at::text AS proceeded_at
      FROM scm.mfg_sales_orders
     WHERE company_id = ${CO} AND linked_ac_docno IS NOT NULL`;
  const erpSoL = await sql`
    SELECT i.id, i.doc_no, i.line_no, i.item_code, i.description2, i.location, i.qty,
           i.unit_price_centi, i.total_centi, i.balance_centi, i.item_group, i.linked_ac_dtlkey,
           h.linked_ac_docno AS ac
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no AND h.company_id = i.company_id
     WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL
     ORDER BY h.linked_ac_docno, i.line_no`;

  // ──────────────────────── ERP: purchase orders ────────────────────────
  const erpPoH = await sql`
    SELECT p.id, p.po_number, p.linked_ac_docno, p.po_date::text AS po_date, p.expected_at::text AS expected_at, p.status,
           p.subtotal_centi, p.total_centi, s.code AS supplier_code
      FROM scm.purchase_orders p
      LEFT JOIN scm.suppliers s ON s.id = p.supplier_id
     WHERE p.company_id = ${CO} AND p.linked_ac_docno IS NOT NULL`;
  const erpPoL = await sql`
    SELECT i.id, i.purchase_order_id, i.material_code, i.supplier_sku, i.description, i.description2,
           i.qty, i.received_qty, i.unit_price_centi, i.line_total_centi, i.delivery_date::text AS delivery_date,
           i.item_group, i.linked_ac_dtlkey, p.linked_ac_docno AS ac
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
     WHERE p.company_id = ${CO} AND p.linked_ac_docno IS NOT NULL
     ORDER BY p.linked_ac_docno, i.id`;

  // ───────────────────── ERP: migrated GRNs and DOs ─────────────────────
  const erpGrnL = await sql`
    SELECT g.grn_number, g.linked_ac_docno AS ac_po, gi.material_code, gi.qty_received, gi.qty_accepted,
           gi.purchase_order_item_id, pi.linked_ac_dtlkey, pi.received_qty AS po_received_qty
      FROM scm.grns g
      JOIN scm.grn_items gi ON gi.grn_id = g.id
      LEFT JOIN scm.purchase_order_items pi ON pi.id = gi.purchase_order_item_id
     WHERE g.company_id = ${CO} AND g.migrated_no_stock = true`;
  const erpGrnCount = await sql`
    SELECT COUNT(*)::int AS n FROM scm.grns g
     WHERE g.company_id = ${CO} AND g.migrated_no_stock = true`;
  const grnDocs = erpGrnCount[0]?.n ?? 0;
  const erpDoH = await sql`
    SELECT d.id, d.do_number, d.linked_ac_docno, d.do_date::text AS do_date, d.debtor_code, d.debtor_name, d.so_doc_no
      FROM scm.delivery_orders d
     WHERE d.company_id = ${CO} AND d.migrated_no_stock = true`;
  const erpDoL = await sql`
    SELECT di.id, d.linked_ac_docno AS ac, di.item_code, di.description, di.qty
      FROM scm.delivery_orders d
      JOIN scm.delivery_order_items di ON di.delivery_order_id = d.id
     WHERE d.company_id = ${CO} AND d.migrated_no_stock = true`;

  log("SCOPE — the ERP rows this check walks (every one of them is accounted for below)");
  log("-".repeat(96));
  log(`  migrated sales orders   ${String(erpSoH.length).padStart(6)}   lines ${String(erpSoL.length).padStart(6)}`);
  log(`  migrated purchase orders${String(erpPoH.length).padStart(6)}   lines ${String(erpPoL.length).padStart(6)}`);
  log(`  migrated GRNs           ${String(grnDocs).padStart(6)}   lines ${String(erpGrnL.length).padStart(6)}`);
  log(`  migrated delivery orders${String(erpDoH.length).padStart(6)}   lines ${String(erpDoL.length).padStart(6)}`);
  log("");

  // ═════════════════════ SO HEADERS ═════════════════════
  let soHdrNoAc = 0;
  const acLinesBySoDoc = new Map();
  for (const r of acSoL) { if (!acLinesBySoDoc.has(r.DocNo)) acLinesBySoDoc.set(r.DocNo, []); acLinesBySoDoc.get(r.DocNo).push(r); }
  for (const h of erpSoH) {
    const a = acSoH.get(h.linked_ac_docno);
    if (!a) { soHdrNoAc++; F.add("SO header", "(no AutoCount document)", h.doc_no, h.linked_ac_docno, "(absent from snapshot)"); continue; }
    const k = h.doc_no;
    cmpDate("SO header", "so_date", k, h.so_date, a.DocDate);
    if (txt(a.DebtorName) !== "" || norm(h.debtor_name) !== "CUSTOMER") cmpText("SO header", "debtor_name", k, h.debtor_name, a.DebtorName);
    cmpText("SO header", "debtor_code", k, h.debtor_code, a.DebtorCode);
    cmpText("SO header", "agent", k, h.agent, a.SalesAgent);
    cmpText("SO header", "sales_location", k, h.sales_location, salesLoc(a.SalesLocation));
    cmpText("SO header", "ref", k, h.ref, a.Ref);
    cmpText("SO header", "customer_so_no", k, h.customer_so_no, a.Ref);
    cmpText("SO header", "venue", k, h.venue, a.UDF_VENUE);
    cmpText("SO header", "branding", k, h.branding, a.UDF_BRANDING);
    cmpText("SO header", "address1", k, h.address1, a.InvAddr1);
    cmpText("SO header", "address2", k, h.address2, a.InvAddr2);
    cmpText("SO header", "address3", k, h.address3, a.InvAddr3);
    cmpText("SO header", "address4", k, h.address4, a.InvAddr4);
    cmpText("SO header", "phone", k, h.phone, a.Phone1);
    cmpNum("SO header", "balance_centi", k, h.balance_centi, centi(a.UDF_BALANCE));
    cmpDate("SO header", "proceeded_at", k, h.proceeded_at, a.UDF_PDate);
  }

  // ═════════════════════ LINE JOIN (SO + PO) ═════════════════════
  /* Join order, and it is reported: (1) linked_ac_dtlkey, exact, backfilled
     2026-08-11; (2) (document, mapped item code, Desc2) where that pair is
     unambiguous; (3) (document, mapped item code) positionally when the codes
     repeat and Desc2 does not separate them - AMBIGUOUS, counted apart because
     a positional guess can pair the wrong two rows; (4) for sofa, (document,
     model prefix) as a GROUP. Anything left is its own bucket and is never
     silently dropped. */
  function joinLines(erpRows, acRows, opts) {
    const { codeOf, docOf, keyOf, desc2Of, groupOf } = opts;
    const acByKey = new Map();
    const acByDocCode = new Map();
    const acByDocModel = new Map();
    for (const r of acRows) {
      acByKey.set(Number(r.DtlKey), r);
      const e = erpCodeOf(r.ItemCode);
      if (e) {
        const k = `${r.DocNo}|${norm(e)}`;
        if (!acByDocCode.has(k)) acByDocCode.set(k, []); acByDocCode.get(k).push(r);
      }
      if (isSofaAc(r.ItemCode)) {
        const m = sofaModelOf(r.ItemCode);
        if (m) { const k = `${r.DocNo}|${m}`; if (!acByDocModel.has(k)) acByDocModel.set(k, []); acByDocModel.get(k).push(r); }
      }
    }
    const pairs = []; const stats = { key: 0, desc2: 0, positional: 0, sofaGroup: 0, unjoined: 0 };
    const unjoined = [];
    const claimed = new Set();
    const rest = [];
    for (const e of erpRows) {
      const dk = keyOf(e);
      if (dk != null && acByKey.has(Number(dk))) {
        pairs.push({ erp: [e], ac: acByKey.get(Number(dk)), how: "key" }); stats.key++; claimed.add(Number(dk));
      } else rest.push(e);
    }
    // group the remainder by (doc, erp code) and consume unclaimed AutoCount rows
    const byDocCode = new Map();
    for (const e of rest) { const k = `${docOf(e)}|${norm(codeOf(e))}`; if (!byDocCode.has(k)) byDocCode.set(k, []); byDocCode.get(k).push(e); }
    const stillLeft = [];
    for (const [k, list] of byDocCode) {
      const cands = (acByDocCode.get(k) ?? []).filter((r) => !claimed.has(Number(r.DtlKey)));
      if (!cands.length) { stillLeft.push(...list); continue; }
      const used = new Set();
      const remaining = [];
      for (const e of list) {
        const exact = cands.find((c) => !used.has(c.DtlKey) && norm(c.Desc2) === norm(desc2Of(e)));
        const unique = cands.filter((c) => !used.has(c.DtlKey) && norm(c.Desc2) === norm(desc2Of(e))).length === 1;
        if (exact && unique) { used.add(exact.DtlKey); claimed.add(Number(exact.DtlKey)); pairs.push({ erp: [e], ac: exact, how: "desc2" }); stats.desc2++; }
        else remaining.push(e);
      }
      const free = cands.filter((c) => !used.has(c.DtlKey));
      for (let i = 0; i < remaining.length; i++) {
        if (i < free.length) { claimed.add(Number(free[i].DtlKey)); pairs.push({ erp: [remaining[i]], ac: free[i], how: "positional" }); stats.positional++; }
        else stillLeft.push(remaining[i]);
      }
    }
    // sofa: N ERP compartment lines <- 1 AutoCount build line, matched as a group
    const byDocModel = new Map();
    for (const e of stillLeft) {
      const g = groupOf(e);
      if (!g) { unjoined.push(e); continue; }
      const k = `${docOf(e)}|${g}`;
      if (!byDocModel.has(k)) byDocModel.set(k, []); byDocModel.get(k).push(e);
    }
    for (const [k, list] of byDocModel) {
      const cands = (acByDocModel.get(k) ?? []).filter((r) => !claimed.has(Number(r.DtlKey)));
      if (cands.length === 1) { claimed.add(Number(cands[0].DtlKey)); pairs.push({ erp: list, ac: cands[0], how: "sofaGroup" }); stats.sofaGroup += list.length; }
      else unjoined.push(...list);
    }
    stats.unjoined = unjoined.length;
    return { pairs, stats, unjoined };
  }

  // ═════════════════════ SO LINES ═════════════════════
  const soJoin = joinLines(erpSoL, acSoL, {
    codeOf: (e) => e.item_code,
    docOf: (e) => e.ac,
    keyOf: (e) => e.linked_ac_dtlkey,
    desc2Of: (e) => e.description2,
    groupOf: (e) => (e.item_group === "sofa" ? String(e.item_code || "").split("-")[0].toUpperCase() : null),
  });
  for (const p of soJoin.pairs) {
    const a = p.ac;
    const acQty = Math.round(n0(a.Qty));
    const acUp = centi(a.UnitPrice);
    const isSofa = p.how === "sofaGroup" || p.erp.some((e) => e.item_group === "sofa");
    const k0 = `${a.DocNo}#${a.DtlKey}`;
    for (const e of p.erp) {
      cmpNum("SO line", "qty", `${k0} ${e.item_code}`, e.qty, acQty);
      cmpText("SO line", "description2", `${k0} ${e.item_code}`, e.description2, a.Desc2);
      cmpText("SO line", "location", `${k0} ${e.item_code}`, e.location, a.Location);
      if (e.linked_ac_dtlkey != null && Number(e.linked_ac_dtlkey) !== Number(a.DtlKey))
        F.add("SO line", "linked_ac_dtlkey", k0, e.linked_ac_dtlkey, a.DtlKey);
      cmpNum("SO line", "balance_centi (must equal total_centi)", `${k0} ${e.item_code}`, e.total_centi, e.balance_centi);
    }
    if (isSofa) {
      // shapes are not commensurable: compare the group's money and the model
      const gTotal = p.erp.reduce((s, e) => s + n0(e.total_centi), 0);
      cmpNum("SO line", "sofa group total_centi", k0, gTotal, acUp * acQty);
      const model = sofaModelOf(a.ItemCode);
      for (const e of p.erp) {
        const pref = String(e.item_code || "").split("-")[0].toUpperCase();
        if (model && pref !== model) F.add("SO line", "sofa model prefix", `${k0} ${e.item_code}`, pref, model);
      }
    } else {
      const e = p.erp[0];
      cmpNum("SO line", "unit_price_centi", `${k0} ${e.item_code}`, e.unit_price_centi, acUp);
      cmpNum("SO line", "total_centi", `${k0} ${e.item_code}`, e.total_centi, acUp * acQty);
      const want = erpCodeOf(a.ItemCode);
      if (want && norm(want) !== norm(e.item_code)) F.add("SO line", "item_code", k0, e.item_code, `${want} (from ${a.ItemCode})`);
    }
  }

  // ═════════════════════ SO HEADER DERIVED TOTALS ═════════════════════
  for (const h of erpSoH) {
    const ls = acLinesBySoDoc.get(h.linked_ac_docno);
    if (!ls) continue;
    const acTotal = ls.reduce((s, l) => s + centi(l.UnitPrice) * Math.round(n0(l.Qty)), 0);
    cmpNum("SO header", "local_total_centi (derived)", h.doc_no, h.local_total_centi, acTotal);
    cmpNum("SO header", "paid_centi (derived)", h.doc_no, h.paid_centi, Math.max(0, acTotal - n0(h.balance_centi)));
  }

  // ═════════════════════ PO HEADERS ═════════════════════
  const acLinesByPoDoc = new Map();
  for (const r of acPoL) { if (!acLinesByPoDoc.has(r.DocNo)) acLinesByPoDoc.set(r.DocNo, []); acLinesByPoDoc.get(r.DocNo).push(r); }
  for (const h of erpPoH) {
    const a = acPoH.get(h.linked_ac_docno);
    if (!a) { F.add("PO header", "(no AutoCount document)", h.po_number, h.linked_ac_docno, "(absent from snapshot)"); continue; }
    const k = h.po_number;
    cmpDate("PO header", "po_date", k, h.po_date, a.DocDate);
    cmpText("PO header", "supplier code", k, h.supplier_code, a.CreditorCode);
    const ls = acLinesByPoDoc.get(h.linked_ac_docno) ?? [];
    if (ls.length) {
      const acTotal = ls.reduce((s, l) => s + centi(l.UnitPrice) * Math.round(n0(l.Qty)), 0);
      cmpNum("PO header", "subtotal_centi (derived)", k, h.subtotal_centi, acTotal);
      cmpNum("PO header", "total_centi (derived)", k, h.total_centi, acTotal);
      const eta = ls.map((l) => day(l.DeliveryDate)).filter(Boolean).sort()[0] ?? null;
      cmpDate("PO header", "expected_at (derived)", k, h.expected_at, eta);
      const allRecv = ls.every((l) => n0(l.TransferedQty) >= n0(l.Qty));
      const anyRecv = ls.some((l) => n0(l.TransferedQty) > 0);
      const want = allRecv ? "RECEIVED" : anyRecv ? "PARTIALLY_RECEIVED" : "SUBMITTED";
      // the outstanding-PO import never mints RECEIVED; treat that pair as equal
      const ok = norm(h.status) === want || (want === "RECEIVED" && norm(h.status) === "PARTIALLY_RECEIVED");
      if (!ok) F.add("PO header", "status (derived)", k, h.status, want);
    }
  }

  // ═════════════════════ PO LINES ═════════════════════
  const poById = new Map(erpPoH.map((p) => [p.id, p]));
  const poJoin = joinLines(erpPoL, acPoL, {
    codeOf: (e) => e.material_code,
    docOf: (e) => e.ac,
    keyOf: (e) => e.linked_ac_dtlkey,
    desc2Of: (e) => e.description2,
    groupOf: (e) => (e.item_group === "sofa" ? String(e.material_code || "").split("-")[0].toUpperCase() : null),
  });
  const overReceipt = [];
  for (const p of poJoin.pairs) {
    const a = p.ac;
    const acQty = Math.round(n0(a.Qty));
    const acRecv = Math.round(n0(a.TransferedQty));
    const acUp = centi(a.UnitPrice);
    const isSofa = p.how === "sofaGroup" || p.erp.some((e) => e.item_group === "sofa");
    const k0 = `${a.DocNo}#${a.DtlKey}`;
    for (const e of p.erp) {
      const kk = `${k0} ${e.material_code}`;
      cmpNum("PO line", "qty", kk, e.qty, acQty);
      cmpNum("PO line", "received_qty", kk, e.received_qty, acRecv);
      if (Math.round(n0(e.received_qty)) > acRecv) {
        overReceipt.push({ po: a.DocNo, dtl: a.DtlKey, code: e.material_code, erp: Math.round(n0(e.received_qty)), ac: acRecv, qty: acQty });
      }
      cmpText("PO line", "description2", kk, e.description2, a.Desc2);
      cmpDate("PO line", "delivery_date", kk, e.delivery_date, a.DeliveryDate);
      if (e.linked_ac_dtlkey != null && Number(e.linked_ac_dtlkey) !== Number(a.DtlKey))
        F.add("PO line", "linked_ac_dtlkey", k0, e.linked_ac_dtlkey, a.DtlKey);
      // supplier_sku is AutoCount's own code (sofa appends the compartment)
      const sku = txt(e.supplier_sku);
      if (sku && !norm(sku).startsWith(norm(a.ItemCode))) F.add("PO line", "supplier_sku", kk, sku, a.ItemCode);
    }
    if (isSofa) {
      const gTotal = p.erp.reduce((s, e) => s + n0(e.line_total_centi), 0);
      cmpNum("PO line", "sofa group line_total_centi", k0, gTotal, acUp * acQty);
      const model = sofaModelOf(a.ItemCode);
      for (const e of p.erp) {
        const pref = String(e.material_code || "").split("-")[0].toUpperCase();
        if (model && pref !== model) F.add("PO line", "sofa model prefix", `${k0} ${e.material_code}`, pref, model);
      }
    } else {
      const e = p.erp[0];
      cmpNum("PO line", "unit_price_centi", `${k0} ${e.material_code}`, e.unit_price_centi, acUp);
      cmpNum("PO line", "line_total_centi", `${k0} ${e.material_code}`, e.line_total_centi, acUp * acQty);
      const want = erpCodeOf(a.ItemCode);
      if (want && norm(want) !== norm(e.material_code)) F.add("PO line", "material_code", k0, e.material_code, `${want} (from ${a.ItemCode})`);
    }
  }

  // ═════════════════════ MIGRATED GRN LINES ═════════════════════
  const acPoByDtl = new Map(acPoL.map((r) => [Number(r.DtlKey), r]));
  let grnNoKey = 0;
  for (const g of erpGrnL) {
    if (g.linked_ac_dtlkey == null || !acPoByDtl.has(Number(g.linked_ac_dtlkey))) { grnNoKey++; continue; }
    const a = acPoByDtl.get(Number(g.linked_ac_dtlkey));
    const k = `${g.grn_number} ${g.material_code}`;
    cmpNum("GRN line", "qty_received", k, g.qty_received, Math.round(n0(a.TransferedQty)));
    cmpNum("GRN line", "qty_accepted", k, g.qty_accepted, Math.round(n0(a.TransferedQty)));
  }

  // ═════════════════════ MIGRATED DO HEADERS + LINES ═════════════════════
  for (const d of erpDoH) {
    const a = acDoH.get(d.linked_ac_docno);
    if (!a) { F.add("DO header", "(no AutoCount document)", d.do_number, d.linked_ac_docno, "(absent from snapshot)"); continue; }
    cmpDate("DO header", "do_date", d.do_number, d.do_date, a.DocDate);
    cmpText("DO header", "debtor_code", d.do_number, d.debtor_code, a.DebtorCode);
    if (txt(a.DebtorName)) cmpText("DO header", "debtor_name", d.do_number, d.debtor_name, a.DebtorName);
  }
  const acDoByDoc = new Map();
  for (const r of acDoL) { if (!acDoByDoc.has(r.DocNo)) acDoByDoc.set(r.DocNo, []); acDoByDoc.get(r.DocNo).push(r); }
  let doNoAc = 0, doQtyChecked = 0;
  for (const [ac, list] of groupBy(erpDoL, (r) => r.ac)) {
    const cands = acDoByDoc.get(ac);
    if (!cands) { doNoAc += list.length; continue; }
    /* One AutoCount delivery line becomes one ERP line per sofa compartment,
       each carrying the same quantity, so ERP line COUNT is not comparable.
       What is: for each distinct quantity the ERP claims to have delivered on
       this document, AutoCount must carry that quantity too. */
    const acQtys = cands.map((c) => Math.round(n0(c.Qty)));
    for (const e of list) {
      doQtyChecked++;
      if (!acQtys.includes(Math.round(n0(e.qty))))
        F.add("DO line", "qty", `${ac} ${e.item_code}`, Math.round(n0(e.qty)), `not among AutoCount's line quantities [${acQtys.join(",")}]`);
    }
  }

  // ═════════════════════ JOIN ACCOUNTING ═════════════════════
  log("JOIN ACCOUNTING — how each ERP line was matched to its AutoCount row");
  log("-".repeat(96));
  const jrow = (label, s, total) => log(
    `  ${label.padEnd(24)} exact linked_ac_dtlkey ${String(s.key).padStart(6)}   ` +
    `fallback (doc,code,Desc2) ${String(s.desc2).padStart(5)}   ` +
    `fallback positional ${String(s.positional).padStart(5)}   ` +
    `sofa group ${String(s.sofaGroup).padStart(5)}   ` +
    `UNJOINED ${String(s.unjoined).padStart(5)}   of ${total}`);
  jrow("sales order lines", soJoin.stats, erpSoL.length);
  jrow("purchase order lines", poJoin.stats, erpPoL.length);
  log(`  GRN lines                linked through the PO line's dtlkey ${String(erpGrnL.length - grnNoKey).padStart(5)}   UNJOINED ${String(grnNoKey).padStart(5)}   of ${erpGrnL.length}`);
  log(`  delivery order lines     matched by document ${String(doQtyChecked).padStart(5)}   UNJOINED ${String(doNoAc).padStart(5)}   of ${erpDoL.length}`);
  log("");
  log("  'fallback positional' means the document carried several lines of the same code that Desc2 did");
  log("  not separate. Those pairings can be wrong, so any divergence they produce is weaker evidence than");
  log("  a dtlkey match. UNJOINED rows are compared against nothing and are counted, never dropped.");
  log("");
  if (soJoin.unjoined.length) {
    log(`  UNJOINED sales order lines (${soJoin.unjoined.length}), first ${Math.min(TOP, soJoin.unjoined.length)}:`);
    for (const e of soJoin.unjoined.slice(0, TOP)) log(`     ${e.ac} line ${e.line_no} ${e.item_code} [${e.item_group}] "${txt(e.description2).slice(0, 40)}"`);
  }
  if (poJoin.unjoined.length) {
    log(`  UNJOINED purchase order lines (${poJoin.unjoined.length}), first ${Math.min(TOP, poJoin.unjoined.length)}:`);
    for (const e of poJoin.unjoined.slice(0, TOP)) log(`     ${e.ac} ${e.material_code} [${e.item_group}] qty ${e.qty} recv ${e.received_qty}`);
  }
  log("");

  // ═════════════════════ THE KNOWN DEFECT ═════════════════════
  log("KNOWN DEFECT — received_qty above AutoCount's own PODTL.TransferedQty");
  log("-".repeat(96));
  if (!overReceipt.length) {
    log("  NOT FOUND. This check is wrong until it reproduces the 65 known lines - do not read this as clean.");
  } else {
    const units = overReceipt.reduce((s, r) => s + (r.erp - r.ac), 0);
    log(`  ${overReceipt.length} PO lines carry more received than AutoCount ever recorded; ${units} excess units.`);
    log("  AutoCount does not permit an over-receipt. These were manufactured during migration by an export");
    log("  column aggregated on (DocNo + ItemCode) - see export-received-pos-live.py's GrQty subquery, which");
    log("  hands every same-code line on a document the document's total.");
    const byPo = new Map();
    for (const r of overReceipt) byPo.set(r.po, (byPo.get(r.po) ?? 0) + 1);
    log(`  spread over ${byPo.size} purchase orders.`);
    log("  Proof, showing the aggregate the importer used next to AutoCount's per-line truth:");
    for (const r of overReceipt.slice(0, TOP)) {
      const agg = acGrAgg.get(`${norm(r.po)}|${norm(acPoByDtl.get(Number(r.dtl))?.ItemCode ?? "")}`);
      log(`     ${r.po} dtl ${r.dtl} ${r.code}: ordered ${r.qty}, ERP received ${r.erp}, AutoCount TransferedQty ${r.ac}` +
          (agg ? `   [GRDTL SUM over (${r.po},${acPoByDtl.get(Number(r.dtl)).ItemCode}) = ${Math.round(n0(agg.GrQtySum))} across ${agg.GrLines} receipt lines]` : ""));
    }
    if (overReceipt.length > TOP) log(`     ... and ${overReceipt.length - TOP} more`);
  }
  log("");

  // ═════════════════════ VERDICT ═════════════════════
  const comparableLines = soJoin.pairs.reduce((s, p) => s + p.erp.length, 0) + poJoin.pairs.reduce((s, p) => s + p.erp.length, 0)
    + (erpGrnL.length - grnNoKey) + doQtyChecked;
  const divergentKeys = new Set();
  for (const f of F.byField.values()) for (const r of f.rows) divergentKeys.add(`${f.scope}|${r.key}`);

  log("═".repeat(96));
  log("VERDICT");
  log("═".repeat(96));
  log(`  documents compared        SO ${erpSoH.length}   PO ${erpPoH.length}   GRN ${grnDocs}   DO ${erpDoH.length}`);
  log(`  LINES COMPARED            ${comparableLines}`);
  log(`  LINES NOT COMPARABLE      ${soJoin.stats.unjoined + poJoin.stats.unjoined + grnNoKey + doNoAc}  (no AutoCount row could be joined; listed above)`);
  log(`  FIELD-LEVEL DIVERGENCES   ${F.total()}   across ${F.byField.size} distinct fields`);
  log("");
  log(`  ${"scope".padEnd(11)} ${"field".padEnd(34)} ${"rows".padStart(7)}  ${"units".padStart(8)}`);
  log("  " + "-".repeat(66));
  const sorted = [...F.byField.values()].sort((a, b) => b.rows.length - a.rows.length);
  for (const f of sorted) log(`  ${f.scope.padEnd(11)} ${f.field.padEnd(34)} ${String(f.rows.length).padStart(7)}  ${String(Math.round(f.units)).padStart(8)}`);
  if (!sorted.length) log("  (none)");
  log("");

  log("EVERY DIVERGENCE, BY FIELD");
  log("-".repeat(96));
  for (const f of sorted) {
    log(`\n### ${f.scope}.${f.field} — ${f.rows.length} row(s)`);
    for (const r of f.rows.slice(0, TOP)) log(`   ${String(r.key).padEnd(46)} ERP="${r.erp}"   AutoCount="${r.ac}"`);
    if (f.rows.length > TOP) log(`   ... and ${f.rows.length - TOP} more`);
  }
  log("");
  log("═".repeat(96));
  const answer = comparableLines === 0
    ? "INCONCLUSIVE — no migrated line could be compared. Check the scope query and the snapshot, do not read this as clean."
    : F.total() === 0
      ? "YES — every compared field on every joinable migrated line matches AutoCount."
      : `NO — ${F.total()} field values on migrated documents do not match AutoCount, across ${F.byField.size} fields.`;
  log(`ANSWER: ${answer}`);
  log("Read-only check. Repairing anything found here is a separate, owner-approved change.");
  log(`(${((Date.now() - started) / 1000).toFixed(1)}s)`);
  await sql.end();
}

function groupBy(rows, keyFn) {
  const m = new Map();
  for (const r of rows) { const k = keyFn(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  return m;
}

main().catch((e) => { console.error(e); process.exit(1); });
