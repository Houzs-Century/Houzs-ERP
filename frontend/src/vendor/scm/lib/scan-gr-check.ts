// ----------------------------------------------------------------------------
// Scan, check, then create — the client side of /scan-gr/check (owner
// 2026-11-03, after Hookka's scan modal). Types mirror the backend's
// lib/grn-scan-check.ts; every call goes through authedFetch.
// ----------------------------------------------------------------------------
import { authedFetch } from './authed-fetch';

export type ReviewLine = {
  key: string;
  poItemId: string | null;
  qty: number;
  read: { itemCode: string | null; description: string | null; qty: number; poNo: string | null } | null;
};
export type GrnReview = {
  supplierId: string | null;
  supplierRead: string | null;
  doNo: string | null;
  deliveryDate: string | null;
  notes: string | null;
  lines: ReviewLine[];
};
export type CheckDoc = {
  id: string;
  batchId: string | null;
  fileName: string | null;
  pages: [number, number] | null;
  state: 'reading' | 'pending' | 'failed';
  note: string | null;
  review: GrnReview | null;
  createdAt: string;
  hasFile: boolean;
  duplicateOf: string | null;
  blocked: string | null;
};
export type CheckPoLine = { poItemId: string; poNumber: string; supplierId: string | null; itemCode: string; name: string | null; remaining: number; warehouse: string | null };
export type CheckSupplier = { id: string; code: string | null; name: string | null };
export type PendingResp = { success: boolean; data: { documents: CheckDoc[]; suppliers: CheckSupplier[]; poLines: CheckPoLine[] } };
export type CreateResult = { id: string; ok: boolean; grnNumbers?: string[]; reason?: string };

export const PENDING_KEY = ['scan-gr-check', 'pending'] as const;

export const fetchPending = () => authedFetch<PendingResp>('/scan-gr/check/pending');
export const fetchPoLines = (supplierId: string) =>
  authedFetch<{ data: { poLines: CheckPoLine[] } }>(`/scan-gr/check/po-lines?supplierId=${encodeURIComponent(supplierId)}`).then((r) => r.data.poLines);
export const uploadScans = (files: File[]) => {
  const fd = new FormData();
  for (const f of files) fd.append('file', f);
  return authedFetch<{ data: { batchId: string; documents: number } }>('/scan-gr/check/upload', { method: 'POST', body: fd });
};
export const saveReview = (id: string, review: GrnReview) =>
  authedFetch(`/scan-gr/check/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ review }) });
export const createFromScans = (ids: string[]) =>
  authedFetch<{ data: { results: CreateResult[] } }>('/scan-gr/check/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }) }).then((r) => r.data.results);
export const discardScans = (ids: string[]) =>
  authedFetch('/scan-gr/check/discard', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }) });

/** Why a document cannot be created right now, judged on the operator's latest
 *  edit (the server's `blocked` is on the last saved copy). */
export function localBlock(review: GrnReview, lines: ReadonlyMap<string, CheckPoLine>): string | null {
  const byLine = new Map<string, number>();
  for (const l of review.lines) if (l.poItemId && l.qty > 0) byLine.set(l.poItemId, (byLine.get(l.poItemId) ?? 0) + l.qty);
  if (byLine.size === 0) return 'Choose the PO line for at least one row.';
  for (const [id, qty] of byLine) {
    const pl = lines.get(id);
    if (!pl) return 'A row points to a PO line that is no longer open.';
    if (qty > pl.remaining) return `${pl.itemCode} on ${pl.poNumber}: ${qty} is more than the ${pl.remaining} still owed.`;
  }
  return null;
}

let seq = 0;
export const newLineKey = () => `n${Date.now().toString(36)}${(seq++).toString(36)}`;
