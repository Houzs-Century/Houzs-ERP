/* GRN inherited-field lock (owner 2026-08-20: "PO 开成 GR 就不可以在 GR 里改
 * variant — 要 cancel GR 再去 PO 改"). A GRN line LINKED to a PO line inherits its
 * identity + spec from that PO — item, category and VARIANT are what the supplier
 * was told to make — so they are READ-ONLY on the receipt. Only the line's own
 * receipt data (qty / cost / batch / delivery) is editable. To change an inherited
 * field, cancel the GRN (reverses the stock) and edit the PO, then receive again.
 * A MANUAL (unlinked) line is ad-hoc and keeps editing its own spec.
 *
 * Variant equality is compared on the rendered SUMMARY, not raw JSON, so a
 * re-serialised-but-unchanged payload (key order, a recomputed totalHeight) never
 * false-trips; only a real spec change is flagged. Pure — the route passes the
 * summary builder in so this stays free of the shared-module import graph. */

export type GrnLinePrev = {
  purchase_order_item_id: string | null;
  item_code: string | null;
  item_group?: string | null;
  variants?: Record<string, unknown> | null;
};

export type GrnLinePatch = {
  itemCode?: unknown;
  itemGroup?: unknown;
  variants?: unknown;
};

/** The inherited fields this patch genuinely changes on a PO-linked GRN line —
 *  [] when the line is manual, or only own-stage fields (qty/cost/…) move. */
export function grnInheritedFieldChanges(
  prev: GrnLinePrev,
  patch: GrnLinePatch,
  variantSummary: (group: string, variants: Record<string, unknown> | null) => string,
): string[] {
  if (!prev.purchase_order_item_id) return [];
  const storedCode = String(prev.item_code ?? '').trim().toUpperCase();
  const storedGroup = prev.item_group ?? null;
  const storedVariants = prev.variants ?? null;
  const nextGroup = patch.itemGroup !== undefined ? (patch.itemGroup as string | null) : storedGroup;
  const nextVariants = patch.variants !== undefined ? (patch.variants as Record<string, unknown> | null) : storedVariants;

  const changed: string[] = [];
  if (patch.itemCode !== undefined && String(patch.itemCode ?? '').trim().toUpperCase() !== storedCode) changed.push('product');
  if (String(nextGroup ?? '') !== String(storedGroup ?? '')) changed.push('category');
  if (variantSummary(String(nextGroup ?? ''), nextVariants) !== variantSummary(String(storedGroup ?? ''), storedVariants)) {
    changed.push('product options (variant)');
  }
  return changed;
}

/** The 409 body naming the locked fields and the cancel-to-source remedy. */
export function grnInheritedLockedRefusal(changed: string[]) {
  return {
    error: 'grn_inherited_field_locked',
    message:
      `The ${[...new Set(changed)].join(', ')} on this line comes from its Purchase Order, so it `
      + 'cannot be changed on the goods receipt. To change it, cancel this GRN (that reverses the '
      + 'received stock) and edit the PO, then receive it again.',
  };
}
