
export type SubmittedAmendmentLine = {
  salesOrderItemId?: string | null;
  changeType?: string;
  newItemCode?: string | null;
  newVariants?: unknown;
  newQty?: number | null;
  newUnitPriceSen?: number | null;
  /* HC-0095 — true only when the operator TYPED the 0 in newUnitPriceSen. An
     unclaimed 0 is "no price found" and the apply keeps the stored price. */
  zeroPriceIntended?: boolean;
  newRemark?: string | null;
  newDiscountSen?: number | null;
  oldSnapshot?: unknown;
};

export type AmendmentLineRow = {
  amendment_id: string;
  sales_order_item_id: string | null;
  change_type: string;
  new_item_code: string | null;
  new_variants: unknown;
  new_qty: number | null;
  new_unit_price_sen: number | null;
  zero_price_intended: boolean;
  new_remark: string | null;
  new_discount_sen: number | null;
  old_snapshot: Record<string, unknown> | null;
};

export type BuildLineRowsResult =
  | { ok: true; rows: AmendmentLineRow[] }
  | { ok: false; reason: 'unreadable' }
  | { ok: false; reason: 'missing'; missingIds: string[] };

/**
 * Resolve every referenced SO line's item_group from the order itself, then
 * build the so_amendment_lines rows with that group stamped into old_snapshot.
 *
 * `sb` is the request-scoped Supabase client; `docNo` bounds the lookup to the
 * amendment's own Sales Order so an id from another order cannot be smuggled in.
 */
export async function buildAmendmentLineRows(
  sb: any,
  docNo: string,
  amendmentId: string,
  lines: SubmittedAmendmentLine[],
): Promise<BuildLineRowsResult> {
  const referencedItemIds = [...new Set(
    lines
      .map((l) => l.salesOrderItemId)
      .filter((x): x is string => typeof x === 'string' && x.length > 0),
  )];

  const itemGroupById = new Map<string, string | null>();
  const remarkById = new Map<string, string | null>();
  const discountById = new Map<string, number | null>();
  if (referencedItemIds.length > 0) {
    const { data, error } = await sb.from('mfg_sales_order_items')
      .select('id, item_group, remark, discount_sen').eq('doc_no', docNo).in('id', referencedItemIds);
    if (error) return { ok: false, reason: 'unreadable' };
    for (const r of (data ?? []) as Array<{ id: string; item_group: string | null; remark: string | null; discount_sen: number | null }>) {
      itemGroupById.set(r.id, r.item_group);
      remarkById.set(r.id, r.remark);
      discountById.set(r.id, r.discount_sen);
    }
    const missingIds = referencedItemIds.filter((id) => !itemGroupById.has(id));
    if (missingIds.length > 0) return { ok: false, reason: 'missing', missingIds };
  }

  const rows = lines.map((l) => {
    const snapshot = (l.oldSnapshot ?? null) as Record<string, unknown> | null;
    const group = l.salesOrderItemId
      ? itemGroupById.get(l.salesOrderItemId) ?? null
      : ((l.newVariants as Record<string, unknown> | null)?.itemGroup ?? null);
    const wasRemark = l.salesOrderItemId ? remarkById.get(l.salesOrderItemId) ?? null : null;
    const wasDiscount = l.salesOrderItemId ? discountById.get(l.salesOrderItemId) ?? null : null;
    const stamped = {
      ...(group != null ? { itemGroup: String(group) } : {}),
      ...(wasRemark != null ? { remark: String(wasRemark) } : {}),
      ...(wasDiscount != null ? { discountSen: Number(wasDiscount) } : {}),
    };
    return {
      amendment_id:        amendmentId,
      sales_order_item_id: l.salesOrderItemId ?? null,
      change_type:         String(l.changeType ?? 'SPEC'),
      new_item_code:       l.newItemCode ?? null,
      new_variants:        l.newVariants ?? null,
      new_qty:             l.newQty ?? null,
      new_unit_price_sen:  l.newUnitPriceSen ?? null,
      zero_price_intended: l.newUnitPriceSen === 0 && l.zeroPriceIntended === true,
      new_remark:          l.newRemark ?? null,
      new_discount_sen:
        typeof l.newDiscountSen === 'number' && Number.isFinite(l.newDiscountSen) && l.newDiscountSen >= 0
          ? Math.round(l.newDiscountSen)
          : null,
      old_snapshot:        snapshot || Object.keys(stamped).length > 0
        ? { ...(snapshot ?? {}), ...stamped }
        : null,
    };
  });

  return { ok: true, rows };
}

export const LINE_BUILD_ERRORS = {
  unreadable: {
    error: 'create_failed',
    reason: 'Could not read the current lines of this Sales Order, so nothing was saved. Please try again.',
  },
  missing: (n: number) => ({
    error: 'amendment_line_not_on_order',
    reason: `${n} of the changed lines are no longer on this Sales Order. Reload the order and submit again.`,
  }),
} as const;

