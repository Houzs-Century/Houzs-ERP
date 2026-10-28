// ---------------------------------------------------------------------------
// supplier-bedframe-variant-plan — which bedframe lines may take the SUPPLIER'S
// stated divan / gap / leg, and which must not. Pure; no database, no writes.
//
// THE ASK. Owner, 2026-09-11: 「跟着供应商，供应商那边写的东西肯定是对的…
// 无论是 BedFrame 还是 sofa compartment 跟它们的 variant」. The supplier's export
// states three numbers per bed — `div:8inch / leg:1inch / gap:10inch` — and on
// production (read-only run, 2026-09-11) 18 of the 305 purchase orders we can
// compare disagree with ours on at least one of them, some because ours is
// BLANK and some because ours states a different number.
//
// WHY IT IS NOT A BLIND UPDATE — docs/bugs/0722, the same lesson as the sofa leg
// tool. All three of these axes compose the bedframe's INVENTORY IDENTITY
// (`computeVariantKey`: fabric, gap, divan height, leg height, total height), so
// changing one on a line whose goods are already in moves that line to a stock
// bucket its lot does not carry. The gate is therefore the same: a line is
// written only while NOTHING has been keyed off its current identity — nothing
// received, no goods-received line, no delivery line, no allocated stock.
//
// WHAT IT WILL OVERWRITE, AND WHY THAT DIFFERS FROM THE SOFA TOOL. The sofa leg
// tool holds a height somebody picked, because the owner had not been asked. He
// has now answered for this listing — 「supplier 那边写的东西肯定是对的」 — so a
// bedframe line that STATES a different number is corrected toward the supplier,
// and reported in its own bucket so the change is visible rather than silent.
// A line we amended after their export was cut is out of scope here: that
// exception lives in the proposer, which reads `scm.po_amendments`.
// ---------------------------------------------------------------------------

/** How this repo spells these three on a line: the number, then an inch mark.
 *  Measured on production 2026-09-11 across bedframe purchase lines — divan
 *  `8"` 419 / `10"` 135, gap `12"` 244 / `14"` 197, leg `0"` 324 / `4"` 120 —
 *  the bare number appears nowhere, so writing `8` would open a second spelling
 *  of one height and a second stock bucket with it. */
export const spellInches = (n) => `${Number(n)}"`;

/** A measurement compares as a NUMBER: `10`, `10"` and `10 inch` are one. */
export const inches = (v) => {
  if (v === null || v === undefined) return null;
  const m = /([0-9]+(?:\.[0-9]+)?)/.exec(String(v));
  return m ? String(parseFloat(m[1])) : null;
};

/** The three axes, each with the variant names a line may carry it under. The
 *  alias lists are the bedframe checker's, kept identical on purpose. */
export const BED_AXES = [
  { key: 'div', names: ['divanHeight', 'divan'], write: 'divanHeight', label: 'divan height' },
  { key: 'gap', names: ['gap'], write: 'gap', label: 'gap' },
  { key: 'leg', names: ['legHeight', 'leg'], write: 'legHeight', label: 'leg height' },
];

const readAxis = (variants, names) => {
  for (const n of names) {
    const v = (variants || {})[n];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v);
  }
  return null;
};

/** `Default` is a placeholder, not a pick — the same word that stranded the
 *  0722 lines. Blank and Default are both "nobody said". */
const isPlaceholder = (v) => v === null || String(v).trim() === '' || String(v).trim().toLowerCase() === 'default';

/**
 * @param docs [{ poNumber, supplierDoc, pairs: [{
 *   poItemId, soItemId|null, soDocNo|null, itemCode,
 *   supplier: { div?, gap?, leg? },     // what the supplier states, as numbers
 *   variants,                           // what our line holds now
 *   receivedQty, grnLines, doLines, soReadyQty, soAllocatedBatch }] }]
 * @returns { writes, holds, agreed } — one write per LINE, carrying every axis
 *   that line needs, so a line is one UPDATE rather than three.
 */
export function planBedframeVariantFill(docs) {
  const writes = [];
  const holds = [];
  let agreed = 0;

  for (const doc of docs) {
    for (const p of doc.pairs) {
      const set = {};
      const filled = [];
      const corrected = [];

      for (const axis of BED_AXES) {
        const want = inches(p.supplier?.[axis.key]);
        if (want === null) continue;                    // the supplier states nothing
        const mine = readAxis(p.variants, axis.names);
        if (inches(mine) === want) continue;            // already agrees
        set[axis.write] = spellInches(want);
        (isPlaceholder(mine) ? filled : corrected).push(
          `${axis.label} ${isPlaceholder(mine) ? '(blank)' : mine} -> ${spellInches(want)}`,
        );
      }

      if (!Object.keys(set).length) { agreed += 1; continue; }

      /* THE 0722 GATE. */
      const moved = [
        Number(p.receivedQty || 0) > 0 ? `${p.receivedQty} already received` : null,
        Number(p.grnLines || 0) > 0 ? `${p.grnLines} goods-received line(s)` : null,
        Number(p.doLines || 0) > 0 ? `${p.doLines} delivery line(s)` : null,
        Number(p.soReadyQty || 0) > 0 ? `${p.soReadyQty} piece(s) of stock already allocated` : null,
        p.soAllocatedBatch ? `stock batch ${p.soAllocatedBatch} allocated` : null,
      ].filter(Boolean);
      if (moved.length) {
        holds.push({
          ...p,
          poNumber: doc.poNumber,
          why: `goods are already keyed to the current measurements (${moved.join(', ')}) — writing ${[...filled, ...corrected].join(', ')} here would point the line at a stock bucket no lot carries (docs/bugs/0722)`,
        });
        continue;
      }

      writes.push({
        poNumber: doc.poNumber,
        supplierDoc: doc.supplierDoc,
        itemCode: p.itemCode,
        poItemId: p.poItemId,
        soItemId: p.soItemId ?? null,
        soDocNo: p.soDocNo ?? null,
        set,
        filled,
        corrected,
      });
    }
  }
  return { writes, holds, agreed };
}
