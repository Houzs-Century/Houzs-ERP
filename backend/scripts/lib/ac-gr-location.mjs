// ----------------------------------------------------------------------------
// ac-gr-location — where AutoCount's own GOODS RECEIPT put the goods.
//
// WHY THIS FILE EXISTS. Both migrated-receipt writers DERIVE the receiving
// warehouse from the purchase order instead of copying it from the book:
//
//   create-migrated-documents.mjs  `g.items[0].warehouse_id ?? g.po.purchase_location_id`
//   reshape-migrated-grns.mjs      `d.items.find(i => i.poi?.warehouse_id)?... ?? d.erpPo.purchase_location_id`
//
// A migration COPIES, it never computes (docs/migration rules; the same rule the
// delivery-order line warehouse broke, where 3 of 366 lines disagreed with the
// book). A warehouse can and does receive goods into a location the purchase
// order did not name, and when it does the derivation is silently wrong and
// nothing says so. This module is the copy side of that rule.
//
// WHAT IS AND IS NOT A RECEIPT LOCATION — the trap this file exists to stop.
//
//   GRDTL.Location IS the receipt location.
//   A surviving FIFO stock LAYER's location is NOT.
//
// `data/ac-stock-layers.json.gz` carries `{ ItemCode, Location, SrcDoc, Src:'GR' }`
// and reads exactly like a receipt location. It is not one: the layer records
// where those units are NOW, and a showroom transfer after the receipt moves the
// layer while the receipt stays put. MEASURED on the committed cuts, 2026-09-08:
// of 274 (receipt, item) cells carried by BOTH the layer file and a real GRDTL
// row, 258 agree and 16 disagree - and every one of the 16 moves KL/PG to a
// DISPLAY or SERVICE location (PG DISP, KL DISP, SERV KL). That is the signature
// of a display transfer, not of a receipt. Taking the layer as the receipt
// location would have "found" a difference on GR-002798 that the book's own
// GRDTL rows for that same receipt (all PG) contradict.
//
// So only DIRECT GRDTL sources are loaded here, and `ac-stock-layers.json.gz` is
// deliberately NOT one of them.
//
// COVERAGE IS PARTIAL AND THAT IS THE POINT. The GR export
// (export-ac-reimport.py, the `grrefs` section) reads GRDTL and did not select
// `Location` until 2026-09-08, so the committed cuts only carry the receipt
// location where some OTHER export happened to bring it along. Callers must
// treat a miss as "the book has not been asked", never as "the book agrees" -
// hence `known` / `unknown` counters rather than a bare fallback.
// ----------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import { SALESLOC } from "./ac-stock-compare.mjs";

const U = (s) => String(s ?? "").trim().toUpperCase();

function tryGz(dir, name) {
  try {
    return JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, name))).toString("utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

/**
 * The book's receipt location, keyed by AutoCount receipt + item code.
 *
 * @returns {{ byCell: Map<string, {locs: Set<string>, sources: Set<string>}>,
 *             byDoc:  Map<string, Set<string>>,
 *             sources: string[] }}
 *   `byCell` key is `GRNO|ITEMCODE`, both upper-cased and trimmed.
 *   `byDoc`  key is `GRNO`; its value is every location that receipt used.
 */
export function loadBookGrLocations(dataDir) {
  const byCell = new Map();
  const byDoc = new Map();
  const sources = [];
  const add = (doc, item, loc, source) => {
    const d = U(doc);
    const l = U(loc);
    if (!d || !l) return;
    const k = `${d}|${U(item)}`;
    if (!byCell.has(k)) byCell.set(k, { locs: new Set(), sources: new Set() });
    byCell.get(k).locs.add(l);
    byCell.get(k).sources.add(source);
    if (!byDoc.has(d)) byDoc.set(d, new Set());
    byDoc.get(d).add(l);
  };

  /* 1. The receipt/invoice reference index. Its rows come straight from GRDTL
        and it covers exactly the in-scope receipts, so it is the RIGHT home for
        this field - it just did not carry it before 2026-09-08. Read
        defensively so an older cut still loads. */
  const refs = tryGz(dataDir, "ac-gr-refs.json.gz");
  if (Array.isArray(refs)) {
    let n = 0;
    for (const r of refs) if (r?.Location) { add(r.GrNo, r.ItemCode, r.Location, "grdtl-refs"); n++; }
    if (n) sources.push(`ac-gr-refs.json.gz (${n} rows)`);
  }

  /* 2. The purchase-cost history. `history` rows with Src='GR' are GRDTL rows
        carrying Location; 5,607 of them across 1,369 receipts on the cut of
        2026-08-10. Scoped to the costing question, so partial by construction. */
  const costs = tryGz(dataDir, "ac-po-line-costs.json.gz");
  if (Array.isArray(costs?.history)) {
    let n = 0;
    for (const r of costs.history) if (r?.Src === "GR" && r.Location) { add(r.DocNo, r.ItemCode, r.Location, "grdtl-costs"); n++; }
    if (n) sources.push(`ac-po-line-costs.json.gz history (${n} rows)`);
  }

  /* 3. The sofa receipt cut - GRDTL again, sofa only. */
  const sofa = tryGz(dataDir, "ac-sofa-gr-po.json.gz");
  if (Array.isArray(sofa)) {
    let n = 0;
    for (const r of sofa) if (r?.Location) { add(r.GrNo, r.ItemCode, r.Location, "grdtl-sofa"); n++; }
    if (n) sources.push(`ac-sofa-gr-po.json.gz (${n} rows)`);
  }

  return { byCell, byDoc, sources };
}

/**
 * AutoCount location code -> ERP warehouse CODE, through the SHARED map.
 *
 * The map is imported, never re-typed: a location map that exists in one script
 * and not another is how stock silently moves between branches
 * (lib/ac-stock-compare.mjs, and the reason it was extracted at all). A code
 * with no entry falls through UNCHANGED so the caller's warehouse lookup can
 * still match a warehouse actually named that - and reports the miss rather
 * than guessing.
 */
export function grLocationWarehouseCode(loc) {
  const k = U(loc);
  if (!k) return null;
  return SALESLOC[k] ?? k;
}

/**
 * The one location a receipt used for a given purchase order, or null.
 *
 * A migrated ERP receipt holds ONE warehouse on its header - `scm.grn_items` has
 * no warehouse column - so a receipt whose lines for this purchase order sit in
 * TWO locations cannot be represented and must not be guessed at. Ambiguity
 * returns null and is counted by the caller, never silently collapsed to the
 * first value.
 */
export function bookLocationForPair(book, grNo, itemCodes) {
  const locs = new Set();
  for (const code of itemCodes) {
    const cell = book.byCell.get(`${U(grNo)}|${U(code)}`);
    if (cell) for (const l of cell.locs) locs.add(l);
  }
  if (locs.size !== 1) return { loc: null, ambiguous: locs.size > 1, locs };
  return { loc: [...locs][0], ambiguous: false, locs };
}
