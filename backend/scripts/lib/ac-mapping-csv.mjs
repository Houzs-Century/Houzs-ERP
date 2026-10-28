// The AutoCount -> ERP item-code mapping sheet, read ONCE, correctly.
//
// WHY THIS MODULE EXISTS. `data/autocount-erp-mapping-1561.csv` is RFC4180: a
// field that contains a comma or a quote is quoted, and an embedded quote is
// doubled. Three rows are - the inch mark in a mattress name:
//
//   DL-GENERASI (S),"DUNLOPILLO GENERASI 5"" MATT (S)",NEW,MATTRESS,400-D001
//
// correct-so-item-code-from-autocount.mjs parsed that properly. The reconcile
// checker did not - it did `line.split(",")`, which cuts that row into
// `"DUNLOPILLO GENERASI 5""` and ` MATT (S)"`, so the ERP code it compared
// against was a fragment that can never equal what the ERP stores. Every
// sales-order line carrying one of those three codes was reported as an item-code
// DEFECT: 40 of the 101 the owner had on his table on 2026-09-08 (docs/bugs/0689).
//
// Two parsers for one file is how that happened, so there is now one, and both
// callers use it. A NAIVE reader is not merely imprecise here: it invents
// findings, and an invented finding costs exactly what a missed one does - the
// real defects in the same list stop being believed.
//
// NO SHEBANG: tests/acMappingCsv.test.mjs imports this module, and on Windows
// vitest inlines it, where a `#!` no longer at byte 0 is a load-time SyntaxError.

/** One RFC4180 record -> its fields. Doubled quotes inside a quoted field are
 *  one literal quote. Newlines inside fields are NOT supported and the sheet
 *  has none; a caller that splits on newlines first is therefore correct. */
export function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** The comparison form every caller uses: trimmed, upper-cased, runs of
 *  whitespace collapsed. Same rule as `norm` in check-ac-erp-reconcile.mjs and
 *  `normItemCode` in ac-po-line.mjs. */
export const normCode = (s) => String(s ?? "").trim().toUpperCase().replace(/\s+/g, " ");

/**
 * @param {string} text the CSV file's contents
 * @returns {Map<string, {erp: string, status: string, cat: string, supplier: string}>}
 *   keyed by the NORMALISED AutoCount code.
 */
export function readMappingCsv(text) {
  const rows = String(text).replace(/^\ufeff/, "").trim().split(/\r?\n/);
  const map = new Map();
  for (const line of rows.slice(1)) {
    if (!line) continue;
    const f = parseCsvLine(line);
    if (!f[0]) continue;
    map.set(normCode(f[0]), {
      erp: (f[1] || "").trim(),
      status: (f[2] || "").trim().toUpperCase(),
      cat: (f[3] || "").trim().toUpperCase(),
      supplier: (f[4] || "").trim(),
    });
  }
  return map;
}
