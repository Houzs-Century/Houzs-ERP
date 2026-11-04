// ----------------------------------------------------------------------------
// Scan, check, then create — the client side of /scan-gr/check (owner
// 2026-11-03, after Hookka's scan modal). Types mirror the backend's
// lib/grn-scan-check.ts; every call goes through authedFetch.
// ----------------------------------------------------------------------------
import { authedFetch } from './authed-fetch';
import type { SearchableSelectOption } from '../components/SearchableSelect';

export type ReviewLine = {
  key: string;
  poItemId: string | null;
  poNumber: string | null;
  gift: { itemCode: string; name: string } | null;
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
  canGold: boolean;
  gold: boolean;
  duplicateOf: { id: string; grnNumber: string; status: string; receivedAt: string | null } | null;
  repeatOf: string | null;
  blocked: string | null;
};
export type CheckPoLine = { poItemId: string; poNumber: string; supplierId: string | null; itemCode: string; name: string | null; remaining: number; warehouse: string | null };
export type CheckSupplier = { id: string; code: string | null; name: string | null };
export type PendingResp = { success: boolean; data: { documents: CheckDoc[]; suppliers: CheckSupplier[]; poLines: CheckPoLine[] } };
export type CreateResult = { id: string; ok: boolean; grnNumbers?: string[]; reason?: string; giftNote?: string | null };
export type SupplierSku = { code: string; name: string | null };

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
export const fetchSupplierSkus = (supplierId: string) =>
  authedFetch<{ data: { skus: SupplierSku[] } }>(`/scan-gr/check/supplier-skus?supplierId=${encodeURIComponent(supplierId)}`).then((r) => r.data.skus);
export const markGold = (id: string) => authedFetch(`/scan-gr/check/${id}/gold`, { method: 'POST' });
export const retryScan = (id: string) => authedFetch(`/scan-gr/check/${id}/retry`, { method: 'POST' });
export const discardScans = (ids: string[]) =>
  authedFetch('/scan-gr/check/discard', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }) });

/** Why a document cannot be created right now, judged on the operator's latest
 *  edit (the server's `blocked` is on the last saved copy). */
export function localBlock(review: GrnReview, lines: ReadonlyMap<string, CheckPoLine>): string | null {
  const byLine = new Map<string, number>();
  for (const l of review.lines) if (l.poItemId && l.qty > 0) byLine.set(l.poItemId, (byLine.get(l.poItemId) ?? 0) + l.qty);
  if (byLine.size === 0) return 'Choose the SKU for at least one row.';
  for (const [id, qty] of byLine) {
    const pl = lines.get(id);
    if (!pl) return 'A row points to a PO line that is no longer open.';
    if (qty > pl.remaining) return `${pl.itemCode} on ${pl.poNumber}: ${qty} is more than the ${pl.remaining} still owed.`;
  }
  return null;
}

/** The PO dropdown of a row: each open PO of the supplier, with what is left on it. */
export function poOptions(lines: ReadonlyArray<CheckPoLine>): SearchableSelectOption[] {
  const count = new Map<string, number>();
  for (const l of lines) count.set(l.poNumber, (count.get(l.poNumber) ?? 0) + 1);
  return [...count].map(([po, n]) => ({ value: po, label: po, search: `${po} ${n}` }));
}

export const skuValue = (l: ReviewLine): string => (l.gift ? `gift:${l.gift.itemCode}` : l.poItemId ? `line:${l.poItemId}` : '');

/** The SKU dropdown of a row. With a PO chosen: what is still owed on that PO.
 *  Without: everything owed on the supplier's POs, then its other SKUs, which
 *  are on no open PO and so can only be free gifts at RM0. */
export function skuOptions(lines: ReadonlyArray<CheckPoLine>, skus: ReadonlyArray<SupplierSku>, poNumber: string | null, row: ReviewLine): SearchableSelectOption[] {
  const onPo = poNumber ? lines.filter((l) => l.poNumber === poNumber) : lines;
  const out: SearchableSelectOption[] = onPo.map((l) => ({
    value: `line:${l.poItemId}`,
    label: poNumber ? `${l.itemCode} · owed ${l.remaining}` : `${l.itemCode} · ${l.poNumber} · owed ${l.remaining}`,
    group: poNumber ? `Still owed on ${poNumber}` : 'Still owed on open POs',
    search: `${l.itemCode} ${l.name ?? ''} ${l.poNumber}`,
  }));
  if (!poNumber) {
    const owed = new Set(lines.map((l) => l.itemCode));
    for (const s of skus) {
      if (!owed.has(s.code)) out.push({ value: `gift:${s.code}`, label: s.name ? `${s.code} · ${s.name}` : s.code, group: 'Other SKUs of this supplier · free gift · RM0', search: `${s.code} ${s.name ?? ''}` });
    }
  }
  // A saved pick still shows while the supplier's SKUs load.
  if (row.gift && !out.some((o) => o.value === `gift:${row.gift?.itemCode}`)) out.push({ value: `gift:${row.gift.itemCode}`, label: `${row.gift.itemCode} · ${row.gift.name}`, group: 'Free gift · RM0' });
  return out;
}

/** A date this far from today is more likely a misread than a real delivery. */
export function isOddDate(date: string | null, today: string): boolean {
  if (!date) return false;
  return Math.abs(Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) > 45 * 86_400_000;
}

let seq = 0;
export const newLineKey = () => `n${Date.now().toString(36)}${(seq++).toString(36)}`;
