// ----------------------------------------------------------------------------
// specialOrderSurface — which special-order UI a Sales Order line gets.
//
// Owner 2026-09-10, asked where the COLOUR of a custom pillow and the SIZE of a
// `(SP)` mattress are meant to be written so the supplier sees them:
// 「我有一些单一的SKU 好像mattress SP和这个custom 需要选颜色 SP需要写尺寸 这种我可
// 以在哪里填写呢？」 — and there was nowhere. The answer he approved is the
// free-text "Custom / other" field that already exists inside SpecialOrders:
// 「你讲的做法，也就是开放 custom order 的自由文字，那个是没问题的」.
//
// TWO DIFFERENT QUESTIONS, and conflating them is what kept the field out of
// reach:
//
//   block        — does this line get the standalone Special Order panel at all?
//   optionPicker — inside it, may the operator TICK a catalogue add-on?
//
// The mattress gate used to answer both with one condition ("only if a tickable
// add-on exists for this category, or the line already carries a special"), and
// the catalogue defines no mattress add-ons, so a plain SP mattress showed no
// panel — and with it no free text. Accessories never had a panel at all.
//
// WHY THE PICKER STAYS SHUT ON POOLED GOODS, and why the free text does not.
// `computeVariantKey` (scm/shared/variant-key.ts) builds a line's stock bucket
// from the group's own attributes plus `normSpecials(a.specials)`. Ticking an
// add-on therefore appends `special=…` to the key and splits the bucket — which
// for accessories, that pool by code across customers, would stop a line
// matching the stock and the purchase orders raised for it. `extraAddonNote` is
// read by NO branch of that function, so free text cannot move a line anywhere.
// That asymmetry is the whole design: describe freely, re-key never.
//
// A line that ALREADY carries picks keeps its picker, so those picks render
// with their real labels instead of falling into SpecialOrders' "retired —
// untick to remove" branch, which would misdescribe a live add-on as dead.
//
// SOFA and BEDFRAME are absent on purpose: they render SpecialOrders INSIDE
// their own configurator panel, so a standalone block would show it twice.
// SERVICE is absent because a fee line is not goods and orders nothing.
// ----------------------------------------------------------------------------

import { useSkuCategoryByCode } from './mfg-products-queries';

const POOLED = new Set(['accessory', 'others']);

/** Categories that own a standalone Special Order panel.
 *
 *  fabric_accessory (Sofa Accessory, owner 2026-09-14) is here because its own
 *  panel holds the fabric picker and nothing else. Its lines were `accessory`
 *  until that day and kept their special-order text in `extraAddonNote`; left
 *  out of this set, the panel vanished on both surfaces while the PDF went on
 *  printing the note (HC-SO-2609-071, owner 2026-09-15). It is not POOLED: it
 *  keys stock by colour and binds per order, like the sofa it rides with. */
const STANDALONE = new Set(['mattress', 'accessory', 'fabric_accessory', 'others']);

export type SpecialOrderSurface = {
  block: boolean;
  optionPicker: boolean;
};

export function specialOrderSurface(input: {
  category: string;
  hasItemCode: boolean;
  pickedSpecialCount: number;
}): SpecialOrderSurface {
  const cat = input.category.trim().toLowerCase();
  if (!input.hasItemCode || !STANDALONE.has(cat)) return { block: false, optionPicker: false };
  return {
    block: true,
    optionPicker: !POOLED.has(cat) || input.pickedSpecialCount > 0,
  };
}

export function useSpecialOrderSurface(input: {
  itemCode: string;
  fallbackCategory: string;
  pickedSpecialCount: number;
}): SpecialOrderSurface {
  const q = useSkuCategoryByCode(input.itemCode || undefined);
  return specialOrderSurface({
    category: String(q.data ?? '').toLowerCase() || input.fallbackCategory,
    hasItemCode: Boolean(input.itemCode),
    pickedSpecialCount: input.pickedSpecialCount,
  });
}
