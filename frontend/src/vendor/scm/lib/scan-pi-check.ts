// ----------------------------------------------------------------------------
// Scan, check, then create for supplier invoices — the client side of
// /scan-pi/check (owner 2026-11-04). Types mirror the backend's
// lib/pi-scan-check.ts.
// ----------------------------------------------------------------------------
import { authedFetch } from './authed-fetch';
import type { SearchableSelectOption } from '../components/SearchableSelect';
import type { CheckSupplier, SkuOption } from './scan-gr-check';

export type PiReviewLine = {
  key: string;
  grnItemId: string | null;
  grnNumber: string | null;
  qty: number;
  suggested: boolean;
  // Tied by the AI: the row says "AI match, please check". Older copies carry no flag.
  ai?: boolean;
  read: { itemCode: string | null; description: string | null; qty: number; unitPrice: number | null; lineTotal: number | null } | null;
};
export type PiReview = {
  v: number;
  supplierId: string | null;
  supplierRead: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  doNo: string | null;
  poNo: string | null;
  notes: string | null;
  taxNote: string | null;
  // Copies read before 2026-11-10 carry no tier.
  lineTier?: 'invoice_po' | 'whole_receipt' | null;
  lines: PiReviewLine[];
};

/* Mirrors the backend's pi-scan-match docRefsOf: "EX-HC-PO-2609-151" (HOOKKA
   INV-2610-097) is an exchange, a replacement for HC-PO-2609-151. */
const EXCHANGE_MARK = /^(?:EXCH|EX)(?:\s*-\s*|\s+)(?=[A-Z0-9])/i;

/** The PO refs printed, without an exchange mark, and those the invoice marks as exchange. */
export function poRefs(poNo: string | null): { refs: string[]; exchange: string[] } {
  const printed = (poNo ?? '').split(/[,;&\n]|\s+and\s+/i).map((s) => s.trim()).filter(Boolean);
  const bare = (s: string) => s.replace(EXCHANGE_MARK, '').trim();
  return { refs: printed.map(bare).filter(Boolean), exchange: printed.filter((s) => EXCHANGE_MARK.test(s)).map(bare).filter(Boolean) };
}

/** Which receipt lines the scan matched against, for the operator: the PO
 *  printed on the invoice, or every unbilled line of the receipt when none of
 *  that PO's lines matched, and what an exchange mark on the PO means. null when
 *  there is nothing to say. */
export function lineTierNote(review: Pick<PiReview, 'lineTier' | 'poNo'>): string | null {
  const { refs, exchange } = poRefs(review.poNo);
  const named = refs.length > 0 ? refs.join(', ') : review.poNo;
  const said = review.lineTier === 'invoice_po' ? `Matched to the lines of ${named} printed on the invoice.`
    : review.lineTier === 'whole_receipt' ? `No line of ${named} printed on the invoice matched, so the scan matched against every unbilled line of the receipt. Check which PO each line bills.`
    : null;
  const ex = exchange.length > 0 ? `The invoice marks ${exchange.join(', ')} as exchange (EX): replacement goods for those orders.` : null;
  return [said, ex].filter(Boolean).join(' ') || null;
}

/** A row printed at RM 0: a replacement or a free gift, nothing to bill. */
export function isFreeRow(read: PiReviewLine['read']): boolean {
  return read != null && (read.unitPrice === 0 || (read.unitPrice == null && read.lineTotal === 0));
}
export const FREE_ROW_NOTE = 'Free on the invoice (RM 0): a replacement / exchange, nothing to bill — tie it only if it really bills a receipt line.';
export type PiCheckDoc = {
  id: string;
  batchId: string | null;
  fileName: string | null;
  pages: [number, number] | null;
  state: 'reading' | 'pending' | 'failed';
  note: string | null;
  review: PiReview | null;
  createdAt: string;
  hasFile: boolean;
  canGold: boolean;
  gold: boolean;
  duplicateOf: { id: string; invoiceNumber: string; status: string; invoiceDate: string | null } | null;
  repeatOf: string | null;
  blocked: string | null;
};
export type BillLine = { grnItemId: string; grnNumber: string; supplierId: string | null; poNumber: string | null; itemCode: string; supplierSku: string | null; description: string | null; remaining: number; unitPriceSen: number };
export type PiPending = { documents: PiCheckDoc[]; suppliers: CheckSupplier[]; billLines: BillLine[] };
export type PiCreateResult = { id: string; ok: boolean; docNumbers?: string[]; reason?: string };

export const PI_PENDING_KEY = ['scan-pi-check', 'pending'] as const;
const json = { 'content-type': 'application/json' };

export const fetchPiPending = () => authedFetch<{ data: PiPending }>('/scan-pi/check/pending').then((r) => r.data);
export const uploadPiScans = (files: File[]) => {
  const fd = new FormData();
  for (const f of files) fd.append('file', f);
  return authedFetch('/scan-pi/check/upload', { method: 'POST', body: fd });
};
export const savePiReview = (id: string, review: PiReview) => authedFetch(`/scan-pi/check/${id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ review }) });
export const createPiFromScans = (ids: string[]) =>
  authedFetch<{ data: { results: PiCreateResult[] } }>('/scan-pi/check/create', { method: 'POST', headers: json, body: JSON.stringify({ ids }) }).then((r) => r.data.results);
export const discardPiScans = (ids: string[]) => authedFetch('/scan-pi/check/discard', { method: 'POST', headers: json, body: JSON.stringify({ ids }) });
export const retryPiScan = (id: string) => authedFetch(`/scan-pi/check/${id}/retry`, { method: 'POST' });
export const markPiGold = (id: string) => authedFetch(`/scan-pi/check/${id}/gold`, { method: 'POST' });

/** Why an invoice cannot be created, judged on the operator's latest edit. */
export function piBlock(review: PiReview, lines: ReadonlyMap<string, BillLine>): string | null {
  const byLine = new Map<string, number>();
  for (const l of review.lines) if (l.grnItemId && l.qty > 0) byLine.set(l.grnItemId, (byLine.get(l.grnItemId) ?? 0) + l.qty);
  if (byLine.size === 0) return 'Choose the SKU for at least one row.';
  for (const [id, qty] of byLine) {
    const bl = lines.get(id);
    if (!bl) return 'A row points to a Goods Receipt line that is no longer open to bill.';
    if (qty > bl.remaining) return `${bl.itemCode} on ${bl.grnNumber}: ${qty} is more than the ${bl.remaining} left to bill.`;
  }
  return null;
}

/** The GRN dropdown of a row: each receipt of the supplier with something to bill. */
export function grnOptions(lines: ReadonlyArray<BillLine>): SearchableSelectOption[] {
  const seen = new Map<string, string | null>();
  for (const l of lines) seen.set(l.grnNumber, l.poNumber);
  return [...seen].map(([grn, po]) => ({ value: grn, label: grn, search: `${grn} ${po ?? ''}` }));
}

/** The SKU dropdown of a row: what is left to bill on the chosen receipt, else on all of the supplier's. */
export function billSkuOptions(lines: ReadonlyArray<BillLine>, grnNumber: string | null): SkuOption[] {
  const on = grnNumber ? lines.filter((l) => l.grnNumber === grnNumber) : lines;
  return on.map((l) => ({
    value: l.grnItemId,
    label: l.supplierSku || l.itemCode,
    detail: [l.supplierSku ? l.itemCode : null, grnNumber ? null : l.grnNumber, `left ${l.remaining}`].filter(Boolean).join(' · '),
    group: grnNumber ? `Left to bill on ${grnNumber}` : 'Left to bill',
    search: `${l.supplierSku ?? ''} ${l.itemCode} ${l.description ?? ''} ${l.grnNumber} ${l.poNumber ?? ''}`,
  }));
}

/** The supplier's price differs from ours: the draft bills the supplier's, so the
 *  operator must see the gap. */
export function priceDiffers(printed: number | null | undefined, unitPriceSen: number): boolean {
  return printed != null && Math.abs(Math.round(printed * 100) - unitPriceSen) >= 1;
}

/** The amounts to tie off. `invoiceSen` is what the invoice charges for every
 *  row it printed. `oursSen` is the rows tied to a receipt line at our price, and
 *  `matchedInvoiceSen` what the invoice charges for those same rows, so the two
 *  compare like for like while some rows are still untied (`unmatched`). A row
 *  printed at RM 0 bills nothing: it counts on neither side and is not "not matched". */
export function piAmounts(review: PiReview, lines: ReadonlyMap<string, BillLine>): { invoiceSen: number | null; oursSen: number | null; matchedInvoiceSen: number | null; unmatched: number } {
  const printedOf = (l: PiReviewLine): number | null => {
    const r = l.read;
    if (r?.lineTotal != null) return Math.round(r.lineTotal * 100);
    return r?.unitPrice != null ? Math.round(r.unitPrice * 100 * l.qty) : null;
  };
  const sum = (vs: Array<number | null>): number | null => {
    /* A row printed with no price is a free gift (Diglant's GWP pillow): it adds nothing,
       it does not leave the invoice without an amount. */
    const priced = vs.filter((v): v is number => v != null);
    return priced.length > 0 ? priced.reduce((a, v) => a + v, 0) : null;
  };
  const invoiceSen = sum(review.lines.filter((l) => l.read).map(printedOf));
  const billing = review.lines.filter((l) => !isFreeRow(l.read));
  const tied = billing.filter((l) => l.grnItemId && lines.get(l.grnItemId));
  const oursSen = tied.length > 0 ? tied.reduce((a, l) => a + Math.round((lines.get(l.grnItemId as string) as BillLine).unitPriceSen * l.qty), 0) : null;
  const matchedInvoiceSen = sum(tied.filter((l) => l.read).map(printedOf));
  return { invoiceSen, oursSen, matchedInvoiceSen, unmatched: billing.length - tied.length };
}

/** The receipt side differs from what the invoice charges for the same rows. */
export const piAmountsDiffer = (a: { oursSen: number | null; matchedInvoiceSen: number | null }): boolean =>
  a.oursSen != null && a.matchedInvoiceSen != null && a.oursSen !== a.matchedInvoiceSen;

/** Pieces on the paper and on the GRN lines chosen, for the card's total row. */
export function piQtyTotals(review: PiReview, lines: ReadonlyMap<string, BillLine>): { qty: number; left: number } {
  let qty = 0; let left = 0;
  for (const l of review.lines) {
    qty += l.qty;
    const line = l.grnItemId ? lines.get(l.grnItemId) : undefined;
    if (line) left += line.remaining;
  }
  return { qty, left };
}

let seq = 0;
export const newPiLineKey = () => `m${Date.now().toString(36)}${(seq++).toString(36)}`;
