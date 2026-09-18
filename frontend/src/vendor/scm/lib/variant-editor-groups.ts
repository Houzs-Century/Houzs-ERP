/* Which purchase-line categories get the variant editor (fabric / seat / leg /
   divan pickers) on the PO and consignment-order forms, desktop and card.

   ONE home for the four forms that used to each carry their own copy
   (PurchaseOrderNew, PurchaseConsignmentOrderNew, PoLineCard, PcLineCard) — a
   category added to one and not the others is a form that silently drops the
   fabric. `fabric_accessory` is the Sofa Accessory category (owner 2026-09-14):
   a custom pillow picks its fabric colour like a sofa. */
export const VARIANT_EDITOR_GROUPS: ReadonlySet<string> = new Set(['sofa', 'bedframe', 'fabric_accessory']);

export const showsVariantEditor = (category: string | null | undefined): boolean =>
  Boolean(category) && VARIANT_EDITOR_GROUPS.has(category ?? '');
