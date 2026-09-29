// ----------------------------------------------------------------------------
// One sofa module = one SO line (owner 2026-09-28, HC-SO-2609-221).
//
// A sofa module is a physical PIECE with its own place in the build: the two
// CNRs of a U sit at opposite ends of the back row. Booked as "8030-CNR x2" the
// order no longer says which end each one goes, and the supplier PO's layout
// drew one corner in a straight line. So a sofa piece is always its own line,
// qty 1, and the SKU pickers let the same module be tapped more than once
// (every other category keeps the tap-to-toggle picker).
//
// Shared by desktop SalesOrderNew / SalesOrderDetail / Guided / FromProducts
// and mobile MobileNewSO + MobileSkuPicker, so the rule is written once.
// ----------------------------------------------------------------------------

export const isSofaGroup = (group: string | null | undefined): boolean =>
  String(group ?? '').trim().toLowerCase() === 'sofa';

/** A multi-select tap. A repeatable row (a sofa piece) adds another copy; any
 *  other row toggles in / out as before. */
export function tapMultiPick<T>(
  prev: readonly T[], item: T, idOf: (t: T) => string, repeatable: boolean,
): T[] {
  if (repeatable) return [...prev, item];
  const id = idOf(item);
  return prev.some((x) => idOf(x) === id) ? prev.filter((x) => idOf(x) !== id) : [...prev, item];
}

/** Undo the LAST copy of `id` (the "-" beside a repeatable row). */
export function dropOneMultiPick<T>(prev: readonly T[], id: string, idOf: (t: T) => string): T[] {
  for (let i = prev.length - 1; i >= 0; i--) {
    if (idOf(prev[i] as T) === id) return [...prev.slice(0, i), ...prev.slice(i + 1)];
  }
  return [...prev];
}

export const multiPickCount = <T,>(prev: readonly T[], id: string, idOf: (t: T) => string): number =>
  prev.reduce((n, x) => (idOf(x) === id ? n + 1 : n), 0);

/** Piece `index` of `count` of an amount in sen: equal shares, the residue on
 *  piece 0, so the shares always sum to the whole. */
export function pieceShareSen(totalSen: number, index: number, count: number): number {
  const total = Math.round(Number(totalSen) || 0);
  if (count <= 1) return total;
  const base = Math.trunc(total / count);
  return index === 0 ? total - base * (count - 1) : base;
}

/** The number of pieces a line becomes: its qty when it is a whole number
 *  above 1, else 1 (nothing to split). */
export function sofaPieceCount(qty: unknown): number {
  const n = Number(qty);
  return Number.isInteger(n) && n > 1 ? n : 1;
}

/** Split every line `shouldSplit` accepts into qty-1 pieces, each placed right
 *  after the line it came from. `asPiece(line, i, n)` builds piece i of n;
 *  piece 0 must keep the line's identity (an existing line stays that line).
 *  Returns null when nothing needed splitting, so callers can skip a setState. */
export function splitSofaPieceLines<T>(
  lines: readonly T[],
  opts: {
    shouldSplit: (l: T) => boolean;
    qtyOf: (l: T) => unknown;
    asPiece: (l: T, index: number, count: number) => T;
  },
): T[] | null {
  let changed = false;
  const out: T[] = [];
  for (const l of lines) {
    const n = opts.shouldSplit(l) ? sofaPieceCount(opts.qtyOf(l)) : 1;
    if (n === 1) { out.push(l); continue; }
    changed = true;
    for (let i = 0; i < n; i++) out.push(opts.asPiece(l, i, n));
  }
  return changed ? out : null;
}

/** Create-payload form: a sofa item with qty N goes out as N qty-1 items. The
 *  line discount (if any) is shared across the pieces. */
export function expandSofaPieceItems<T extends { itemGroup?: string | null; qty: number; discountSen?: number }>(
  items: readonly T[],
): T[] {
  return splitSofaPieceLines(items, {
    shouldSplit: (it) => isSofaGroup(it.itemGroup),
    qtyOf: (it) => it.qty,
    asPiece: (it, i, n) => ({
      ...it,
      qty: 1,
      ...(it.discountSen !== undefined ? { discountSen: pieceShareSen(it.discountSen, i, n) } : {}),
    }),
  }) ?? [...items];
}

/** The notice shown when a save found a sofa line with qty > 1 and split it,
 *  so the operator checks the lines before saving again. */
export const SOFA_PIECES_SPLIT_NOTICE =
  'Each sofa piece is now its own line (qty 1), so the layout knows where each one goes. Check the lines, then save again.';

export const SOFA_PIECES_SPLIT_DIALOG = { title: 'Sofa pieces split', body: SOFA_PIECES_SPLIT_NOTICE } as const;
