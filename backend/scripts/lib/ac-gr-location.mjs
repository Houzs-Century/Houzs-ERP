/* THE ONE RULE that answers "which location did AutoCount receive these goods
   into" — the receipt-side twin of lib/ac-do-location.mjs, and shared by every
   place that writes a migrated goods receipt.

   WHY IT EXISTS. Both migrated-receipt writers DERIVED the receiving warehouse
   from the purchase order instead of copying it from the book:

     create-migrated-documents.mjs  `g.items[0].warehouse_id ?? g.po.purchase_location_id`
     reshape-migrated-grns.mjs      `d.items.find(i => i.poi?.warehouse_id)?... ?? d.erpPo.purchase_location_id`

   A migration COPIES, it never computes. A warehouse can receive goods into a
   location the order did not name, and when it does the derived answer is wrong
   with nothing to say so — the same rule the delivery-order line warehouse
   broke, where 3 of 366 lines disagreed with the book.

   WHAT IS AND IS NOT A RECEIPT LOCATION — the trap this file exists to stop.

     GRDTL.Location IS the receipt location.
     A surviving FIFO stock LAYER's location is NOT.

   data/ac-stock-layers.json.gz carries { ItemCode, Location, SrcDoc, Src:'GR' }
   and reads exactly like a receipt location. It is not one: the layer records
   where those units are NOW, and a showroom transfer after the receipt moves the
   layer while the receipt stays put. MEASURED on the committed cuts, 2026-09-08:
   of 274 (receipt, item) cells carried by BOTH the layer file and a real GRDTL
   row, 258 agree and 16 disagree — and every one of the 16 moves KL/PG to a
   DISPLAY or SERVICE location (PG DISP, KL DISP, SERV KL). That is a display
   transfer, not a receipt. Read as receipt locations the layers "find" a
   difference on GR-002798 that the book's own GRDTL rows for that same receipt
   (all PG) contradict. So only DIRECT GRDTL sources are loaded here, and
   ac-stock-layers.json.gz is deliberately NOT one of them.

   COVERAGE IS PARTIAL AND THAT IS THE POINT. export-ac-reimport.py's `grrefs`
   section reads GRDTL and did not SELECT `Location` until 2026-09-08, so the
   committed cuts only carry the receipt location where some OTHER export
   happened to bring it along. A miss is "the book was never asked", never "the
   book agrees" — which is why an unresolved receipt comes back with a `why` the
   caller must PRINT, exactly as ac-do-location.mjs does.

   THE ORDER, and it never guesses:
     1. the RECEIPT's own locations in the book, and ONLY when they are
        unanimous. scm.grn_items has no warehouse column, so a receipt that used
        two locations cannot be represented on one header and must not be
        collapsed onto the first.
     2. when the receipt DID span locations, narrow to the lines this ERP
        document actually covers, by item code. That needs the ERP code
        translated back to AutoCount's, which is why `erpToAcCodes` is a
        REQUIRED parameter rather than an optional convenience — see below.
     3. nothing. `warehouseId` comes back null with a `why`, and the caller falls
        back to its own rule and SAYS SO.

   WHY THE ITEM JOIN IS THE REFINEMENT AND NOT THE RULE — measured against
   production, 2026-09-08. The first version of this module keyed on
   (receipt, item) alone and asked the ERP's own `grn_items.item_code`. Run
   34150043151 answered for **0 of 320** migrated receipts: the book is keyed by
   AutoCount's ItemCode and the ERP holds the ERP one, and on
   `data/autocount-erp-mapping-1561.csv` **1,407 of 1,577 codes differ**
   (`AERO-DIVAN ONLY (K)` -> `DIVAN ONLY-(K)`). The join could not match, and it
   failed as "the book carries no location" — which reads exactly like the book
   being silent. A key that cannot match reports a clean miss; that is the same
   failure CLAUDE.md records for checkers that cannot match reporting a clean
   run. The receipt number needs no translation, so it leads.

   The map is the SHARED SALESLOC (AutoCount location -> ERP warehouse CODE),
   the same one the PO importer's whId() uses. The resolution onto a warehouse
   row is resolve-warehouse-location.mjs — the tested spec of migration 0309's
   backfill: CODE first, then NAME, company-scoped, unambiguous only.

   NO SHEBANG — imported by backend/tests/acGrLocation.test.mjs. */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { parseCsvLine, SALESLOC } from './ac-stock-compare.mjs';
import { resolveWarehouseLocation } from './resolve-warehouse-location.mjs';

const norm = (s) => (s || '').trim().toUpperCase().replace(/\s+/g, ' ');
const NEWLINE = /\r?\n/;

function tryGz(dir, name) {
  try {
    return JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, name))).toString('utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

/**
 * The book's receipt location, read from every committed cut that carries a real
 * GRDTL row.
 *
 * @returns {{ byCell: Map<string, Set<string>>, byDoc: Map<string, Set<string>>, sources: string[] }}
 *   `byCell` key is `GRNO|ITEMCODE`; `byDoc` key is `GRNO`. Both normalised.
 */
export function loadBookGrLocations(dataDir) {
  const byCell = new Map();
  const byDoc = new Map();
  const sources = [];
  const add = (doc, item, loc) => {
    const d = norm(doc);
    const l = norm(loc);
    if (!d || !l) return false;
    const k = `${d}|${norm(item)}`;
    if (!byCell.has(k)) byCell.set(k, new Set());
    byCell.get(k).add(l);
    if (!byDoc.has(d)) byDoc.set(d, new Set());
    byDoc.get(d).add(l);
    return true;
  };

  /* 1. The receipt/invoice reference index. Its rows come straight from GRDTL
        and it covers exactly the in-scope receipts, so it is the RIGHT home for
        this field — it just did not carry it before 2026-09-08. Read
        defensively so an older cut still loads. */
  const refs = tryGz(dataDir, 'ac-gr-refs.json.gz');
  if (Array.isArray(refs)) {
    let n = 0;
    for (const r of refs) if (add(r?.GrNo, r?.ItemCode, r?.Location)) n++;
    if (n) sources.push(`ac-gr-refs.json.gz (${n} rows)`);
  }

  /* 2. The purchase-cost history. `history` rows with Src='GR' are GRDTL rows
        carrying Location — 5,607 of them across 1,369 receipts on the cut of
        2026-08-10. Scoped to the costing question, so partial by construction. */
  const costs = tryGz(dataDir, 'ac-po-line-costs.json.gz');
  if (Array.isArray(costs?.history)) {
    let n = 0;
    for (const r of costs.history) if (r?.Src === 'GR' && add(r.DocNo, r.ItemCode, r.Location)) n++;
    if (n) sources.push(`ac-po-line-costs.json.gz history (${n} rows)`);
  }

  /* 3. The sofa receipt cut — GRDTL again, sofa only. */
  const sofa = tryGz(dataDir, 'ac-sofa-gr-po.json.gz');
  if (Array.isArray(sofa)) {
    let n = 0;
    for (const r of sofa) if (add(r?.GrNo, r?.ItemCode, r?.Location)) n++;
    if (n) sources.push(`ac-sofa-gr-po.json.gz (${n} rows)`);
  }

  return { byCell, byDoc, sources };
}

/**
 * The ERP product code -> the AutoCount ItemCode(s) it stands for.
 *
 * Inverted from the SAME binding the document importers use
 * (`autocount-erp-mapping-1561.csv`), never re-typed. One ERP code can stand for
 * several AutoCount codes, so the value is a Set.
 */
export function loadErpToAcCodes(dataDir) {
  const out = new Map();
  let csv;
  try {
    csv = fs.readFileSync(path.join(dataDir, 'autocount-erp-mapping-1561.csv'), 'utf8');
  } catch {
    return out;
  }
  const lines = csv.replace(/^﻿/, '').split(NEWLINE).filter(Boolean);
  lines.shift();
  for (const ln of lines) {
    const f = parseCsvLine(ln);
    const ac = norm(f[0]);
    const erp = norm(f[1]);
    if (!ac || !erp) continue;
    if (!out.has(erp)) out.set(erp, new Set());
    out.get(erp).add(ac);
  }
  return out;
}

/**
 * Where AutoCount received the goods of ONE receipt, for the lines an ERP
 * document covers.
 *
 * @param {string[]} acGrNos    the AutoCount receipt number(s) this ERP document mirrors
 * @param {string[]} itemCodes  the item codes on the ERP document (ERP or AutoCount spelling)
 * @param {{byCell: Map<string, Set<string>>, byDoc: Map<string, Set<string>>}} book
 * @param {Array<{id:string, code?:string|null, name?:string|null}>} warehouses
 *        candidates ALREADY scoped to the receipt's company
 * @param {Map<string, Set<string>>} erpToAcCodes  from loadErpToAcCodes. REQUIRED,
 *        not optional: it decides whether the narrowing step can match at all,
 *        and an optional argument that decides something is the repo's
 *        optional-param-noop bug class. Pass an empty Map to mean "no
 *        translation available" — that is the STRICTER direction, since an
 *        unmatched code simply leaves the receipt ambiguous and refused.
 * @returns {{ warehouseId: string|null, warehouseCode: string|null,
 *             bookLocation: string|null, source: 'receipt'|'lines'|null,
 *             why: string|null }}
 */
export function resolveAcReceiptLocation(acGrNos, itemCodes, book, warehouses, erpToAcCodes) {
  const miss = (why) => ({ warehouseId: null, warehouseCode: null, bookLocation: null, source: null, why });
  if (!(erpToAcCodes instanceof Map)) {
    throw new TypeError('resolveAcReceiptLocation: erpToAcCodes is required (pass loadErpToAcCodes(dataDir), or an empty Map)');
  }

  /* 1. the RECEIPT's own locations. No item code is involved, so no translation
        can go wrong here — and this is the path that answers in practice. */
  const docLocs = new Set();
  for (const gr of acGrNos ?? []) {
    const s = book.byDoc.get(norm(gr));
    if (s) for (const l of s) docLocs.add(l);
  }
  if (docLocs.size === 0) return miss('the book snapshots carry no receipt location for this document');

  let source = 'receipt';
  let locs = docLocs;

  /* 2. the receipt used more than one location. Narrow to the lines THIS
        document covers — accepting the AutoCount spelling and the ERP one,
        because the two differ on 1,407 of 1,577 codes. */
  if (docLocs.size > 1) {
    const wanted = new Set();
    for (const code of itemCodes ?? []) {
      const c = norm(code);
      wanted.add(c);
      for (const ac of (erpToAcCodes.get(c) ?? [])) wanted.add(ac);
    }
    const narrowed = new Set();
    for (const gr of acGrNos ?? []) {
      for (const code of wanted) {
        const cell = book.byCell.get(`${norm(gr)}|${code}`);
        if (cell) for (const l of cell) narrowed.add(l);
      }
    }
    if (narrowed.size !== 1) {
      return miss(`the book received this receipt's lines into more than one location (${[...docLocs].join(' + ')}), and narrowing to this document's own lines ${narrowed.size === 0 ? 'matched none of them' : `still leaves ${[...narrowed].join(' + ')}`}; a receipt header holds one`);
    }
    locs = narrowed;
    source = 'lines';
  }

  const bookLocation = [...locs][0];
  const erpCode = SALESLOC[norm(bookLocation)] ?? bookLocation;
  const hit = resolveWarehouseLocation(erpCode, warehouses);
  if (!hit.id) {
    return {
      ...miss(`location "${bookLocation}" maps to "${erpCode}", which resolves to no single warehouse in this company (${hit.reason})`),
      bookLocation,
    };
  }
  return { warehouseId: hit.id, warehouseCode: erpCode, bookLocation, source, why: null };
}
