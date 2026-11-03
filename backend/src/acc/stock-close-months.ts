// ----------------------------------------------------------------------------
// acc/stock-close-months — the months the stock close has booked, as Books ›
// Stock close lists them (the owner's Claude Design, batch 6 c4): each month's
// ACTIVE closing entry (STOCKADJ-{co}-{YYYY-MM}), its lines summed per bucket
// on the bucket's stock account (acc/rules STOCK_BUCKET_ROLES — customer,
// display, service, showroom, others), whether it was posted once or
// re-posted (an earlier entry for the same month was reversed), the day it
// was booked, and the opening entry beside it (STOCKADJ-REV-…). Reads only.
// ----------------------------------------------------------------------------

import { chunkIn, paginateAll } from '../scm/lib/paginate-all';
import { mytDateOf } from '../scm/lib/my-time';
import { STOCK_BUCKETS, emptyBuckets, type StockBucket } from '../scm/lib/stock-bucket';
import { resolveRoles, STOCK_BUCKET_ROLES } from './rules';

type Row = Record<string, any>;

export type ClosedMonth = {
  month: string;
  buckets: Record<StockBucket, number>;
  totalSen: number;
  action: 'posted' | 'reposted';
  /** The day its active entry was booked (MYT), null when the row carries no time. */
  bookedOn: string | null;
  jeNo: string;
  revJeNo: string | null;
};

/** The month a STOCKADJ document closes, and whether it is the closing or the opening leg. */
export function stockDocMonth(companyId: number, docNo: string): { month: string; leg: 'close' | 'open' } | null {
  const m = new RegExp(`^STOCKADJ-(REV-)?${companyId}-(\\d{4}-\\d{2})$`).exec(docNo);
  return m ? { month: m[2]!, leg: m[1] ? 'open' : 'close' } : null;
}

export async function closedStockMonths(sb: any, companyId: number): Promise<{ ok: true; months: ClosedMonth[] } | { ok: false; reason: string }> {
  const entries = await paginateAll<Row>((lo, hi) => sb.from('journal_entries')
    .select('id, je_no, source_doc_no, reversed, posted, posted_at, created_at')
    .eq('company_id', companyId).eq('source_type', 'STOCKADJ')
    .order('id').range(lo, hi));
  if (entries.error) return { ok: false, reason: `stock entries: ${String((entries.error as { message?: string }).message ?? entries.error)}` };

  type Leg = { active: Row | null; count: number };
  const byMonth = new Map<string, { close: Leg; open: Leg }>();
  for (const e of entries.data ?? []) {
    const at = stockDocMonth(companyId, String(e.source_doc_no ?? ''));
    if (!at) continue;
    const m = byMonth.get(at.month) ?? { close: { active: null, count: 0 }, open: { active: null, count: 0 } };
    const leg = at.leg === 'close' ? m.close : m.open;
    leg.count += 1;
    if (e.reversed !== true && e.posted !== false) leg.active = e;
    byMonth.set(at.month, m);
  }

  const active = [...byMonth.entries()].filter(([, m]) => m.close.active != null);
  const ids = active.map(([, m]) => String(m.close.active!.id));
  const lines = await chunkIn<Row>(ids, (batch, lo, hi) => sb.from('journal_entry_lines')
    .select('journal_entry_id, account_code, debit_sen')
    .eq('company_id', companyId).in('journal_entry_id', batch).order('journal_entry_id').range(lo, hi));
  if (lines.error) return { ok: false, reason: `stock lines: ${lines.error.message}` };

  /* Which bucket a stock account belongs to, by the company's roles. */
  const roles = await resolveRoles(sb, companyId);
  const bucketOf = new Map<string, StockBucket>();
  for (const b of STOCK_BUCKETS) {
    const code = roles[STOCK_BUCKET_ROLES[b].inventory];
    if (code) bucketOf.set(code, b);
  }
  const debitsOf = new Map<string, Row[]>();
  for (const l of lines.data) {
    const k = String(l.journal_entry_id);
    debitsOf.set(k, [...(debitsOf.get(k) ?? []), l]);
  }

  const months = active.map(([month, m]): ClosedMonth => {
    const je = m.close.active!;
    const buckets = emptyBuckets();
    let totalSen = 0;
    for (const l of debitsOf.get(String(je.id)) ?? []) {
      const dr = Number(l.debit_sen ?? 0);
      if (dr <= 0) continue;
      totalSen += dr;
      /* A month still on the one-account shape books on no bucket's account: its whole value reads as customer stock. */
      buckets[bucketOf.get(String(l.account_code)) ?? 'customer'] += dr;
    }
    const at = je.posted_at ?? je.created_at;
    return {
      month, buckets, totalSen,
      action: m.close.count > 1 ? 'reposted' : 'posted',
      bookedOn: at ? mytDateOf(String(at)) : null,
      jeNo: String(je.je_no),
      revJeNo: m.open.active ? String(m.open.active.je_no) : null,
    };
  });
  months.sort((a, b) => b.month.localeCompare(a.month));
  return { ok: true, months };
}
