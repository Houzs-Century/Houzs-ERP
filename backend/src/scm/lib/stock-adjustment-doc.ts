// ----------------------------------------------------------------------------
// Stock Adjustment document — the pure part (no I/O), shared by POST and PATCH
// in routes/inventory-adjustments.ts.
//
// A BUCKET is what the FIFO trigger moves stock in: (item_code, variant_key,
// batch_no) inside the document's one warehouse. Availability is checked per
// bucket and an edit writes one signed ADJUSTMENT per bucket whose net changed,
// so a bucket the edit did not touch never gets a movement.
// ----------------------------------------------------------------------------

import {
  isAdjustmentReasonCode,
  computeVariantKey,
  adjustmentIncreaseErrors,
  buildVariantSummary,
  type VariantAttrs,
} from '../shared';

export type AdjustmentLine = {
  line_no: number;
  item_code: string;
  product_name: string | null;
  item_group: string | null;
  variants: Record<string, unknown> | null;
  description2: string | null;
  variant_key: string;
  batch_no: string | null;
  qty: number;
  /** What the operator typed, if anything — the route resolves the real cost. */
  unit_cost_sen: number | null;
  reason_code: string;
  notes: string | null;
  /** Non-empty when an INCREASE is missing the variant / batch it needs. The
      caller decides whether it blocks: always on create, only for a changed
      bucket on edit (an untouched legacy line must not block a notes fix). */
  increase_errors: string[];
};

export type LinesParse =
  | { ok: true; lines: AdjustmentLine[] }
  | { ok: false; error: string; message: string };

/** The line list a request carries. The pre-BUG-66 single-row body
    ({ itemCode, qtyDelta, ... }) is still accepted as a one-line document so a
    browser holding the old bundle keeps working across the deploy. */
export function linesFromBody(body: Record<string, unknown>): unknown[] | null {
  if (Array.isArray(body.lines)) return body.lines;
  if (body.itemCode != null) return [{ ...body, qty: body.qtyDelta }];
  return null;
}

const str = (v: unknown): string => (v == null ? '' : String(v)).trim();

export function parseAdjustmentLines(raw: unknown[]): LinesParse {
  if (raw.length === 0) return { ok: false, error: 'lines_required', message: 'Add at least one line.' };
  const lines: AdjustmentLine[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const it = (raw[i] ?? {}) as Record<string, unknown>;
    const at = `Line ${i + 1}`;
    const itemCode = str(it.itemCode);
    if (!itemCode) return { ok: false, error: 'invalid_line', message: `${at}: pick a SKU.` };
    const qty = Number(it.qty);
    if (!Number.isInteger(qty) || qty === 0) {
      return { ok: false, error: 'invalid_qty_delta', message: `${at} (${itemCode}): qty must be a whole number other than 0.` };
    }
    const reasonCode = str(it.reasonCode);
    if (!isAdjustmentReasonCode(reasonCode)) {
      return { ok: false, error: 'reason_required', message: `${at} (${itemCode}): pick a reason.` };
    }
    const itemGroup = str(it.itemGroup) || null;
    const variants = (it.variants as Record<string, unknown> | null | undefined) ?? null;
    const batchNo = str(it.batchNo) || null;
    /* An explicit variantKey wins on BOTH signs: a decrease names the bucket it
       picked, and an edited line that kept its variants sends the key it was
       stored under, so a legacy row whose key no longer recomputes the same way
       does not read as a bucket change. Without one, an increase derives it from
       its attributes exactly like a GRN. */
    const variantKey = it.variantKey != null
      ? String(it.variantKey)
      : qty > 0 ? computeVariantKey(itemGroup, (variants as VariantAttrs | null) ?? null) : '';
    const cost = Number(it.unitCostSen ?? 0);
    lines.push({
      line_no: i + 1,
      item_code: itemCode,
      product_name: str(it.productName) || null,
      item_group: itemGroup,
      variants,
      description2: buildVariantSummary(String(itemGroup ?? ''), variants) || null,
      variant_key: variantKey,
      batch_no: batchNo,
      qty,
      unit_cost_sen: Number.isFinite(cost) && cost > 0 ? Math.round(cost) : null,
      reason_code: reasonCode,
      notes: str(it.notes) || null,
      increase_errors: qty > 0 ? adjustmentIncreaseErrors(itemGroup, variants, batchNo, itemCode) : [],
    });
  }
  return { ok: true, lines };
}

export type BucketRow = { item_code: string; variant_key: string | null; batch_no: string | null; qty: number };
export type Bucket = { item_code: string; variant_key: string; batch_no: string | null };

export const bucketKeyOf = (r: { item_code: string; variant_key: string | null; batch_no: string | null }): string =>
  JSON.stringify([r.item_code, r.variant_key ?? '', r.batch_no ?? null]);

export type BucketDelta = { bucket: Bucket; oldNet: number; newNet: number; delta: number };

/** Per bucket: the net the document has ALREADY moved (signed sum of its
    movements) against the net its new line list asks for. Only buckets whose
    net changes are returned, in first-seen order (new lines first). */
export function bucketDeltas(moved: readonly BucketRow[], wanted: readonly BucketRow[]): BucketDelta[] {
  const acc = new Map<string, BucketDelta>();
  const touch = (r: BucketRow) => {
    const k = bucketKeyOf(r);
    let d = acc.get(k);
    if (!d) {
      d = { bucket: { item_code: r.item_code, variant_key: r.variant_key ?? '', batch_no: r.batch_no ?? null }, oldNet: 0, newNet: 0, delta: 0 };
      acc.set(k, d);
    }
    return d;
  };
  for (const r of wanted) touch(r).newNet += Number(r.qty);
  for (const r of moved) touch(r).oldNet += Number(r.qty);
  const out: BucketDelta[] = [];
  for (const d of acc.values()) {
    d.delta = d.newNet - d.oldNet;
    if (d.delta !== 0) out.push(d);
  }
  return out;
}

/** The unit cost a negative movement was written off at, averaged over the
    bucket by quantity — what putting that stock BACK should cost, rather than
    whatever the bucket's lots happen to average today. 0 = none known. */
export function writtenOffUnitCostSen(moved: ReadonlyArray<BucketRow & { unit_cost_sen: number | null }>, key: string): number {
  let qty = 0;
  let sen = 0;
  for (const m of moved) {
    if (bucketKeyOf(m) !== key || Number(m.qty) >= 0) continue;
    const q = Math.abs(Number(m.qty));
    qty += q;
    sen += q * Number(m.unit_cost_sen ?? 0);
  }
  return qty > 0 ? Math.round(sen / qty) : 0;
}

/** "CH-1 (variant) batch B1" — how a bucket is named in an error sentence. */
export function bucketLabel(b: Bucket): string {
  return `${b.item_code}${b.variant_key ? ` (${b.variant_key})` : ''}${b.batch_no ? ` batch ${b.batch_no}` : ''}`;
}
