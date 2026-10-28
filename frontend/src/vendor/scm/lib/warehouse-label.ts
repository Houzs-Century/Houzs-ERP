/* One warehouse display label, one order — CODE first, then name.

   Nine call sites resolved a warehouse to a human label and two of them
   disagreed on the order, so the SAME warehouse rendered "KL WAREHOUSE" on a
   DO and "BALAKONG WAREHOUSE" on the mobile SO card. Code-first wins because
   the stored `sales_location` snapshot and every document label map already
   emit the code; making the outlier follow keeps a correctly-derived SO's
   warehouse label byte-identical to its stored text.

   MIRRORED, byte for byte, at frontend/src/vendor/scm/lib/warehouse-label.ts.
   The frontend cannot import from backend/src, and while this rule lived only
   here EVERY frontend surface hand-wrote its own order — which is how the
   Purchase Order list came to print the truncated NAME ("BALAKONG WAREHO…")
   in its Purchase Location column while the same page's PDF export printed
   the CODE. The pair is refereed by
   frontend/src/vendor/scm/lib/warehouse-label.canonical.test.ts and by
   backend/scripts/check-shared-mirrors.mjs; edit BOTH copies or the test
   fails naming the file that drifted. */

export type WarehouseLabelSource = {
  code?: string | null;
  name?: string | null;
};

const trimmed = (v: string | null | undefined): string | null => {
  const s = (v ?? '').trim();
  return s === '' ? null : s;
};

export const warehouseLabel = (
  w: WarehouseLabelSource | null | undefined,
): string | null => {
  if (!w) return null;
  return trimmed(w.code) ?? trimmed(w.name);
};
