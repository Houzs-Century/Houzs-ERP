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
     1. the book's own GRDTL Location for this receipt's lines, and ONLY when
        they are unanimous. scm.grn_items has no warehouse column, so a receipt
        that used two locations cannot be represented on one header and must not
        be collapsed onto the first.
     2. nothing. `warehouseId` comes back null with a `why`, and the caller falls
        back to its own rule and SAYS SO.

   The map is the SHARED SALESLOC (AutoCount location -> ERP warehouse CODE),
   the same one the PO importer's whId() uses. The resolution onto a warehouse
   row is resolve-warehouse-location.mjs — the tested spec of migration 0309's
   backfill: CODE first, then NAME, company-scoped, unambiguous only.

   NO SHEBANG — imported by backend/tests/acGrLocation.test.mjs. */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { SALESLOC } from './ac-stock-compare.mjs';
import { resolveWarehouseLocation } from './resolve-warehouse-location.mjs';

const norm = (s) => (s || '').trim().toUpperCase().replace(/\s+/g, ' ');

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
 * Where AutoCount received the goods of ONE receipt, for the item codes an ERP
 * document covers.
 *
 * @param {string[]} acGrNos    the AutoCount receipt number(s) this ERP document mirrors
 * @param {string[]} itemCodes  the item codes on the ERP document
 * @param {{byCell: Map<string, Set<string>>}} book   from loadBookGrLocations
 * @param {Array<{id:string, code?:string|null, name?:string|null}>} warehouses
 *        candidates ALREADY scoped to the receipt's company
 * @returns {{ warehouseId: string|null, warehouseCode: string|null,
 *             bookLocation: string|null, why: string|null }}
 */
export function resolveAcReceiptLocation(acGrNos, itemCodes, book, warehouses) {
  const miss = (why) => ({ warehouseId: null, warehouseCode: null, bookLocation: null, why });

  const seen = new Set();
  for (const gr of acGrNos ?? []) {
    for (const code of itemCodes ?? []) {
      const cell = book.byCell.get(`${norm(gr)}|${norm(code)}`);
      if (cell) for (const l of cell) seen.add(l);
    }
  }
  if (seen.size === 0) return miss('the book snapshots carry no receipt location for this document');
  if (seen.size > 1) {
    return miss(`the book received this document's lines into more than one location (${[...seen].join(' + ')}), and a receipt header holds one`);
  }

  const bookLocation = [...seen][0];
  const erpCode = SALESLOC[norm(bookLocation)] ?? bookLocation;
  const hit = resolveWarehouseLocation(erpCode, warehouses);
  if (!hit.id) {
    return {
      ...miss(`location "${bookLocation}" maps to "${erpCode}", which resolves to no single warehouse in this company (${hit.reason})`),
      bookLocation,
    };
  }
  return { warehouseId: hit.id, warehouseCode: erpCode, bookLocation, why: null };
}
