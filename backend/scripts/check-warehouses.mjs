#!/usr/bin/env node
// ---------------------------------------------------------------------------
// check-warehouses.mjs — which warehouse is which, and what is sitting in it?
//
// WHY. Owner, 2026-08-05: "知道我们的 showroom 是哪一个吗？我们的系统有什么标明
// 的，一个是 showroom 的是哪一个？"
//
// The owned/held/display presentation work turns on two flags that are NOT the
// same thing, and getting them the wrong way round would hide real stock:
//
//   warehouses.is_consignment          a property of the PLACE (mig 0152)
//   isConsignmentLotSource(lot)        a property of the GOODS
//
// They are deliberately independent — inventory-movements.ts says ownership is
// decided "by the Purchase Consignment Receive, NOT by the warehouse's
// is_consignment flag: a PCR can receive into any warehouse". So ONE warehouse
// can hold both his own goods and someone else's, which is exactly what the
// PJ SHOWROOM screenshots show.
//
// This lists every warehouse with both flags and splits what is standing in it
// into OWNED vs HELD, so the presentation rules can be written against facts
// rather than against an assumption about which warehouse is the showroom.
//
// READ-ONLY. SELECT only, no writes. Exits 0 always.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import postgres from "postgres";

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch { return undefined; }
}
const url = resolveUrl();
if (!url) { console.error("DATABASE_URL not set. Aborting."); process.exit(1); }

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });
const pad = (v, n) => String(v ?? "").padEnd(n);
const rpad = (v, n) => String(v ?? "").padStart(n);
const num = (v) => Number(v ?? 0);
const rm = (sen) => `RM${(num(sen) / 100).toFixed(2)}`;

/* MIRRORS isConsignmentLotSource (scm/lib/inventory-movements.ts) EXACTLY:
     t === 'PC_RECEIVE' || 'PC_RETURN' || 'PURCHASE_CONSIGNMENT_NOTE'
     || /(?:^|-)PCR-/i.test(sourceDocNo)
   My first draft guessed this list and got it wrong twice: it invented CS_DO —
   which is a SALES-consignment loaner, i.e. the owner's OWN goods moved to a
   showroom, so counting it as HELD would have hidden his own stock — and it
   missed both PC_RETURN and the doc-number fallback. Verified against the
   function, not remembered. */
const HELD_SOURCES = ["PC_RECEIVE", "PC_RETURN", "PURCHASE_CONSIGNMENT_NOTE"];

try {
  const whs = await pg`
    SELECT id, code, name, is_active, is_consignment, company_id
      FROM scm.warehouses ORDER BY company_id, code`;

  console.log(`\n${whs.length} warehouse(s)\n`);
  console.log(`  ${pad("code", 22)} ${pad("name", 30)} ${pad("active", 8)} ${pad("is_consignment", 16)} co`);
  for (const w of whs) {
    console.log(`  ${pad(w.code, 22)} ${pad(w.name, 30)} ${pad(w.is_active ? "yes" : "no", 8)} ${pad(w.is_consignment ? "YES" : "no", 16)} ${w.company_id ?? ""}`);
  }

  console.log(`\nWhat is standing in each — OWNED vs HELD, from the LOT source\n`);
  for (const w of whs) {
    const [row] = await pg`
      SELECT
        COALESCE(SUM(qty_remaining) FILTER (WHERE NOT (UPPER(COALESCE(source_doc_type,'')) = ANY(${HELD_SOURCES}) OR COALESCE(source_doc_no,'') ~* '(^|-)PCR-')), 0) AS owned_qty,
        COALESCE(SUM(qty_remaining * unit_cost_sen) FILTER (WHERE NOT (UPPER(COALESCE(source_doc_type,'')) = ANY(${HELD_SOURCES}) OR COALESCE(source_doc_no,'') ~* '(^|-)PCR-')), 0) AS owned_val,
        COALESCE(SUM(qty_remaining) FILTER (WHERE UPPER(COALESCE(source_doc_type,'')) = ANY(${HELD_SOURCES}) OR COALESCE(source_doc_no,'') ~* '(^|-)PCR-'), 0) AS held_qty,
        COALESCE(SUM(qty_remaining * unit_cost_sen) FILTER (WHERE UPPER(COALESCE(source_doc_type,'')) = ANY(${HELD_SOURCES}) OR COALESCE(source_doc_no,'') ~* '(^|-)PCR-'), 0) AS held_val
        FROM scm.inventory_lots WHERE warehouse_id = ${w.id} AND qty_remaining > 0`;
    const oq = num(row.owned_qty), hq = num(row.held_qty);
    if (oq === 0 && hq === 0) continue;
    console.log(`  ${pad(w.code, 22)}${w.is_consignment ? "  [is_consignment]" : ""}`);
    console.log(`      OWNED  qty ${rpad(oq, 7)}  value ${rpad(rm(row.owned_val), 14)}`);
    console.log(`      HELD   qty ${rpad(hq, 7)}  value ${rpad(rm(row.held_val), 14)}  (not yours — excluded from value today)`);
  }
  console.log("");
} catch (e) {
  console.error("Query failed:", e?.message ?? e);
  process.exit(1);
} finally {
  await pg.end({ timeout: 5 });
}
