// The packing-list QR, "SCAN WHEN FULLY LOADED" (owner, 2026-11-27: 「那个QR code
// scan了就是全部loaded了」): one scan marks every delivery order on the sheet as
// Loaded (DB `DISPATCHED`), and never anything else.
//
// What this file decides, per delivery order, before anything is written:
//   LOADED (screen: Confirmed)   -> written to DISPATCHED through the office writer
//   DISPATCHED (screen: Loaded)  -> already loaded, nothing written (idempotent)
//   IN_TRANSIT / SIGNED / DELIVERED / INVOICED -> past Loaded, left alone
//   DRAFT                        -> left alone: confirming takes the stock out and
//                                   runs the short-stock / readiness preflight, which
//                                   is the office's decision, not a lorry scan's
//   CANCELLED, on hold, another company's, anything unexpected -> left alone
// (SIGNED and INVOICED are off the ladder, rung -1, but count as delivered: PAST.)
//
// The target is DERIVED from the ladder (the rung after LOADED), not typed again, so
// this cannot drift from what the per-DO scan and the office "Mark Loaded" write.
import { doScanBlockReason, doScanRungIndex, doScanStep, type DoScanStep } from '../shared/do-scan-ladder';

export const LORRY_LOAD_TARGET: DoScanStep['status'] = (() => {
  const step = doScanStep('LOADED', false);
  if (!step) throw new Error('lorry-load-scan: the ladder has no step after LOADED');
  return step.status;
})();

export type LorryLoadDecision =
  | { action: 'write'; from: string }
  | { action: 'skip'; outcome: 'ALREADY_DONE' | 'PAST' | 'BLOCKED'; from: string; message: string };

export const LORRY_LOAD_FOREIGN_REASON =
  'This drop is on another company\'s books, so this sheet cannot move it. Call the office.';
export const LORRY_LOAD_DRAFT_REASON =
  'Not confirmed yet (Draft), so it was not loaded. The office must confirm it first.';
export const LORRY_LOAD_ALREADY = 'Already loaded. Nothing changed.';
export const LORRY_LOAD_PAST = 'Already past Loaded, so it was left as it is.';
export const LORRY_LOAD_DONE = 'Marked as loaded.';

/** PURE. `onHold` and `foreign` are required: each one decides whether a write happens. */
export function decideLorryLoad(
  status: string | null,
  onHold: boolean | null,
  foreign: boolean,
): LorryLoadDecision {
  const from = String(status ?? '').trim().toUpperCase();
  if (foreign) return { action: 'skip', outcome: 'BLOCKED', from, message: LORRY_LOAD_FOREIGN_REASON };
  if (from === 'CANCELLED') {
    return { action: 'skip', outcome: 'BLOCKED', from, message: doScanBlockReason(from, false) ?? '' };
  }
  const targetIdx = doScanRungIndex(LORRY_LOAD_TARGET);
  const idx = doScanRungIndex(from);
  if (idx === targetIdx) return { action: 'skip', outcome: 'ALREADY_DONE', from, message: LORRY_LOAD_ALREADY };
  if (idx > targetIdx || from === 'SIGNED' || from === 'INVOICED') {
    return { action: 'skip', outcome: 'PAST', from, message: LORRY_LOAD_PAST };
  }
  if (onHold === true) {
    return { action: 'skip', outcome: 'BLOCKED', from, message: doScanBlockReason(from, true) ?? '' };
  }
  if (from === 'DRAFT') return { action: 'skip', outcome: 'BLOCKED', from, message: LORRY_LOAD_DRAFT_REASON };
  const step = doScanStep(from, false);
  if (step && step.status === LORRY_LOAD_TARGET) return { action: 'write', from };
  return { action: 'skip', outcome: 'BLOCKED', from, message: doScanBlockReason(from, false) ?? '' };
}

/** The lorry a set of delivery orders is on, from the crew plates: the most common
 *  non-blank plate, or null. PURE. */
export function dominantPlate(plates: ReadonlyArray<string | null | undefined>): string | null {
  const counts = new Map<string, number>();
  for (const p of plates) {
    const v = String(p ?? '').trim();
    if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [p, n] of counts) if (n > bestN) { best = p; bestN = n; }
  return best;
}

/** "Lorry VJK 8821: 5 of 6 delivery orders loaded". PURE. */
export function lorryLoadHeadline(
  plate: string | null,
  sheetNo: string,
  loaded: number,
  total: number,
): string {
  const who = plate ? `Lorry ${plate}` : `Packing list ${sheetNo}`;
  return `${who}: ${loaded} of ${total} delivery ${total === 1 ? 'order' : 'orders'} loaded`;
}
