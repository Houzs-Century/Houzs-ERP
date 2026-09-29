// MobileNewSO's half of "one sofa piece = one line" (vendor/scm/lib/
// sofa-piece-lines.ts). Kept out of MobileNewSO.tsx, which sits at its
// file-size ceiling.
import { newIdempotencyKey } from "../lib/idempotency";
import { isSofaGroup, splitSofaPieceLines } from "../vendor/scm/lib/sofa-piece-lines";

type MobileLine = {
  key: string; addIdempotencyKey: string; itemId: string; itemGroup: string; qty: string;
  photoKeys: string[]; photoFiles: File[];
};

const qtyNum = (s: string): number => parseFloat(String(s).replace(/,/g, "")) || 0;

/** Split a sofa line with qty N into N qty-1 lines. Only a NEW line, or one
 *  whose qty changed from the saved `snapshots`, is split, so opening an
 *  imported "x2" order never rewrites it. Null when nothing split. */
export function splitMobileSofaPieces<T extends MobileLine>(
  lines: readonly T[],
  snapshots: ReadonlyArray<{ id: string; qty: number | null }>,
): T[] | null {
  const savedQty = new Map(snapshots.map((snap) => [snap.id, snap.qty ?? 1]));
  return splitSofaPieceLines(lines, {
    shouldSplit: (l) => isSofaGroup(l.itemGroup) && (!l.itemId || savedQty.get(l.itemId) !== (qtyNum(l.qty) || 1)),
    qtyOf: (l) => qtyNum(l.qty),
    asPiece: (l, i) => (i === 0
      ? { ...l, qty: "1" }
      : { ...l, key: newIdempotencyKey(), addIdempotencyKey: newIdempotencyKey(), itemId: "", qty: "1", photoKeys: [], photoFiles: [] }),
  });
}
