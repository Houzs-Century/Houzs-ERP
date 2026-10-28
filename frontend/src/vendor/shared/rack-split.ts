// rack-split — one GRN line's goods spread over several racks (owner
// 2026-10-02: 「很多」— one delivery of one product often fills more than one
// shelf). ONE home, mirrored verbatim into frontend/src/vendor/shared/ so the
// phone and desktop editors refuse exactly what the server refuses. The pair is
// refereed by rack-split.canonical.test.ts (byte comparison) — edit both copies
// or neither.
//
// Saving a split may leave goods unplaced (the storekeeper scans shelf by
// shelf); POSTING needs the split to account for every accepted unit, or the
// rack board would show fewer than were received.

export type RackSplit = { rackId: string; qty: number };

/** More shelves than this for one line is a typo, not a delivery. */
export const MAX_RACK_SPLITS = 20;

export function rackSplitTotal(splits: ReadonlyArray<RackSplit>): number {
  return splits.reduce((n, s) => n + s.qty, 0);
}

export function rackSplitRemaining(qtyAccepted: number, splits: ReadonlyArray<RackSplit>): number {
  return Math.max(0, qtyAccepted - rackSplitTotal(splits));
}

/** Why this split cannot be SAVED, or null. */
export function rackSplitError(qtyAccepted: number, splits: ReadonlyArray<RackSplit>): string | null {
  if (splits.length > MAX_RACK_SPLITS) return `A line can go on at most ${MAX_RACK_SPLITS} racks.`;
  const seen = new Set<string>();
  for (const s of splits) {
    if (!s.rackId) return 'Pick a rack for every quantity.';
    if (seen.has(s.rackId)) return 'The same rack is listed twice. Add the quantities together.';
    seen.add(s.rackId);
    if (!Number.isInteger(s.qty) || s.qty <= 0) return 'Each rack needs a whole quantity of at least 1.';
  }
  const total = rackSplitTotal(splits);
  if (total > qtyAccepted) return `The racks hold ${total} but only ${qtyAccepted} were accepted.`;
  return null;
}

/** Why a GRN with this line cannot be POSTED yet, or null. A line with no
 *  split at all is fine — it keeps the single rack (or none). */
export function rackSplitPostError(qtyAccepted: number, splits: ReadonlyArray<RackSplit>): string | null {
  if (splits.length === 0) return null;
  const total = rackSplitTotal(splits);
  if (total === qtyAccepted) return null;
  return `The racks hold ${total} of the ${qtyAccepted} accepted.`;
}

/** Add qty to a rack, merging into that rack's existing share. */
export function addToRackSplit(splits: ReadonlyArray<RackSplit>, rackId: string, qty: number): RackSplit[] {
  const hit = splits.find((s) => s.rackId === rackId);
  if (!hit) return [...splits, { rackId, qty }];
  return splits.map((s) => (s.rackId === rackId ? { rackId, qty: s.qty + qty } : s));
}

export function removeFromRackSplit(splits: ReadonlyArray<RackSplit>, rackId: string): RackSplit[] {
  return splits.filter((s) => s.rackId !== rackId);
}

/** The split a line actually has: its saved rows, else its single rack holding
 *  everything accepted (lines set before splits existed, or by the one-rack
 *  picker), else nothing. */
export function effectiveRackSplit(
  lineRackId: string | null | undefined,
  qtyAccepted: number,
  rows: ReadonlyArray<RackSplit>,
): RackSplit[] {
  if (rows.length > 0) return [...rows];
  if (lineRackId && qtyAccepted > 0) return [{ rackId: lineRackId, qty: qtyAccepted }];
  return [];
}
