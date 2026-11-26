
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
