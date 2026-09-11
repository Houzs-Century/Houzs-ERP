/* cutover-variant-source — resolve the SPEC the account book holds for a piece
 * of stock that arrived through the AutoCount cutover carrying none.
 *
 * This is the glue `fill-cutover-lot-variants-2026-09-09.mjs` proved on
 * production (159 lots filled, run 34374120271), lifted out so a second caller
 * cannot re-derive it slightly differently. The RULES it uses are not here and
 * never will be: `parse-bedframe`, `parse-sofa`, `fabric-colour-match` and
 * `src/scm/shared/variant-key.ts` are imported, so this file cannot drift away
 * from what the API and the frontend compute.
 *
 * THE EVIDENCE CHAIN, and why each link is needed:
 *
 *  1. A cutover movement's note records the book document it was relayered
 *     from, verbatim: `AC GR GR-004679 2026-05-28` (import-ac-stock-layers).
 *     That is an exact link from one movement to one receipt.
 *  2. The book's item code is NOT ours — `HOK-1007 (K)` here is `CODY-(K)` —
 *     and 815 of 949 mapped receipt items differ, so receipts are indexed under
 *     the ERP code through `data/autocount-erp-mapping-1561.csv`. Skipping the
 *     translation makes the whole thing a silent no-op that reads as a data gap.
 *  3. `GRDTL.Desc2` on that receipt carries the text:
 *       Col:PC151-01/M'gap:14"Inch/Divan:10"Inch No Leg/Addon Drawer Left side
 *  4. NO GUESSING WHEN THE DOCUMENT IS UNKNOWN. Taking the newest spec for the
 *     item would be wrong more often than right: of 276 bedframe codes only 85
 *     were ever received under a single spec, and `NB-KHJ02(Q)` has 42 distinct
 *     specs across 130 receipts. The item-level fallback fires ONLY when every
 *     spec-bearing receipt for that code decodes to the SAME key.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBedframe, bedframeVariants } from './parse-bedframe.mjs';
import { parseSofa, SOFA_MODEL_ALIAS } from './parse-sofa.mjs';
import { buildFabricColourIndex, isPendingColour } from './fabric-colour-match.mjs';
import { readMappingCsv, normCode } from './ac-mapping-csv.mjs';
import { computeVariantKey } from '../../src/scm/shared/variant-key.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SNAPSHOT = path.join(here, '..', 'data', 'ac-stock-receipts-2026-09-09.json.gz');
const MAPPING = path.join(here, '..', 'data', 'autocount-erp-mapping-1561.csv');

/** `AC GR GR-004679 2026-05-28` — written by import-ac-stock-layers.mjs. */
export const CUTOVER_NOTE_RE = /^AC\s+(\w+)\s+(\S+)\s+(\d{4}-\d{2}-\d{2})\s*$/i;

/** Sofa attribute bag exactly as import-ac-outstanding-so.mjs builds it — the
 *  importer sets no leg height, so neither does this: stock must key the way
 *  the document line it will be shipped against keys. */
function sofaAttrs(desc2, model, findColour) {
  const ps = parseSofa(desc2, model, false);
  const colour = isPendingColour(ps.color) ? null : ps.color;
  const fc = colour ? findColour(colour) : null;
  return {
    seatHeight: ps.size,
    fabricId: fc ? fc.fabric_id : null,
    colourId: fc ? fc.colour_id : null,
    fabricCode: fc ? fc.colour_id : null,
    colourLabel: fc ? fc.label : (colour || null),
    fabricLabel: fc ? fc.fabric_id : null,
    specials: ps.specials,
  };
}

/**
 * @param {Array<{fabric_id: string, colour_id: string, label: string}>} fabricColours
 *        scm.fabric_colours for THIS company — the colour names only resolve
 *        against the company's own library.
 */
export function buildCutoverVariantSource(fabricColours) {
  if (!fs.existsSync(SNAPSHOT)) {
    throw new Error(`REFUSED: ${SNAPSHOT} is missing — it is the AutoCount extraction `
      + 'and this runner cannot reach the book. Nothing can be resolved.');
  }
  const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(SNAPSHOT)).toString('utf8').replace(/^﻿/, ''));
  const acToErp = readMappingCsv(fs.readFileSync(MAPPING, 'utf8'));
  const erpCodeOf = (acCode) => normCode(acToErp.get(normCode(acCode))?.erp || acCode);
  const { findColour } = buildFabricColourIndex(fabricColours);

  /** (document number, ERP item code) -> receipt. The exact link. */
  const byDoc = new Map();
  /** ERP item code -> every spec-bearing receipt, for the unambiguous fallback. */
  const byItem = new Map();
  for (const r of snap.receipts) {
    if (!r.desc2 || !r.item) continue;
    const k = erpCodeOf(r.item);
    if (r.doc_no) byDoc.set(`${normCode(r.doc_no)} ${k}`, r);
    if (!byItem.has(k)) byItem.set(k, []);
    byItem.get(k).push(r);
  }

  function keyFor(group, desc2, itemCode) {
    if (!desc2) return '';
    try {
      if (group === 'bedframe') {
        return computeVariantKey('bedframe', bedframeVariants(parseBedframe(desc2), findColour));
      }
      const base = String(itemCode).replace(/-[^-]*$/, '');
      const model = SOFA_MODEL_ALIAS[base] || base;
      return computeVariantKey('sofa', sofaAttrs(desc2, model, findColour));
    } catch {
      return '';
    }
  }

  const unambiguous = new Map();
  function itemLevelKey(code, group) {
    const ck = `${group} ${code}`;
    if (unambiguous.has(ck)) return unambiguous.get(ck);
    const keys = new Set();
    for (const r of byItem.get(code) ?? []) {
      const k = keyFor(group, r.desc2, code);
      if (k) keys.add(k);
    }
    const v = keys.size === 1 ? [...keys][0] : null;
    unambiguous.set(ck, v);
    return v;
  }

  /**
   * Resolve one row's key.
   * @returns {{key: string, via: string, bookText: string}|null} null = leave it alone.
   */
  function resolve({ itemCode, group, notes }) {
    const code = normCode(itemCode);
    const m = CUTOVER_NOTE_RE.exec(String(notes ?? '').trim());
    if (m) {
      const r = byDoc.get(`${normCode(m[2])} ${code}`);
      if (r) {
        const key = keyFor(group, r.desc2, code);
        if (key) return { key, via: `receipt ${m[2]}`, bookText: r.desc2 ?? '' };
      }
    }
    const only = itemLevelKey(code, group);
    if (only) return { key: only, via: 'the only spec this item was ever received under', bookText: '' };
    return null;
  }

  return {
    resolve,
    receiptsFor: (itemCode) => (byItem.get(normCode(itemCode)) ?? []).length,
    stats: {
      receipts: snap.receipts.length,
      addressableByDocument: byDoc.size,
      itemsWithASpec: byItem.size,
      exportedAt: snap.exported_at,
    },
  };
}
