/* Procurement Overview — the arithmetic, kept pure so it is tested apart from
   the reads (routes/procurement-overview.ts).

   Owner, 2026-10-16: replace the "PO CHASING LIST" sheet. Open PO lines, how
   late they are in the sheet's four buckets, by category and by supplier; the
   PO raised and supplier bills (PI) received in a period; and how long each
   category really takes to arrive, so the lead time we order with can follow
   what suppliers actually do. */

/** The categories the overview groups by, in the sheet's order. */
export const PROCUREMENT_CATEGORIES = ['MATTRESS', 'BEDFRAME', 'SOFA', 'ACCESSORY', 'DINING', 'OTHERS'] as const;
export type ProcurementCategory = (typeof PROCUREMENT_CATEGORIES)[number];

/** How a category reads on a page. */
export const PROCUREMENT_CATEGORY_LABEL: Record<ProcurementCategory, string> = { MATTRESS: 'Mattress', BEDFRAME: 'Bedframe', SOFA: 'Sofa', ACCESSORY: 'Accessories', DINING: 'Dining', OTHERS: 'Others' };

/** The product master's category (mfg_products.category) first, then the line's
 *  free-text item_group ("ACC", "Mattress", "BED FRAME"…). */
export function procurementCategory(productCategory: string | null | undefined, itemGroup: string | null | undefined): ProcurementCategory {
  const raw = `${productCategory ?? ''}|${itemGroup ?? ''}`.toUpperCase().replace(/\s+/g, '');
  const first = (productCategory ?? '').toUpperCase();
  const pick = (s: string): ProcurementCategory | null => {
    if (s.includes('MATTRESS') || s.startsWith('MAT')) return 'MATTRESS';
    if (s.includes('BEDFRAME') || s.includes('BED_FRAME')) return 'BEDFRAME';
    if (s.includes('SOFA')) return 'SOFA';
    if (s.includes('DINING')) return 'DINING';
    if (s.includes('ACCESSOR') || s.startsWith('ACC') || s.includes('BEDLINE') || s.includes('DIFFUSER') || s.includes('CARPET') || s.includes('PILLOW')) return 'ACCESSORY';
    return null;
  };
  return pick(first) ?? pick(raw.split('|')[1] ?? '') ?? pick(raw) ?? 'OTHERS';
}

/** The four buckets of the PO chasing sheet, by days late (today − promised date).
 *  Positive = already late. */
export type OverdueBucket = 'late5' | 'late0to4' | 'due2to7' | 'due8plus';
export const OVERDUE_BUCKETS: readonly OverdueBucket[] = ['late5', 'late0to4', 'due2to7', 'due8plus'];
export function overdueBucket(daysLate: number): OverdueBucket {
  if (daysLate >= 5) return 'late5';
  if (daysLate >= -1) return 'late0to4';
  if (daysLate >= -7) return 'due2to7';
  return 'due8plus';
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso.slice(0, 10)}T00:00:00Z`) - Date.parse(`${fromIso.slice(0, 10)}T00:00:00Z`)) / 86400000);
}

/** The date the supplier currently promises: the latest revised date, else the
 *  line's delivery date, else the PO's expected date. Chasing works off this. */
export function promisedDate(dates: Array<string | null | undefined>): string | null {
  const valid = dates.filter((d): d is string => !!d && /^\d{4}-\d{2}-\d{2}/.test(d)).map((d) => d.slice(0, 10)).sort();
  return valid.length ? valid[valid.length - 1]! : null;
}

/** The value below which `share` of the sample falls (nearest rank). */
export function percentile(values: number[], share: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(share * s.length) - 1));
  return s[idx]!;
}

export type OpenLine = {
  poId: string; poNumber: string; supplier: string; category: ProcurementCategory;
  itemCode: string | null; itemDesc: string | null; location: string | null; soDocNo: string | null;
  poDate: string | null; remainingQty: number; unitPriceSen: number;
  originalDue: string | null; promised: string | null; revised: string[];
};

export type BucketRow = { key: string; lines: number; remainingQty: number; remainingSen: number; buckets: Record<OverdueBucket, number> };

/** basis: 'promised' = the date the supplier now promises (chasing); 'original' = the date first put on the PO line (the sheet's Overdue Days). */
export function overdueMatrix(lines: OpenLine[], today: string, by: 'category' | 'supplier', basis: 'promised' | 'original'): BucketRow[] {
  const m = new Map<string, BucketRow>();
  for (const l of lines) {
    const key = by === 'category' ? l.category : l.supplier;
    const row = m.get(key) ?? { key, lines: 0, remainingQty: 0, remainingSen: 0, buckets: { late5: 0, late0to4: 0, due2to7: 0, due8plus: 0 } };
    row.lines += 1;
    row.remainingQty += l.remainingQty;
    row.remainingSen += l.remainingQty * l.unitPriceSen;
    const due = basis === 'promised' ? l.promised : l.originalDue;
    if (due) row.buckets[overdueBucket(daysBetween(due, today))] += 1;
    m.set(key, row);
  }
  const rows = [...m.values()];
  if (by === 'category') return rows.sort((a, b) => PROCUREMENT_CATEGORIES.indexOf(a.key as ProcurementCategory) - PROCUREMENT_CATEGORIES.indexOf(b.key as ProcurementCategory));
  return rows.sort((a, b) => b.lines - a.lines);
}

export type ReceiptLine = { supplier: string; category: ProcurementCategory; poDate: string | null; originalDue: string | null; receivedAt: string; qtyReceived: number; qtyRejected: number };

export type LeadStat = { key: string; receipts: number; avgDays: number | null; p80Days: number | null; onTimePct: number | null; avgDaysLate: number | null; rejectPct: number | null };

/** Lead time = received − PO date. On time = received on or before the date
 *  first promised on the PO line (a supplier that keeps moving its date is not
 *  "on time" by moving it). */
export function leadStats(receipts: ReceiptLine[], by: 'category' | 'supplier'): LeadStat[] {
  const groups = new Map<string, ReceiptLine[]>();
  for (const r of receipts) {
    const key = by === 'category' ? r.category : r.supplier;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const out: LeadStat[] = [];
  for (const [key, rs] of groups) {
    const leads = rs.filter((r) => r.poDate).map((r) => daysBetween(r.poDate as string, r.receivedAt));
    const withDue = rs.filter((r) => r.originalDue);
    const lates = withDue.map((r) => daysBetween(r.originalDue as string, r.receivedAt));
    const received = rs.reduce((a, r) => a + r.qtyReceived, 0);
    const rejected = rs.reduce((a, r) => a + r.qtyRejected, 0);
    out.push({
      key,
      receipts: rs.length,
      avgDays: leads.length ? Math.round(leads.reduce((a, b) => a + b, 0) / leads.length) : null,
      p80Days: percentile(leads, 0.8),
      onTimePct: lates.length ? Math.round((lates.filter((d) => d <= 0).length / lates.length) * 100) : null,
      avgDaysLate: lates.length ? Math.round((lates.reduce((a, d) => a + Math.max(0, d), 0) / lates.length) * 10) / 10 : null,
      rejectPct: received > 0 ? Math.round((rejected / received) * 1000) / 10 : null,
    });
  }
  if (by === 'category') return out.sort((a, b) => PROCUREMENT_CATEGORIES.indexOf(a.key as ProcurementCategory) - PROCUREMENT_CATEGORIES.indexOf(b.key as ProcurementCategory));
  return out.sort((a, b) => b.receipts - a.receipts);
}

/** Suggested ordering lead time: the 80th-percentile wait, once there are
 *  enough receipts to trust it (fewer than 10 keeps the current setting). */
export function suggestedLeadDays(stat: LeadStat, current: number | null): { suggested: number | null; verdict: 'too_short' | 'ok' | 'can_shorten' | 'not_enough_data' } {
  if (stat.receipts < 10 || stat.p80Days == null) return { suggested: current, verdict: 'not_enough_data' };
  const s = stat.p80Days;
  if (current == null) return { suggested: s, verdict: 'too_short' };
  if (s > current + 2) return { suggested: s, verdict: 'too_short' };
  if (s < current - 3) return { suggested: s, verdict: 'can_shorten' };
  return { suggested: current, verdict: 'ok' };
}
