// ----------------------------------------------------------------------------
// Stock-adjustment DECREASE picker — which open lot ("bucket") a manual decrease
// takes stock from. A bucket is one (variant_key, batch_no) pair; the backend
// (/inventory/buckets/:itemCode) groups a SKU's open lots into these.
//
// WHY A STABLE KEY. The plainest bucket — no variant AND no batch (variant_key
// '' with batch_no null) — is a real, pickable lot: un-batched stock such as a
// free-gift accessory. Identifying the picked bucket by "variant_key || batch_no"
// made that one bucket indistinguishable from "nothing picked" — both read as
// empty — so the <select> snapped back to its placeholder and the save gate kept
// demanding a choice. That lot could never be decreased (owner report
// 2026-09-17: AMN-SOFA PILLOW at KL warehouse held 190 pcs in a no-batch bucket
// beside a 10-pc batched one, and only the 10-pc one could be selected).
//
// bucketKey gives every bucket a non-empty identity and reserves '' for "nothing
// picked". The JSON encoding keeps a variant-only bucket distinct from a
// batch-only one and is safe to round-trip through a DOM <option value>.
// NO React, no I/O — same contract as the other vendor/scm/lib helpers.
// ----------------------------------------------------------------------------

export type AdjustBucket = {
  variant_key: string;
  batch_no: string | null;
};

/** The picker's placeholder value — "no bucket chosen". No real bucket produces
 *  it, so `pickedKey === NO_BUCKET_PICKED` is the honest "nothing selected" test
 *  (which `!variant_key && !batch_no` was not, for the all-empty bucket). */
export const NO_BUCKET_PICKED = '';

/** Stable, non-empty identity for one open bucket, safe as a <select> value.
 *  JSON so a variant-only bucket ("A", null) and a batch-only bucket ("", "A")
 *  never collide, and the all-empty bucket still yields a non-empty key. */
export function bucketKey(b: AdjustBucket): string {
  return JSON.stringify([b.variant_key, b.batch_no ?? null]);
}
