// ----------------------------------------------------------------------------
// ac-stock-compare — the AutoCount->ERP mapping every stock comparison needs,
// in ONE place.
//
// WHY THIS FILE EXISTS. `check-stock-vs-autocount.mjs` owned all three of these
// as private constants. The go-live gate (`check-golive-parity.mjs`) asks the
// same question over the same book, so it needed the same location map, the same
// service-group exclusion and the same CSV reader — and a second copy of a
// location map is exactly how stock silently moves between branches in one
// script and not the other. Extracted verbatim, then imported by both; nothing
// about the values changed in the move.
//
// The docs/stock-reconciliation.md corrections (2026-08-13) apply here unchanged:
// the SOFA exclusion is decided by the BINDING CSV's category column, never by
// AutoCount's ItemGroup, because the ItemGroup test swept out 19 codes / 85 units
// of pillows, bolsters and stools that the balance importer did import.
// ----------------------------------------------------------------------------

/**
 * AutoCount location -> ERP warehouse CODE.
 *
 * Taken verbatim from the PO import (import-ac-outstanding-po.mjs SALESLOC),
 * which resolved 100% there, extended with the stock-only locations that appear
 * in vItemBalQty. A location with no confident ERP home stays UNMAPPED and is
 * REPORTED — never guessed, because a wrong guess silently moves stock between
 * branches.
 */
export const SALESLOC = {
  KL: "KL WAREHOUSE", PG: "PG WAREHOUSE", SRW: "SRW WAREHOUSE", SBH: "SBH WAREHOUSE",
  HQ: "HQ", "KL DISP": "KL DISPLAY", "PG DISP": "PG DISPLAY", "SBH DISP": "SBH DISPLAY",
  "EM DISP": "EM DISPLAY", "C&C DISP": "C&C DISPLAY",
  "SERV KL": "KL SERVICE", "SERV PG": "PG SERVICE",
  SUNWAY: "SUNWAY SHOWROOM", "KELANA.J": "KELANA.J SHOWROOM",
};

/**
 * AutoCount ItemGroups that are NOT physical stock.
 *
 * AutoCount models delivery fees, disposal and storage as stock-controlled
 * items, so they accumulate a large negative balance that no warehouse ever
 * holds. The ERP models the same lines as SERVICE, which carry no inventory at
 * all. Comparing them is a category error, not a discrepancy.
 */
export const SERVICE_GROUPS = new Set(["OTHER", "TRANS"]);

/** RFC-4180-ish single line parser: handles "quoted, fields" and "" escapes. */
export function parseCsvLine(line) {
  const out = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) { const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c; } }
  out.push(cur); return out;
}

const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");

/**
 * The ERP product codes that are AutoCount SERVICE pseudo-items — DISPOSE,
 * TRANSPORTATION CHARGES, STORAGE — derived from the binding, never typed.
 *
 * THE EXCLUSION HAS TO BE SYMMETRIC, and this is the half that gets forgotten.
 * Dropping the service groups on the AutoCount side alone leaves the ERP's own
 * cells for the same codes with nothing to compare against, so they report as
 * ERP-only holes AutoCount supposedly does not have — 16 cells and −4,149 units
 * on prod when this was measured (2026-09-07). Identical failure to the one
 * docs/stock-reconciliation.md §4 records for sofa: a gap invented by the
 * filter rather than found by it.
 *
 * `acGroupOf` reads the AutoCount item master's ItemGroup for a code.
 */
export function serviceErpCodes(byAc, acGroupOf) {
  const out = new Set();
  for (const [acCode, erpCode] of byAc) {
    if (erpCode && SERVICE_GROUPS.has(norm(acGroupOf(acCode)))) out.add(norm(erpCode));
  }
  return out;
}

/**
 * Read `data/autocount-erp-mapping-1561.csv` into the two lookups every stock
 * comparison needs.
 *
 * `byAc`          AutoCount ItemCode (normalised) -> ERP product code
 * `sofaFurniture` the set of AutoCount ItemCodes the binding CSV calls SOFA
 *
 * The second is the exclusion predicate, and it MUST be this column: it is
 * byte-identical to import-ac-stock-balance.mjs's, and that identity is the
 * point — an item the importer brought in must be compared, or the ERP's stock
 * shows up as a hole AutoCount supposedly does not have.
 */
export function loadAcBinding(csvText) {
  const lines = csvText.replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  lines.shift();                                  // header
  const fields = lines.map(parseCsvLine);
  const byAc = new Map();
  for (const f of fields) if (f[0]) byAc.set(norm(f[0]), (f[1] || "").trim());
  const sofaFurniture = new Set(
    fields.filter((f) => (f[3] || "").trim().toUpperCase() === "SOFA").map((f) => norm(f[0])),
  );
  return { byAc, sofaFurniture };
}
