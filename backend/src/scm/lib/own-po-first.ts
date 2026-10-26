// ----------------------------------------------------------------------------
// own-po-first — a company-2 Sofa Accessory line is planned from the purchase
// order it was raised from before the pool (2990-0019).
//
// Sim 2026-10-26: 2990-PO-2610-059 was raised from 2990-SO-2610-049 (XAMMAR +
// SQUARE PILLOW EZ-002), yet the pooled walk handed its pillow to
// 2990-SO-2610-046 (same fabric, same 11-24 delivery, smaller doc no) — a
// HOOKKA pillow for a DORSETTLOFT sofa, and 049 asked to buy its pillow twice.
// Every new pillow PO then slid one order up the queue (048's PO-062 went to
// 049). A Sofa Accessory is made in the customer's fabric with its sofa, so its
// PO belongs to the line it was raised for — 「HC rules wont have this kind of
// issue」.
//
// Company 2 still pools; this only puts the line's OWN PO in front of the pool,
// which is what the stored allocator already does at receipt (its bound pass,
// so-stock-allocation.ts step 6b, is not company-gated): a linked line takes
// its own received units, then its own open quantity, then the pool like
// anyone else. Whatever its PO carries beyond the line's need, and any link to
// a line that is no longer demand or sits in another bucket, stays pooled.
//
// Pure decisions only — mrp.ts routes its PO lines through these and walks
// section 7 as before; mrp.own-po-first.test.ts drives the 2990-0019 shape.
// ----------------------------------------------------------------------------

import type { BatchClaims } from './batch-claimed-stock';

/** One open PO line's supply — mrp.ts's PoSupply shape. */
export type OwnPoSupply = { poNumber: string; eta: string | null; qtyLeft: number; supplierId: string | null };

export type OwnPoFirst = {
  /** soItemId → the line's bucket and what it still needs. */
  lines: Map<string, { bucketKey: string; need: number }>;
  received: Map<string, number>;
  open: Map<string, OwnPoSupply[]>;
};

const byDateAsc = (a: string | null, b: string | null): number => {
  if (a === b) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a < b ? -1 : 1;
};

export const isOwnPoFirstGroup = (itemGroup: string | null | undefined): boolean =>
  (itemGroup ?? '').toLowerCase() === 'fabric_accessory';

export function openOwnPoFirst(lines: Iterable<{ soItemId: string; bucketKey: string; need: number }>): OwnPoFirst {
  const own: OwnPoFirst = { lines: new Map(), received: new Map(), open: new Map() };
  for (const l of lines) own.lines.set(l.soItemId, { bucketKey: l.bucketKey, need: l.need });
  return own;
}

/** Route one PO line. False = not a linked line's own supply in its own
 *  bucket, and the caller pools it as before. */
export function takeOwnPoLine(
  own: OwnPoFirst, soItemId: string | null, bucketKey: string, received: number, open: OwnPoSupply | null,
): boolean {
  const line = soItemId ? own.lines.get(soItemId) : undefined;
  if (!soItemId || !line || line.bucketKey !== bucketKey) return false;
  if (received > 0) own.received.set(soItemId, (own.received.get(soItemId) ?? 0) + received);
  if (open && open.qtyLeft > 0) {
    const q = own.open.get(soItemId) ?? [];
    q.push(open);
    own.open.set(soItemId, q);
  }
  return true;
}

/** Split each line's own open supply into what the line keeps (its need, less
 *  what its PO already received) and what goes back to the pool. Kept units
 *  still count as the bucket's PO Outstanding. */
export function settleOwnPoFirst(own: OwnPoFirst): {
  dedicatedByLine: Map<string, OwnPoSupply[]>;
  pooled: Array<OwnPoSupply & { bucketKey: string }>;
  outstandingByBucket: Map<string, number>;
} {
  const dedicatedByLine = new Map<string, OwnPoSupply[]>();
  const pooled: Array<OwnPoSupply & { bucketKey: string }> = [];
  const outstandingByBucket = new Map<string, number>();
  for (const [soItemId, open] of own.open) {
    const line = own.lines.get(soItemId)!;
    let room = Math.max(0, line.need - (own.received.get(soItemId) ?? 0));
    const kept: OwnPoSupply[] = [];
    for (const p of [...open].sort((a, b) => byDateAsc(a.eta, b.eta))) {
      const keep = Math.min(room, p.qtyLeft);
      room -= keep;
      if (keep > 0) kept.push({ ...p, qtyLeft: keep });
      if (p.qtyLeft > keep) pooled.push({ ...p, qtyLeft: p.qtyLeft - keep, bucketKey: line.bucketKey });
    }
    if (kept.length === 0) continue;
    dedicatedByLine.set(soItemId, kept);
    const keptQty = kept.reduce((acc, p) => acc + p.qtyLeft, 0);
    outstandingByBucket.set(line.bucketKey, (outstandingByBucket.get(line.bucketKey) ?? 0) + keptQty);
  }
  return { dedicatedByLine, pooled, outstandingByBucket };
}

/** The line's received units are on hand in its bucket: carve them out of the
 *  free pool for that line, the same pairing as a sofa batch lock. */
export function claimOwnReceived(own: OwnPoFirst, claims: BatchClaims): void {
  for (const [soItemId, got] of own.received) {
    const line = own.lines.get(soItemId)!;
    const claim = Math.min(got, line.need);
    if (claim <= 0 || claims.qtyByLine.has(soItemId)) continue;
    claims.qtyByLine.set(soItemId, claim);
    claims.qtyByBucket.set(line.bucketKey, (claims.qtyByBucket.get(line.bucketKey) ?? 0) + claim);
  }
}
