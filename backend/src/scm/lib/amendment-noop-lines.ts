// amendment-noop-lines — drop the lines of a Sales Order amendment that ask
// for NOTHING, before they can become an approval.
//
// Owner 2026-09-15, on HC-SO-011410: 「为什么raise so amendment 还是会出来两个审批?」
// A Delivery Date change made on the phone arrived as TWO amendments — A1 for
// the Purchaser carrying one SPEC line on JAGER-(K), A2 for Logistic carrying
// the date plus one SPEC line on DISPOSE. Neither line changed anything: their
// new_* equalled the line as it stood, except that new_variants carried a
// `remark` key the phone's buildVariants copies in from the line remark (which
// the imported AutoCount lines hold as 「账本原文: …」). The phone compared THAT
// blob with the stored variants (no `remark` key) and read every remarked line
// as changed. Read-only on production, 2026-09-01 → 09-15: 42 such lines in 47
// amendments; the 41 approved ones raised 32 PO amendments to suppliers over
// changes that did not exist, and wrote `remark` into 113 imported lines'
// variants.
//
// The phone is fixed at the source (it no longer compares or sends the remark
// through variants). This module is the SERVER's own copy of the rule — an
// amendment must request something — applied per line, so no client, present
// or future, can put a no-change line in front of an approver again. It runs in
// the submit route BEFORE the empty check and the lane split (a lane that only
// no-op lines would have opened never opens), and in the lane PREVIEW, so the
// desk the requester is shown is the desk that will actually be asked.
//
// A line is a no-op when it is a SPEC / QTY change on an EXISTING line and
// every field it carries equals the line as stored. A field the payload omits
// (null / undefined) asks for nothing and cannot make the line a change.
// Variants are compared WITHOUT the `remark` key on either side — that key is
// the phone's side channel for the line remark, which rides `newRemark`.
// ADD and REMOVE are whole-line changes and always kept.
//
// `null` means the read FAILED; the caller refuses rather than guessing.

export type NoopCheckLine = {
  salesOrderItemId?: string | null;
  changeType?: string;
  newItemCode?: string | null;
  newVariants?: unknown;
  newQty?: number | null;
  newUnitPriceSen?: number | null;
  newRemark?: string | null;
  newDiscountSen?: number | null;
};

export type StoredLine = {
  id: string;
  item_code: string | null;
  qty: number | null;
  unit_price_sen: number | null;
  variants: unknown;
  remark: string | null;
  discount_sen: number | null;
};

/** Canonical JSON (sorted keys) so key order can never read as a change. */
export function canonicalJson(o: unknown): string {
  if (o == null) return 'null';
  if (typeof o !== 'object') return JSON.stringify(o);
  if (Array.isArray(o)) return `[${o.map(canonicalJson).join(',')}]`;
  const rec = o as Record<string, unknown>;
  return `{${Object.keys(rec).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`).join(',')}}`;
}

/** The variants blob as an amendment compares it: without the `remark` side
 *  channel, and with an empty object reading the same as none. */
export function variantsForCompare(v: unknown): string {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return canonicalJson(v ?? null);
  const rest: Record<string, unknown> = { ...(v as Record<string, unknown>) };
  delete rest.remark;
  return Object.keys(rest).length === 0 ? 'null' : canonicalJson(rest);
}

/** True when the line asks for a value that differs from the stored line. */
export function amendmentLineIsNoop(l: NoopCheckLine, cur: StoredLine): boolean {
  const type = String(l.changeType ?? '').toUpperCase();
  if (type === 'ADD' || type === 'REMOVE') return false;
  if (l.newItemCode != null && l.newItemCode.trim() !== (cur.item_code ?? '').trim()) return false;
  if (l.newQty != null && Number(l.newQty) !== Number(cur.qty ?? 1)) return false;
  if (l.newUnitPriceSen != null && Math.round(Number(l.newUnitPriceSen)) !== Math.round(Number(cur.unit_price_sen ?? 0))) return false;
  if (l.newRemark != null && l.newRemark.trim() !== (cur.remark ?? '').trim()) return false;
  if (l.newDiscountSen != null && Math.round(Number(l.newDiscountSen)) !== Math.round(Number(cur.discount_sen ?? 0))) return false;
  if (l.newVariants != null && variantsForCompare(l.newVariants) !== variantsForCompare(cur.variants)) return false;
  return true;
}

/** True when the ONLY value this line moves is the sell price and/or discount —
 *  SKU / quantity / colour-fabric / remark all still equal the stored line. This
 *  is the price-lane carve-out signal (shared/amendment-lane.ts PRICE lane): a
 *  price-only change on a 2990 product line signs with Finance, not the
 *  Purchaser. It uses the SAME field-by-field comparison as amendmentLineIsNoop,
 *  so the two can never disagree about what "changed"; a no-op line (nothing
 *  moved) is not price-only. ADD / REMOVE are whole-line changes, never
 *  price-only. */
export function amendmentLinePriceOnly(l: NoopCheckLine, cur: StoredLine): boolean {
  const type = String(l.changeType ?? '').toUpperCase();
  if (type === 'ADD' || type === 'REMOVE') return false;
  const priceMoved =
    (l.newUnitPriceSen != null && Math.round(Number(l.newUnitPriceSen)) !== Math.round(Number(cur.unit_price_sen ?? 0)))
    || (l.newDiscountSen != null && Math.round(Number(l.newDiscountSen)) !== Math.round(Number(cur.discount_sen ?? 0)));
  if (!priceMoved) return false;
  const nonPriceMoved =
    (l.newItemCode != null && l.newItemCode.trim() !== (cur.item_code ?? '').trim())
    || (l.newQty != null && Number(l.newQty) !== Number(cur.qty ?? 1))
    || (l.newRemark != null && l.newRemark.trim() !== (cur.remark ?? '').trim())
    || (l.newVariants != null && variantsForCompare(l.newVariants) !== variantsForCompare(cur.variants));
  return !nonPriceMoved;
}

/**
 * The submitted lines minus the ones that request nothing. Reads the referenced
 * lines from THIS order only (an id from another order is unknown here and is
 * kept — the row builder refuses it as `missing` later). `null` = read failed.
 */
export async function dropNoopAmendmentLines<L extends NoopCheckLine>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SCM PostgREST client is untyped at every call site in this tree.
  sb: any,
  docNo: string,
  lines: L[],
): Promise<{ kept: L[]; dropped: L[] } | null> {
  const ids = [...new Set(lines
    .map((l) => l.salesOrderItemId)
    .filter((x): x is string => typeof x === 'string' && x.length > 0))];
  if (ids.length === 0) return { kept: [...lines], dropped: [] };
  const { data, error } = await sb.from('mfg_sales_order_items')
    .select('id, item_code, qty, unit_price_sen, variants, remark, discount_sen')
    .eq('doc_no', docNo).in('id', ids);
  if (error) return null;
  const byId = new Map<string, StoredLine>();
  for (const r of (data ?? []) as StoredLine[]) byId.set(r.id, r);
  const kept: L[] = [];
  const dropped: L[] = [];
  for (const l of lines) {
    const cur = l.salesOrderItemId ? byId.get(l.salesOrderItemId) : undefined;
    if (cur && amendmentLineIsNoop(l, cur)) dropped.push(l);
    else kept.push(l);
  }
  return { kept, dropped };
}
