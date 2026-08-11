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
   naive slice(0,10) would turn every date comparison into a false mismatch. */
const day = (v) => (v == null ? null : String(v).slice(0, 10));
const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };

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
  ["SO header", "venue", "SO.UDF_VENUE", "COMPARED", "canonicalised post-migration; the check separates label canonicalisation from a different place"],
  ["SO header", "branding", "SO.UDF_BRANDING", "COMPARED", ""],
  ["SO header", "address1..address4", "SO.InvAddr1..InvAddr4", "COMPARED", ""],
  ["SO header", "phone", "SO.Phone1", "COMPARED", ""],
  ["SO header", "balance_centi", "SO.UDF_BALANCE x 100", "COMPARED", ""],
  ["SO header", "proceeded_at", "SO.UDF_PDate", "COMPARED", ""],
  ["SO header", "local_total_centi", "SUM over SODTL of round(UnitPrice x100) x round(Qty)", "DERIVED", "the ERP's own line sum is printed beside it, so a header/line disagreement is distinguishable from a missing line"],
  ["SO header", "paid_centi / deposit_centi", "local_total - UDF_BALANCE", "DERIVED", ""],
  ["SO header", "salesperson_id", "SO.SalesAgent via agent-staff-binding.csv", "DECLARED", "a UUID, not an AutoCount value; the source text is compared as `agent`"],
  ["SO header", "venue_id", "SO.UDF_VENUE resolved to scm.venues", "DECLARED", "a UUID; the source text is compared as `venue`"],
  ["SO header", "postcode / city / customer_state", "parsed out of InvAddr1..4", "DECLARED", "derived from a free-text address, no AutoCount column to compare against"],
  ["SO header", "emergency_contact_phone", "SO.DeliverPhone1 or 2nd number in Phone1", "NOT-CHECKED", "conditional derivation; low risk, no per-line multiplier"],
  ["SO header", "payment_method / approval_code / payment_date", "SO.UDF_PAYEMENT, SO.DocDate", "NOT-CHECKED", "free-text payment blob parsed into two fields"],
  ["SO header", "status / currency / company_id", "constant", "DECLARED", "not from AutoCount"],
  ["SO header", "line_count / category subtotals", "counted over the ERP's own lines", "DECLARED", "sofa decomposition changes the line count by design"],
  // ---- sales order line ----
  ["SO line", "linked_ac_dtlkey", "SODTL.DtlKey", "COMPARED", "the exact join key where present; a key pointing at no AutoCount row is reported"],
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
  ["PO line", "description", "PODTL.Description", "NOT-CHECKED", "one importer writes AutoCount's text, the other the ERP product name; both are legitimate, so a comparison here only measures which importer ran"],
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
  ["DO line", "description", "DODTL.Description", "NOT-CHECKED", "the AutoCount line text rides through unchanged; not a quantitative field"],
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
  ["Venue labels were canonicalised AFTER the import", "backfill-canonicalize-venue.mjs / normalize-venue-aliases.mjs / standardize-venues rewrote SO.venue to the ERP's canonical venue name. Where the ERP value is a prefix or extension of AutoCount's the check labels it canonicalisation; where it names a different place it is reported as unexplained."],
  ["18 surplus migrated DO lines were zeroed, not deleted", "zero-duplicate-do-lines.mjs (#1964, owner-approved, docs/migrated-do-duplicate-lines.md). create-migrated-documents.mjs inserted some delivery lines twice; the duplicate row STAYS with qty 0 because the owner's rule is nothing is deleted, only cancelled. An ERP DO line at qty 0 against a non-zero AutoCount line is that repair, and is labelled as such rather than counted as a migration defect."],
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
   shape the received_qty defect has and the shape an aggregate check destroys.

   `cause` names a KNOWN, already-decided reason for a row's divergence. Rows
   with a cause are still printed - the owner asked whether the data is
   identical, and the honest answer includes the deliberate changes - but they
   are counted apart from the unexplained ones, which are the defects. */
class Findings {
  constructor() { this.byField = new Map(); }
  add(scope, field, key, erpVal, acVal, cause = null, how = null) {
    const k = `${scope}.${field}`;
    if (!this.byField.has(k)) this.byField.set(k, { scope, field, rows: [], units: 0 });
    const f = this.byField.get(k);
    f.rows.push({ key, erp: erpVal, ac: acVal, cause, how });
    const d = Number(erpVal) - Number(acVal);
    if (Number.isFinite(d)) f.units += Math.abs(d);
  }
  total() { let n = 0; for (const f of this.byField.values()) n += f.rows.length; return n; }
  unexplained() { let n = 0; for (const f of this.byField.values()) n += f.rows.filter((r) => !r.cause).length; return n; }
}

const F = new Findings();
const cmpText = (scope, field, key, erp, ac, how) => { if (norm(erp) !== norm(ac)) F.add(scope, field, key, txt(erp), txt(ac), null, how); };
const cmpNum = (scope, field, key, erp, ac, how) => { if (Math.round(n0(erp)) !== Math.round(n0(ac))) F.add(scope, field, key, Math.round(n0(erp)), Math.round(n0(ac)), null, how); };
const cmpDate = (scope, field, key, erp, ac, how) => { if ((day(erp) ?? "") !== (day(ac) ?? "")) F.add(scope, field, key, day(erp) ?? "(null)", day(ac) ?? "(null)", null, how); };

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
  /* An AutoCount sofa line names a MODEL; the ERP holds MODEL-COMPARTMENT. The
     AutoCount side is sofa when its code says so OR when the code it maps to is
     a sofa base SKU - "RDS-8133 SOFA" and a mapped "8133-1S" are the same fact
     said two ways, and testing only the first misses the second. */
  const sofaModelOf = (acItem) => {
    const e = erpCodeOf(acItem); if (!e) return null;
    const m = e.replace(/-1S$/i, "").toUpperCase();
    return SOFA_MODEL_ALIAS[m] || m;
  };
  const acIsSofa = (r) => /SOFA/i.test(r.ItemCode || "") || /-1S$/i.test(erpCodeOf(r.ItemCode) || "");

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

  // ───────────────────────────── ERP scope ─────────────────────────────
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
  const erpPoH = await sql`
    SELECT p.id, p.po_number, p.linked_ac_docno, p.po_date::text AS po_date, p.expected_at::text AS expected_at,
           p.status, p.subtotal_centi, p.total_centi, s.code AS supplier_code
      FROM scm.purchase_orders p
      LEFT JOIN scm.suppliers s ON s.id = p.supplier_id
     WHERE p.company_id = ${CO} AND p.linked_ac_docno IS NOT NULL`;
  const erpPoL = await sql`
    SELECT i.id, i.purchase_order_id, i.material_code, i.supplier_sku, i.description2,
           i.qty, i.received_qty, i.unit_price_centi, i.line_total_centi, i.delivery_date::text AS delivery_date,
           i.item_group, i.linked_ac_dtlkey, p.linked_ac_docno AS ac
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
     WHERE p.company_id = ${CO} AND p.linked_ac_docno IS NOT NULL
     ORDER BY p.linked_ac_docno, i.id`;
  const erpGrnL = await sql`
    SELECT g.grn_number, g.linked_ac_docno AS ac_po, gi.material_code, gi.qty_received, gi.qty_accepted,
           gi.purchase_order_item_id
      FROM scm.grns g
      JOIN scm.grn_items gi ON gi.grn_id = g.id
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

  // ═════════════════════ LINE JOIN (SO + PO) ═════════════════════
  /* Join order, and it is reported:
       1. SOFA FIRST, as a group. A build's compartments must be claimed
          together, before an exact-code match on one of them can steal the
          AutoCount row and orphan its siblings - that is precisely what hid 14
          over-received sofa lines on the first run of this check.
       2. linked_ac_dtlkey, exact.
       3. (document, mapped item code, Desc2) where that pair is unambiguous.
       4. (document, mapped item code) positionally when the codes repeat and
          Desc2 does not separate them. AMBIGUOUS, counted and labelled apart,
          because a positional guess can pair the wrong two rows.
     Anything left is its own bucket and is never silently dropped. */
  function joinLines(erpRows, acRows, opts) {
    const { codeOf, docOf, keyOf, desc2Of, isSofaErp, modelOf } = opts;
    const acByKey = new Map(), acByDocCode = new Map(), acByDocModel = new Map();
    for (const r of acRows) {
      acByKey.set(Number(r.DtlKey), r);
      const e = erpCodeOf(r.ItemCode);
      if (e) push(acByDocCode, `${r.DocNo}|${norm(e)}`, r);
      if (acIsSofa(r)) { const m = sofaModelOf(r.ItemCode); if (m) push(acByDocModel, `${r.DocNo}|${m}`, r); }
    }
    const claimed = new Set();
    const claim = (r) => claimed.add(Number(r.DtlKey));
    const pairs = [], unjoined = [], danglingKeys = [];
    const stats = { sofaGroup: 0, sofaIndistinct: 0, key: 0, desc2: 0, positional: 0, unjoined: 0 };

    for (const e of erpRows) { const k = keyOf(e); if (k != null && !acByKey.has(Number(k))) danglingKeys.push(e); }

    // 1. sofa builds
    const bySofa = new Map();
    const plain = [];
    for (const e of erpRows) {
      if (!isSofaErp(e)) { plain.push(e); continue; }
      const m = modelOf(e);
      if (!m) { unjoined.push(e); continue; }
      push(bySofa, `${docOf(e)}|${m}`, e);
    }
    for (const [k, list] of bySofa) {
      const cands = acByDocModel.get(k) ?? [];
      if (!cands.length) { unjoined.push(...list); continue; }
      if (cands.length === 1) { claim(cands[0]); pairs.push({ erp: list, ac: cands[0], how: "sofaGroup" }); stats.sofaGroup += list.length; continue; }
      // several AutoCount builds of one model on one document: split on Desc2
      const acByD2 = new Map(); for (const c of cands) push(acByD2, norm(c.Desc2), c);
      const erpByD2 = new Map(); for (const e of list) push(erpByD2, norm(desc2Of(e)), e);
      const splittable = [...erpByD2.keys()].every((d2) => (acByD2.get(d2) ?? []).length === 1);
      if (splittable) {
        for (const [d2, es] of erpByD2) { const c = acByD2.get(d2)[0]; claim(c); pairs.push({ erp: es, ac: c, how: "sofaGroup" }); stats.sofaGroup += es.length; }
        continue;
      }
      /* Desc2 does not separate them. If every candidate is INDISTINGUISHABLE
         on all compared fields, which build a compartment belongs to cannot be
         determined AND cannot change any comparison - so pair against the first
         and label it, rather than dropping real rows over a distinction with no
         consequence. Otherwise the rows stay unjoined and are reported. */
      const sig = (c) => [norm(c.Desc2), Math.round(n0(c.Qty)), Math.round(n0(c.TransferedQty ?? 0)), centi(c.UnitPrice), day(c.DeliveryDate) ?? "", norm(c.Location)].join("|");
      if (new Set(cands.map(sig)).size === 1) {
        for (const c of cands) claim(c);
        pairs.push({ erp: list, ac: cands[0], how: "sofaIndistinct" }); stats.sofaIndistinct += list.length;
      } else unjoined.push(...list);
    }

    // 2. exact detail key
    const rest = [];
    for (const e of plain) {
      const dk = keyOf(e);
      if (dk != null && acByKey.has(Number(dk)) && !claimed.has(Number(dk))) {
        const a = acByKey.get(Number(dk)); claim(a); pairs.push({ erp: [e], ac: a, how: "key" }); stats.key++;
      } else rest.push(e);
    }

    // 3/4. (doc, code) with Desc2, then positional
    const byDocCode = new Map();
    for (const e of rest) push(byDocCode, `${docOf(e)}|${norm(codeOf(e))}`, e);
    for (const [k, list] of byDocCode) {
      const cands = (acByDocCode.get(k) ?? []).filter((r) => !claimed.has(Number(r.DtlKey)));
      if (!cands.length) { unjoined.push(...list); continue; }
      const used = new Set(); const remaining = [];
      for (const e of list) {
        const hits = cands.filter((c) => !used.has(c.DtlKey) && norm(c.Desc2) === norm(desc2Of(e)));
        if (hits.length === 1) { used.add(hits[0].DtlKey); claim(hits[0]); pairs.push({ erp: [e], ac: hits[0], how: "desc2" }); stats.desc2++; }
        else remaining.push(e);
      }
      const free = cands.filter((c) => !used.has(c.DtlKey));
      for (let i = 0; i < remaining.length; i++) {
        if (i < free.length) { claim(free[i]); pairs.push({ erp: [remaining[i]], ac: free[i], how: "positional" }); stats.positional++; }
        else unjoined.push(remaining[i]);
      }
    }
    stats.unjoined = unjoined.length;
    return { pairs, stats, unjoined, claimed, danglingKeys };
  }

  const soJoin = joinLines(erpSoL, acSoL, {
    codeOf: (e) => e.item_code, docOf: (e) => e.ac, keyOf: (e) => e.linked_ac_dtlkey,
    desc2Of: (e) => e.description2,
    isSofaErp: (e) => e.item_group === "sofa",
    modelOf: (e) => String(e.item_code || "").split("-")[0].toUpperCase() || null,
  });
  const poJoin = joinLines(erpPoL, acPoL, {
    codeOf: (e) => e.material_code, docOf: (e) => e.ac, keyOf: (e) => e.linked_ac_dtlkey,
    desc2Of: (e) => e.description2,
    isSofaErp: (e) => e.item_group === "sofa",
    modelOf: (e) => String(e.material_code || "").split("-")[0].toUpperCase() || null,
  });

  // ═════════════════════ SO LINES ═════════════════════
  for (const p of soJoin.pairs) {
    const a = p.ac, how = p.how;
    const acQty = Math.round(n0(a.Qty)), acUp = centi(a.UnitPrice);
    const isSofa = how === "sofaGroup" || how === "sofaIndistinct";
    const k0 = `${a.DocNo}#${a.DtlKey}`;
    for (const e of p.erp) {
      const kk = `${k0} ${e.item_code}`;
      cmpNum("SO line", "qty", kk, e.qty, acQty, how);
      cmpText("SO line", "description2", kk, e.description2, a.Desc2, how);
      cmpText("SO line", "location", kk, e.location, a.Location, how);
      cmpNum("SO line", "balance_centi (must equal total_centi)", kk, e.balance_centi, e.total_centi, how);
    }
    if (isSofa) {
      const gTotal = p.erp.reduce((s, e) => s + n0(e.total_centi), 0);
      cmpNum("SO line", "sofa build total_centi", k0, gTotal, acUp * acQty, how);
      const model = sofaModelOf(a.ItemCode);
      for (const e of p.erp) {
        const pref = String(e.item_code || "").split("-")[0].toUpperCase();
        if (model && pref !== model) F.add("SO line", "sofa model prefix", `${k0} ${e.item_code}`, pref, model, null, how);
      }
    } else {
      const e = p.erp[0];
      cmpNum("SO line", "unit_price_centi", `${k0} ${e.item_code}`, e.unit_price_centi, acUp, how);
      cmpNum("SO line", "total_centi", `${k0} ${e.item_code}`, e.total_centi, acUp * acQty, how);
      const want = erpCodeOf(a.ItemCode);
      if (want && norm(want) !== norm(e.item_code)) F.add("SO line", "item_code", k0, e.item_code, `${want} (from ${a.ItemCode})`, null, how);
    }
  }
  for (const e of soJoin.danglingKeys) F.add("SO line", "linked_ac_dtlkey points at no AutoCount row", `${e.ac} line ${e.line_no} ${e.item_code}`, e.linked_ac_dtlkey, "(no such DtlKey)");

  // ═════════════════════ SO HEADERS ═════════════════════
  const acLinesBySoDoc = new Map();
  for (const r of acSoL) push(acLinesBySoDoc, r.DocNo, r);
  const erpLinesBySoDoc = new Map();
  for (const r of erpSoL) push(erpLinesBySoDoc, r.ac, r);
  for (const h of erpSoH) {
    const a = acSoH.get(h.linked_ac_docno);
    if (!a) { F.add("SO header", "(no AutoCount document)", h.doc_no, h.linked_ac_docno, "(absent from snapshot)"); continue; }
    const k = h.doc_no;
    cmpDate("SO header", "so_date", k, h.so_date, a.DocDate);
    if (txt(a.DebtorName) !== "" || norm(h.debtor_name) !== "CUSTOMER") cmpText("SO header", "debtor_name", k, h.debtor_name, a.DebtorName);
    cmpText("SO header", "debtor_code", k, h.debtor_code, a.DebtorCode);
    cmpText("SO header", "agent", k, h.agent, a.SalesAgent);
    cmpText("SO header", "sales_location", k, h.sales_location, salesLoc(a.SalesLocation));
    cmpText("SO header", "ref", k, h.ref, a.Ref);
    cmpText("SO header", "customer_so_no", k, h.customer_so_no, a.Ref);
    cmpText("SO header", "branding", k, h.branding, a.UDF_BRANDING);
    cmpText("SO header", "address1", k, h.address1, a.InvAddr1);
    cmpText("SO header", "address2", k, h.address2, a.InvAddr2);
    cmpText("SO header", "address3", k, h.address3, a.InvAddr3);
    cmpText("SO header", "address4", k, h.address4, a.InvAddr4);
    cmpText("SO header", "phone", k, h.phone, a.Phone1);
    cmpNum("SO header", "balance_centi", k, h.balance_centi, centi(a.UDF_BALANCE));
    cmpDate("SO header", "proceeded_at", k, h.proceeded_at, a.UDF_PDate);
    // venue: separate a canonicalised LABEL from a different PLACE
    if (norm(h.venue) !== norm(a.UDF_VENUE)) {
      const e = norm(h.venue), c = norm(a.UDF_VENUE);
      const canon = e && c && (c.startsWith(e) || e.startsWith(c));
      F.add("SO header", canon ? "venue (label canonicalised)" : "venue", k, txt(h.venue), txt(a.UDF_VENUE),
        canon ? "post-import venue canonicalisation" : null);
    }
    // derived money, with the ERP's OWN line sum beside it so a header/line
    // disagreement is distinguishable from a missing or extra line
    const acLs = acLinesBySoDoc.get(h.linked_ac_docno) ?? [];
    const erpLs = erpLinesBySoDoc.get(h.linked_ac_docno) ?? [];
    if (acLs.length) {
      const acTotal = acLs.reduce((s, l) => s + centi(l.UnitPrice) * Math.round(n0(l.Qty)), 0);
      const erpLineSum = erpLs.reduce((s, l) => s + n0(l.total_centi), 0);
      if (Math.round(n0(h.local_total_centi)) !== acTotal)
        F.add("SO header", "local_total_centi (derived)", k, `${Math.round(n0(h.local_total_centi))} (its own lines sum to ${erpLineSum})`, acTotal);
      const wantPaid = Math.max(0, acTotal - n0(h.balance_centi));
      cmpNum("SO header", "paid_centi (derived)", k, h.paid_centi, wantPaid);
    }
  }

  // ═════════════════════ PO LINES ═════════════════════
  const overReceipt = [];
  const acPoByDtl = new Map(acPoL.map((r) => [Number(r.DtlKey), r]));
  const poItemToAc = new Map();
  for (const p of poJoin.pairs) {
    const a = p.ac, how = p.how;
    const acQty = Math.round(n0(a.Qty)), acRecv = Math.round(n0(a.TransferedQty)), acUp = centi(a.UnitPrice);
    const isSofa = how === "sofaGroup" || how === "sofaIndistinct";
    const k0 = `${a.DocNo}#${a.DtlKey}`;
    for (const e of p.erp) {
      poItemToAc.set(e.id, a);
      const kk = `${k0} ${e.material_code}`;
      cmpNum("PO line", "qty", kk, e.qty, acQty, how);
      cmpNum("PO line", "received_qty", kk, e.received_qty, acRecv, how);
      if (Math.round(n0(e.received_qty)) > acRecv)
        overReceipt.push({ po: a.DocNo, dtl: a.DtlKey, item: a.ItemCode, code: e.material_code, erp: Math.round(n0(e.received_qty)), ac: acRecv, qty: acQty, how });
      cmpText("PO line", "description2", kk, e.description2, a.Desc2, how);
      cmpDate("PO line", "delivery_date", kk, e.delivery_date, a.DeliveryDate, how);
      const sku = txt(e.supplier_sku);
      if (sku && !norm(sku).startsWith(norm(a.ItemCode))) F.add("PO line", "supplier_sku", kk, sku, a.ItemCode, null, how);
    }
    if (isSofa) {
      const gTotal = p.erp.reduce((s, e) => s + n0(e.line_total_centi), 0);
      cmpNum("PO line", "sofa build line_total_centi", k0, gTotal, acUp * acQty, how);
      const model = sofaModelOf(a.ItemCode);
      for (const e of p.erp) {
        const pref = String(e.material_code || "").split("-")[0].toUpperCase();
        if (model && pref !== model) F.add("PO line", "sofa model prefix", `${k0} ${e.material_code}`, pref, model, null, how);
      }
    } else {
      const e = p.erp[0];
      cmpNum("PO line", "unit_price_centi", `${k0} ${e.material_code}`, e.unit_price_centi, acUp, how);
      cmpNum("PO line", "line_total_centi", `${k0} ${e.material_code}`, e.line_total_centi, acUp * acQty, how);
      const want = erpCodeOf(a.ItemCode);
      if (want && norm(want) !== norm(e.material_code)) F.add("PO line", "material_code", k0, e.material_code, `${want} (from ${a.ItemCode})`, null, how);
    }
  }
  for (const e of poJoin.danglingKeys) F.add("PO line", "linked_ac_dtlkey points at no AutoCount row", `${e.ac} ${e.material_code}`, e.linked_ac_dtlkey, "(no such DtlKey)");

  // ═════════════════════ PO HEADERS ═════════════════════
  const acLinesByPoDoc = new Map();
  for (const r of acPoL) push(acLinesByPoDoc, r.DocNo, r);
  const erpLinesByPoDoc = new Map();
  for (const r of erpPoL) push(erpLinesByPoDoc, r.ac, r);
  for (const h of erpPoH) {
    const a = acPoH.get(h.linked_ac_docno);
    if (!a) { F.add("PO header", "(no AutoCount document)", h.po_number, h.linked_ac_docno, "(absent from snapshot)"); continue; }
    const k = h.po_number;
    cmpDate("PO header", "po_date", k, h.po_date, a.DocDate);
    cmpText("PO header", "supplier code", k, h.supplier_code, a.CreditorCode);
    const ls = acLinesByPoDoc.get(h.linked_ac_docno) ?? [];
    if (ls.length) {
      const acTotal = ls.reduce((s, l) => s + centi(l.UnitPrice) * Math.round(n0(l.Qty)), 0);
      const erpLineSum = (erpLinesByPoDoc.get(h.linked_ac_docno) ?? []).reduce((s, l) => s + n0(l.line_total_centi), 0);
      if (Math.round(n0(h.subtotal_centi)) !== acTotal)
        F.add("PO header", "subtotal_centi (derived)", k, `${Math.round(n0(h.subtotal_centi))} (its own lines sum to ${erpLineSum})`, acTotal);
      cmpNum("PO header", "total_centi (derived)", k, h.total_centi, acTotal);
      const eta = ls.map((l) => day(l.DeliveryDate)).filter(Boolean).sort()[0] ?? null;
      cmpDate("PO header", "expected_at (derived)", k, h.expected_at, eta);
      /* Ordered quantity 0 is not "fully received"; counting it as such made
         three zero-quantity purchase orders read RECEIVED. Only lines that
         actually order something decide the status. */
      const real = ls.filter((l) => n0(l.Qty) > 0);
      if (real.length) {
        const want = real.every((l) => n0(l.TransferedQty) >= n0(l.Qty)) ? "RECEIVED"
          : real.some((l) => n0(l.TransferedQty) > 0) ? "PARTIALLY_RECEIVED" : "SUBMITTED";
        const ok = norm(h.status) === want || (want === "RECEIVED" && norm(h.status) === "PARTIALLY_RECEIVED");
        if (!ok) F.add("PO header", "status (derived)", k, h.status, want);
      }
    }
  }

  // ═════════ AutoCount lines on a migrated document with NO ERP line ═════════
  /* The counterpart of the unjoined bucket, and the thing a header total gap
     usually turns out to be. Only documents the ERP actually holds are looked
     at - an unimported document is a decision, not a gap. */
  const migratedSoDocs = new Set(erpSoH.map((h) => h.linked_ac_docno));
  const migratedPoDocs = new Set(erpPoH.map((h) => h.linked_ac_docno));
  let missingSo = 0, missingPo = 0;
  for (const r of acSoL) {
    if (!migratedSoDocs.has(r.DocNo) || soJoin.claimed.has(Number(r.DtlKey))) continue;
    missingSo++;
    F.add("SO line", "(AutoCount line with no ERP line)", `${r.DocNo}#${r.DtlKey} ${r.ItemCode}`,
      "(absent)", `qty ${Math.round(n0(r.Qty))} @ ${centi(r.UnitPrice)} "${txt(r.Desc2).slice(0, 30)}"`);
  }
  for (const r of acPoL) {
    if (!migratedPoDocs.has(r.DocNo) || poJoin.claimed.has(Number(r.DtlKey))) continue;
    missingPo++;
    F.add("PO line", "(AutoCount line with no ERP line)", `${r.DocNo}#${r.DtlKey} ${r.ItemCode}`,
      "(absent)", `qty ${Math.round(n0(r.Qty))} recv ${Math.round(n0(r.TransferedQty))} @ ${centi(r.UnitPrice)}`);
  }

  // ═════════════════════ MIGRATED GRN LINES ═════════════════════
  /* A GRN line joins through the PURCHASE ORDER LINE it received, using
     whatever method that line joined by - requiring the PO line to carry a
     linked_ac_dtlkey compared only 10 of 496 lines on the first run, because
     only 275 of 864 PO lines have one. */
  let grnNoKey = 0;
  for (const g of erpGrnL) {
    const a = poItemToAc.get(g.purchase_order_item_id);
    if (!a) { grnNoKey++; continue; }
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
  for (const r of acDoL) push(acDoByDoc, r.DocNo, r);
  let doNoAc = 0, doQtyChecked = 0;
  const byDoDoc = new Map();
  for (const r of erpDoL) push(byDoDoc, r.ac, r);
  for (const [ac, list] of byDoDoc) {
    const cands = acDoByDoc.get(ac);
    if (!cands) { doNoAc += list.length; continue; }
    /* One AutoCount delivery line becomes one ERP line per sofa compartment,
       each carrying the same quantity, so the ERP line COUNT is not comparable.
       What is: every quantity the ERP claims to have delivered on this document
       must be a quantity AutoCount also carries on it. */
    const acQtys = cands.map((c) => Math.round(n0(c.Qty)));
    for (const e of list) {
      doQtyChecked++;
      const q = Math.round(n0(e.qty));
      if (!acQtys.includes(q)) {
        F.add("DO line", "qty", `${ac} ${e.item_code}`, q, `not among AutoCount's line quantities [${acQtys.join(",")}]`,
          q === 0 ? "surplus migrated DO line zeroed by #1964 (owner-approved; the row stays, nothing is deleted)" : null);
      }
    }
  }

  // ═════════════════════ JOIN ACCOUNTING ═════════════════════
  log("JOIN ACCOUNTING — how each ERP line was matched to its AutoCount row");
  log("-".repeat(96));
  const jrow = (label, s, total) => log(
    `  ${label.padEnd(22)} sofa build ${String(s.sofaGroup).padStart(5)}  sofa indistinct ${String(s.sofaIndistinct).padStart(4)}  ` +
    `dtlkey ${String(s.key).padStart(6)}  (doc,code,Desc2) ${String(s.desc2).padStart(5)}  ` +
    `positional ${String(s.positional).padStart(4)}  UNJOINED ${String(s.unjoined).padStart(5)}   of ${total}`);
  jrow("sales order lines", soJoin.stats, erpSoL.length);
  jrow("purchase order lines", poJoin.stats, erpPoL.length);
  log(`  GRN lines              joined through their purchase order line ${String(erpGrnL.length - grnNoKey).padStart(5)}  UNJOINED ${String(grnNoKey).padStart(5)}   of ${erpGrnL.length}`);
  log(`  delivery order lines   matched by document ${String(doQtyChecked).padStart(5)}  UNJOINED ${String(doNoAc).padStart(5)}   of ${erpDoL.length}`);
  log("");
  log("  'positional' means the document carried several lines of the same code that Desc2 did not");
  log("  separate; those pairings can be wrong, so a divergence they produce is weaker evidence than a");
  log("  dtlkey match and is tagged [positional] in the listing below. 'sofa indistinct' means several");
  log("  AutoCount builds of one model on one document were identical on every compared field, so which");
  log("  one a compartment belongs to cannot be determined and cannot change the answer.");
  log("  UNJOINED rows are compared against nothing and are counted here, never dropped.");
  log("");
  log(`  AutoCount lines on a MIGRATED document with no ERP line at all:  SO ${missingSo}   PO ${missingPo}`);
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
    log("  NOT FOUND. This check is wrong until it reproduces the known lines - do not read this as clean.");
  } else {
    const units = overReceipt.reduce((s, r) => s + (r.erp - r.ac), 0);
    const byPo = new Set(overReceipt.map((r) => r.po));
    log(`  ${overReceipt.length} PO lines carry more received than AutoCount ever recorded; ${units} excess units,`);
    log(`  spread over ${byPo.size} purchase orders.`);
    log("  AutoCount does not permit an over-receipt. These were manufactured during migration by an export");
    log("  column aggregated on (DocNo + ItemCode) - export-received-pos-live.py's GrQty subquery, which");
    log("  hands every same-code line on a document the document's total.");
    log("  Proof, showing the aggregate the importer used next to AutoCount's per-line truth:");
    for (const r of overReceipt.slice(0, TOP)) {
      const agg = acGrAgg.get(`${norm(r.po)}|${norm(r.item)}`);
      log(`     ${r.po} dtl ${r.dtl} ${r.code}: ordered ${r.qty}, ERP received ${r.erp}, AutoCount TransferedQty ${r.ac}` +
        (agg ? `   [GRDTL SUM over (${r.po},${r.item}) = ${Math.round(n0(agg.GrQtySum))} across ${agg.GrLines} receipt lines]` : ""));
    }
    if (overReceipt.length > TOP) log(`     ... and ${overReceipt.length - TOP} more`);
  }
  log("");

  // ═════════════════════ VERDICT ═════════════════════
  const comparableLines = soJoin.pairs.reduce((s, p) => s + p.erp.length, 0) + poJoin.pairs.reduce((s, p) => s + p.erp.length, 0)
    + (erpGrnL.length - grnNoKey) + doQtyChecked;

  log("═".repeat(96));
  log("VERDICT");
  log("═".repeat(96));
  log(`  documents compared        SO ${erpSoH.length}   PO ${erpPoH.length}   GRN ${grnDocs}   DO ${erpDoH.length}`);
  log(`  LINES COMPARED            ${comparableLines}`);
  log(`  LINES NOT COMPARABLE      ${soJoin.stats.unjoined + poJoin.stats.unjoined + grnNoKey + doNoAc}  (no AutoCount row could be joined; listed above)`);
  log(`  FIELD-LEVEL DIVERGENCES   ${F.total()}   across ${F.byField.size} distinct fields`);
  log(`    of which UNEXPLAINED    ${F.unexplained()}   (the rest have a named, already-decided cause)`);
  log("");
  log(`  ${"scope".padEnd(11)} ${"field".padEnd(46)} ${"rows".padStart(6)} ${"unexpl".padStart(7)} ${"units".padStart(9)}`);
  log("  " + "-".repeat(84));
  const sorted = [...F.byField.values()].sort((a, b) => b.rows.length - a.rows.length);
  for (const f of sorted) {
    const un = f.rows.filter((r) => !r.cause).length;
    log(`  ${f.scope.padEnd(11)} ${f.field.padEnd(46)} ${String(f.rows.length).padStart(6)} ${String(un).padStart(7)} ${String(Math.round(f.units)).padStart(9)}`);
  }
  if (!sorted.length) log("  (none)");
  log("");

  log("EVERY DIVERGENCE, BY FIELD");
  log("-".repeat(96));
  for (const f of sorted) {
    const causes = new Map();
    for (const r of f.rows) if (r.cause) causes.set(r.cause, (causes.get(r.cause) ?? 0) + 1);
    log(`\n### ${f.scope}.${f.field} — ${f.rows.length} row(s)`);
    for (const [c, n] of causes) log(`    cause: ${n} of them — ${c}`);
    for (const r of f.rows.slice(0, TOP)) {
      const tag = r.how && r.how !== "key" ? ` [${r.how}]` : "";
      log(`   ${String(r.key).padEnd(46)} ERP="${r.erp}"   AutoCount="${r.ac}"${tag}`);
    }
    if (f.rows.length > TOP) log(`   ... and ${f.rows.length - TOP} more`);
  }
  log("");
  log("═".repeat(96));
  const answer = comparableLines === 0
    ? "INCONCLUSIVE — no migrated line could be compared. Check the scope query and the snapshot, do not read this as clean."
    : F.total() === 0
      ? "YES — every compared field on every joinable migrated line matches AutoCount."
      : `NO — ${F.total()} field values on migrated documents do not match AutoCount, across ${F.byField.size} fields; ${F.unexplained()} of them have no already-decided cause.`;
  log(`ANSWER: ${answer}`);
  log("Read-only check. Repairing anything found here is a separate, owner-approved change.");
  log(`(${((Date.now() - started) / 1000).toFixed(1)}s)`);
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
