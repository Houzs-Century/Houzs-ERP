// ---------------------------------------------------------------------------
// grn-scan-check — the "check before it becomes a draft" step for delivery-
// order scans (owner 2026-11-03, after Hookka's scan modal). The scan reads and
// matches as before, but instead of minting the draft it keeps a working copy
// (scan_jobs.review) the operator edits: supplier, D.O. no, date, and each line
// with the PO line it receives into. Create then converts exactly those lines
// through createDraftGrnFromPoItems — the same core, the same safety: DRAFT
// only, always from PO lines, nothing standalone.
// ---------------------------------------------------------------------------

import type { GrnExtracted } from './grn-scan-extract';
import type { GrnMatchResult, OpenPoLine } from './grn-scan-match';

/** One line of the working copy. `poItemId` null = not yet tied to a PO line
 *  (the operator picks one, or deletes the line); `read` is what the paper said. */
export type ReviewLine = {
  key: string;
  poItemId: string | null;
  qty: number;
  read: { itemCode: string | null; description: string | null; qty: number; poNo: string | null } | null;
};

export type GrnReview = {
  supplierId: string | null;
  // The supplier name as printed, kept beside the resolved one.
  supplierRead: string | null;
  doNo: string | null;
  deliveryDate: string | null;
  notes: string | null;
  lines: ReviewLine[];
};

let seq = 0;
const lineKey = () => `l${Date.now().toString(36)}${(seq++).toString(36)}`;

const readOf = (l: { itemCode: string | null; description: string | null; qty: number; poNo?: string | null }) =>
  ({ itemCode: l.itemCode, description: l.description, qty: l.qty, poNo: l.poNo ?? null });

/** The first working copy, from the read and the matcher. Matched lines arrive
 *  tied to their PO line; lines the matcher could not place arrive untied with
 *  what was printed, so nothing read is silently dropped. */
export function buildReview(parsed: GrnExtracted | null, supplierId: string | null, match: GrnMatchResult | null): GrnReview {
  const lines: ReviewLine[] = [];
  for (const p of match?.picks ?? []) lines.push({ key: lineKey(), poItemId: p.poItemId, qty: p.qty, read: null });
  for (const u of match?.unmatched ?? []) {
    if (u.line.qty <= 0) continue;
    lines.push({ key: lineKey(), poItemId: u.candidatePoItemIds.length === 1 ? u.candidatePoItemIds[0] : null, qty: u.line.qty, read: readOf(u.line) });
  }
  // A read the matcher never saw (supplier unknown, nothing matched): keep every printed line.
  if (!match && parsed) for (const l of parsed.lines) if (l.qty > 0) lines.push({ key: lineKey(), poItemId: null, qty: l.qty, read: readOf(l) });
  return {
    supplierId,
    supplierRead: parsed?.supplierName ?? null,
    doNo: parsed?.doNo ?? null,
    deliveryDate: parsed?.deliveryDate ?? null,
    notes: null,
    lines,
  };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** The operator's edit as saved: only known fields, quantities as non-negative
 *  numbers, at most 500 lines. Ownership of each PO line is checked at Create,
 *  by the convert core's company-scoped read. */
export function cleanReview(input: unknown): GrnReview | null {
  if (!input || typeof input !== 'object') return null;
  const r = input as Record<string, unknown>;
  const rawLines = Array.isArray(r.lines) ? r.lines.slice(0, 500) : [];
  const lines: ReviewLine[] = rawLines.map((x) => {
    const l = (x ?? {}) as Record<string, unknown>;
    const qty = Number(l.qty);
    const read = l.read && typeof l.read === 'object' ? (l.read as Record<string, unknown>) : null;
    return {
      key: str(l.key) ?? lineKey(),
      poItemId: str(l.poItemId),
      qty: Number.isFinite(qty) && qty > 0 ? qty : 0,
      read: read ? { itemCode: str(read.itemCode), description: str(read.description), qty: Number(read.qty) || 0, poNo: str(read.poNo) } : null,
    };
  });
  const date = str(r.deliveryDate);
  return {
    supplierId: str(r.supplierId),
    supplierRead: str(r.supplierRead),
    doNo: str(r.doNo),
    deliveryDate: date && ISO.test(date) ? date : null,
    notes: str(r.notes),
    lines,
  };
}

/** What Create converts: lines tied to a PO line with a quantity, one pick per
 *  PO line (two rows of the same line add up). */
export function picksOf(review: GrnReview): Array<{ poItemId: string; qty: number }> {
  const byLine = new Map<string, number>();
  for (const l of review.lines) if (l.poItemId && l.qty > 0) byLine.set(l.poItemId, (byLine.get(l.poItemId) ?? 0) + l.qty);
  return [...byLine].map(([poItemId, qty]) => ({ poItemId, qty }));
}

/** Why a document cannot be created yet, in plain words, or null when it can. */
export function blockedReason(review: GrnReview, open: ReadonlyMap<string, OpenPoLine>): string | null {
  const picks = picksOf(review);
  if (picks.length === 0) return 'No line is tied to a PO line yet.';
  for (const p of picks) {
    const line = open.get(p.poItemId);
    if (!line) return 'A line points to a PO line that is no longer open.';
    if (p.qty > line.remaining) return `${line.itemCode} on ${line.poNumber}: ${p.qty} is more than the ${line.remaining} still owed.`;
  }
  return null;
}

/** "Already received" — a goods receipt of this supplier already carries this
 *  delivery order number. The operator still chooses: create anyway, or delete. */
export function duplicateOf(review: GrnReview, existing: ReadonlyArray<{ grnNumber: string; supplierId: string | null; deliveryNoteRef: string | null }>): string | null {
  const ref = review.doNo?.replace(/\s+/g, '').toUpperCase();
  if (!ref) return null;
  const hit = existing.find((g) => g.deliveryNoteRef?.replace(/\s+/g, '').toUpperCase() === ref && (!review.supplierId || !g.supplierId || g.supplierId === review.supplierId));
  return hit?.grnNumber ?? null;
}
