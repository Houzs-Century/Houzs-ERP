/* Which product categories an owner may swap a model or SKU between from the
   edit screens (owner 2026-09-14: 「我不能自己更换category吗？」).

   Only ACCESSORY <-> FABRIC_ACCESSORY (Sofa Accessory). Both are non-main,
   single-price categories, so a swap changes how stock is keyed (by fabric
   colour or not) and nothing about pricing or the sofa rules. Any other move —
   a mattress into a sofa — changes pricing, required variants and the main-
   product rules for every open order, and stays refused.

   Orders already on the books keep the category they were written with; moving
   them is a separate, audited data run. */
export const SWAPPABLE_CATEGORIES: readonly string[] = ['ACCESSORY', 'FABRIC_ACCESSORY'];

export function categorySwapAllowed(from: string | null | undefined, to: string | null | undefined): boolean {
  const a = String(from ?? '').toUpperCase();
  const b = String(to ?? '').toUpperCase();
  return a !== b && SWAPPABLE_CATEGORIES.includes(a) && SWAPPABLE_CATEGORIES.includes(b);
}
