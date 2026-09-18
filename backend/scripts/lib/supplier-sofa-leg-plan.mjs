// ---------------------------------------------------------------------------
// supplier-sofa-leg-plan — which sofa lines may take the SUPPLIER'S stated leg
// height, and which must not, decided without touching the database.
//
// THE GAP IT ANSWERS. The supplier's own export states the leg it built into
// each compartment ("leg:6inch / Nylon Fabric"); 68 of our lines across 35
// purchase orders carry NOTHING in `variants.legHeight` while the supplier
// states 1 or 6 inches (measured on production 2026-09-11, after the
// compartment corrections of run 34557669854 had landed). The owner:
//
//     根据 supplier 的 PO，对回之前的 PO 跟 GR 全部补齐。补齐 PO 的同时，
//     也要补齐 Sales Order，把它的 variant 还有 sofa compartment 全部对齐。
//
// WHY THIS IS NOT A BLIND UPDATE — the lesson of docs/bugs/0722. A sofa's leg
// height is part of its INVENTORY IDENTITY: `computeVariantKey` emits
// `legheight=…` for a sofa, so stock is bucketed by it. Writing a leg onto a
// line whose goods are ALREADY IN — the lot was created from the blank-leg
// snapshot, and of every sofa lot on production not one carries a leg segment —
// moves that line to a bucket no lot has ever been stored under. That is
// precisely how three delivery orders shipped against nothing, consumed no lot
// and cost nothing (bug 0722, repaired by PR #3624). Filling the leg "to tidy
// up" would re-create that defect on a larger scale.
//
// So the gate is not caution, it is the defect: a line may take the leg only
// while NOTHING has yet been keyed off its current, blank, identity —
//   · nothing received on the purchase line,
//   · no goods-received line hanging off it,
//   · no delivery line off its sales line,
//   · no stock allocated or reserved to its sales line.
// Everything else is HELD and named, because putting those right means moving
// the stock rows with the line, which is a separate, stock-aware tool and the
// owner's decision (handoff tasks/HANDOFF-sofa-supplier-alignment-2026-09-10.md
// section 6).
//
// PURE. It takes rows somebody else read and returns what WOULD be written, so
// every refusal below is a test rather than a hope.
// ---------------------------------------------------------------------------

/** How this repo spells a leg height on a line: the number, then an inch mark.
 *  Measured on production 2026-09-11 across purchase, sales and goods-received
 *  sofa lines: `6"` 347, `2"` 118, `1"` 38 — the bare number appears nowhere, so
 *  writing `6` would open a SECOND spelling of one height, and a second stock
 *  bucket with it. */
export const spellLeg = (inches) => `${Number(inches)}"`;

/** A height compares as a NUMBER — `1` and `1"` are one inch. Anything with no
 *  digit in it (the placeholder `Default`) reads as null so it can be told apart
 *  from a height somebody actually picked. */
export const legNumber = (v) => {
  if (v === undefined || v === null) return null;
  const m = /-?\d+(?:\.\d+)?/.exec(String(v));
  return m ? Number(m[0]) : null;
};

/** `Default` is not a pick — it is the placeholder `backfill-sofa-leg-default`
 *  wrote so the Leg Height field would not show "Select…", and the same word
 *  that stranded the 0722 lines. The supplier's real height supersedes it; any
 *  OTHER value somebody put there does not. */
const isPlaceholder = (v) => v === undefined || v === null
  || String(v).trim() === '' || String(v).trim().toLowerCase() === 'default';

/**
 * @param docs [{
 *   poNumber, supplierDoc, ourPoRef,
 *   pairs: [{
 *     poItemId, soItemId|null, soDocNo|null, itemCode,
 *     supplierLeg,                 // number|null — what the supplier states
 *     poLeg, soLeg,                // what we hold now (string|null)
 *     receivedQty, grnLines, doLines,
 *     soReadyQty, soAllocatedBatch,
 *   }]
 * }]
 * @returns { writes, holds, agreed } — `writes` is the instruction list the
 *   apply half executes, one entry per LINE, naming both rows it touches.
 */
export function planSupplierLegFill(docs) {
  const writes = [];
  const holds = [];
  let agreed = 0;

  for (const doc of docs) {
    for (const p of doc.pairs) {
      const want = legNumber(p.supplierLeg);
      if (want === null) continue;                    // the supplier states nothing

      const hold = (why) => holds.push({ ...p, poNumber: doc.poNumber, supplierDoc: doc.supplierDoc, want, why });
      const havePo = legNumber(p.poLeg);
      const haveSo = legNumber(p.soLeg);

      /* Somebody's own pick is never overwritten - not by this tool. A stated
         height that disagrees with the supplier is a FINDING for the owner (the
         supplier is the authority on a proceeded order, so it is probably ours
         that is wrong - but changing a height that was chosen deliberately is a
         different decision from filling a blank one). */
      const stated = [
        !isPlaceholder(p.poLeg) && havePo !== want ? `the purchase line states ${p.poLeg}` : null,
        !isPlaceholder(p.soLeg) && haveSo !== want ? `the sales line states ${p.soLeg}` : null,
      ].filter(Boolean);
      if (stated.length) { hold(`${stated.join(' and ')}, the supplier says ${want} inch — a stated height is the owner's call, not a blank to fill`); continue; }

      const poDone = havePo === want;
      const soDone = p.soItemId ? haveSo === want : true;
      if (poDone && soDone) { agreed += 1; continue; }

      /* THE 0722 GATE. Anything already keyed off the blank identity pins the
         line where it is. */
      const moved = [
        Number(p.receivedQty || 0) > 0 ? `${p.receivedQty} already received` : null,
        Number(p.grnLines || 0) > 0 ? `${p.grnLines} goods-received line(s)` : null,
        Number(p.doLines || 0) > 0 ? `${p.doLines} delivery line(s)` : null,
        Number(p.soReadyQty || 0) > 0 ? `${p.soReadyQty} piece(s) of stock already allocated` : null,
        p.soAllocatedBatch ? `stock batch ${p.soAllocatedBatch} allocated` : null,
      ].filter(Boolean);
      if (moved.length) {
        hold(`goods are already keyed to the blank leg (${moved.join(', ')}) — writing ${want} inch here would point the line at a stock bucket no lot carries (docs/bugs/0722)`);
        continue;
      }

      writes.push({
        poNumber: doc.poNumber,
        supplierDoc: doc.supplierDoc,
        itemCode: p.itemCode,
        poItemId: poDone ? null : p.poItemId,
        soItemId: soDone ? null : p.soItemId,
        soDocNo: p.soDocNo ?? null,
        legHeight: spellLeg(want),
        want,
      });
    }
  }
  return { writes, holds, agreed };
}
