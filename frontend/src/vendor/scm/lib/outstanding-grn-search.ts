// ----------------------------------------------------------------------------
// Search on the "Bill a Goods-Received Note" picker (PurchaseInvoiceFromGrn).
//
// Owner 2026-09-14: 「需要加上search button」 — the picker listed 494 outstanding
// lines across 197 notes and the only way to find one was to scroll.
//
// A line matches when EVERY word typed appears somewhere in what its card shows:
// note number, supplier name or code, PO number, received date, item code,
// description, Description 2. The note's own fields are carried on each line, so
// typing a note number or a supplier keeps all of that note's lines, while an
// item word keeps only the lines that carry it. Words rather than one phrase so
// "diglant immortal" finds that supplier's IMMORTAL lines.
// ----------------------------------------------------------------------------

import { buildVariantSummary } from '@2990s/shared';
import { fmtDateOrDash } from '../../shared/format';
import type { OutstandingGrnItem } from './suppliers-queries';

export function searchTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

export function outstandingGrnSearchText(it: OutstandingGrnItem): string {
  return [
    it.grnDocNo,
    it.supplierName,
    it.supplierCode,
    it.poDocNo ?? '',
    fmtDateOrDash(it.receivedAt),
    it.itemCode,
    it.description ?? '',
    buildVariantSummary(it.itemGroup, it.variants as Record<string, unknown> | null),
  ].join('\n').toLowerCase();
}

export function filterOutstandingGrnLines<T extends OutstandingGrnItem>(items: T[], query: string): T[] {
  const terms = searchTerms(query);
  if (terms.length === 0) return items;
  return items.filter((it) => {
    const text = outstandingGrnSearchText(it);
    return terms.every((t) => text.includes(t));
  });
}

/* The PO part of one note card's heading. A note can take lines from several
   POs (staff 2026-11-09, HC-GRN-2611-052), so the heading lists every PO its
   lines name rather than the first line's, which read as if the whole note
   came from one PO. */
export function notePoLabel(lines: ReadonlyArray<Pick<OutstandingGrnItem, 'poDocNo'>>): string | null {
  const pos = [...new Set(lines.map((l) => l.poDocNo).filter((p): p is string => !!p))];
  return pos.length === 0 ? null : `PO ${pos.join(', ')}`;
}
