/* The remark a new SO line is saved with (mfg_sales_order_items.remark).

   Two senders, two shapes: the desktop New SO form (SoLineCard's "Type
   remarks" box) posts it as the line's own `remark`; the phone form and the POS
   product page put it in `variants.remark`. The create read only the second, so
   a remark typed on desktop New SO was dropped on save (gap review P7). The
   line's own field wins because it is what the operator typed on that form. */
export function soLineRemark(item: { remark?: unknown; variants?: unknown }): string | null {
  const own = typeof item.remark === 'string' ? item.remark.trim() : '';
  if (own !== '') return own;
  const v = (item.variants as { remark?: unknown } | null | undefined)?.remark;
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}
