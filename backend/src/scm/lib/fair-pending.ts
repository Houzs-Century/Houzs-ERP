// ----------------------------------------------------------------------------
// fair-pending — the orders the "Fair Links to Settle" page lists: every order
// with no fair (project) link that a person should look at.
//
// Owner 2026-10-19 (「总之没有 assign 到 fair 的就列出来就对了」, then 「先做 Fair
// links to settle 菜单」): the page used to show only the three verdicts the
// nightly reconcile cannot settle (PENDING / AMBIGUOUS / UNMATCHED). It now also
// lists
//   - NO_FAIR — a salesperson ticked "No fair"; a person checks that it really
//     was not a fair sale;
//   - no verdict at all (fair_match NULL) on an order dated from 1 September
//     2026, the day Houzs opened its books in the ERP: orders keyed before the
//     fair picker went live (13/09) and the AutoCount imports of 1–7/09, never
//     linked. Older NULL orders (the AutoCount years) stay out — they would
//     bury the ones that matter under years of history.
// A cancelled order is not a sale and is never listed; an order that HAS a link
// is never listed either, whatever its verdict column says; nor is one a person
// PUT ASIDE (owner 2026-10-21, fair-put-aside.ts) until it is brought back.
//
// The sidebar badge counts exactly this list (countFairPending), so the number
// on the menu and the rows on the page cannot disagree.
// ----------------------------------------------------------------------------

/** What the page shows. Every value is already on the order — nothing is joined
 *  or computed, so the page cannot disagree with the order list. `ref` and
 *  `customer_so_no` are the order's Ref No. — the slip number the evening
 *  sales report lists (owner 2026-10-21: 「我这里也需要这个reference」). */
export const FAIR_PENDING_COLUMNS =
  'doc_no, so_date, venue, branding, project_id, fair_match, status, local_total_sen, salesperson_id, ref, customer_so_no';

/** Verdicts listed whatever the order's date. */
export const LISTED_VERDICTS = ['PENDING', 'AMBIGUOUS', 'UNMATCHED', 'NO_FAIR'] as const;

/** An order with NO verdict is listed only from this day (YYYY-MM-DD, MYT):
 *  Houzs opened its books in the ERP on 1 September 2026. */
export const NO_VERDICT_LISTED_FROM = '2026-09-01';

/** The caller's company predicate — `(q) => scopeToCompany(q, c)` in a route. */
export type FairPendingScope = <Q>(query: Q) => Q;

export type FairPendingRow = {
  doc_no: string;
  so_date: string | null;
  venue: string | null;
  branding: string | null;
  project_id: number | null;
  fair_match: string | null;
  status: string | null;
  local_total_sen: number | null;
  salesperson_id: string | null;
  /** The Ref No., `ref` first (frontend lib/customer-ref.ts). Optional so a
   *  row built without them still types. */
  ref?: string | null;
  customer_so_no?: string | null;
};

/* TWO READS, ONE LIST. The listed set is "a verdict in LISTED_VERDICTS" OR "no
   verdict and dated from NO_VERDICT_LISTED_FROM". PostgREST can only say that
   OR through its `or=` grammar, which the house fake client does not speak and a
   reader has to decode; two plain reads with the same shared filters say it
   once each, and the merge below is the whole of the OR. */
function withVerdicts(q: any): any {
  return q.in('fair_match', [...LISTED_VERDICTS]).is('project_id', null).neq('status', 'CANCELLED').is('fair_put_aside_at', null);
}
function withoutVerdict(q: any): any {
  return q.is('fair_match', null).is('project_id', null).neq('status', 'CANCELLED').gte('so_date', NO_VERDICT_LISTED_FROM).is('fair_put_aside_at', null);
}

/** Newest first; a day's orders by document number, newest number first. */
function newestFirst(a: FairPendingRow, b: FairPendingRow): number {
  const d = String(b.so_date ?? '').localeCompare(String(a.so_date ?? ''));
  return d !== 0 ? d : String(b.doc_no).localeCompare(String(a.doc_no));
}

/**
 * The page's rows, newest first, at most `limit` of them. A failed read is a
 * failure — never an empty list, which the page would show as "every order is
 * linked".
 */
export async function loadFairPending(
  sb: any,
  scope: FairPendingScope,
  limit: number,
): Promise<{ ok: true; rows: FairPendingRow[] } | { ok: false }> {
  const read = (shape: (q: any) => any) =>
    scope(shape(sb.from('mfg_sales_orders').select(FAIR_PENDING_COLUMNS)).order('so_date', { ascending: false }).limit(limit));
  const [a, b] = await Promise.all([read(withVerdicts), read(withoutVerdict)]);
  if (a.error || b.error) return { ok: false };
  const rows = [...((a.data ?? []) as FairPendingRow[]), ...((b.data ?? []) as FairPendingRow[])];
  rows.sort(newestFirst);
  return { ok: true, rows: rows.slice(0, limit) };
}

/** How many orders the page would list — the sidebar badge. Same filters. */
export async function countFairPending(
  sb: any,
  scope: FairPendingScope,
): Promise<{ ok: true; count: number } | { ok: false }> {
  const count = (shape: (q: any) => any) =>
    scope(shape(sb.from('mfg_sales_orders').select('doc_no', { count: 'exact', head: true })));
  const [a, b] = await Promise.all([count(withVerdicts), count(withoutVerdict)]);
  if (a.error || b.error) return { ok: false };
  return { ok: true, count: Number(a.count ?? 0) + Number(b.count ?? 0) };
}
