/* The Receipts & Payments report (owner 2026-09-06/07) — one read, the
   AutoCount shape: a column per cash/bank account plus Total, receipts above
   payments, opening and closing per column, rows in the owner's own accounts
   (a supplier payment read through what it settled — rule A — unless the
   report is asked by party). The numbers come from
   GET /accounting/reports/receipts-payments; see accounting.md. */

import { useQuery } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { retryUnlessClientError } from '../../../lib/retryPolicy';
import { flattenLaid, leafKeys, type LaidNode } from './report-layout';

export type RpColumn = { code: string; name: string };
export type RpRow = { key: string; code: string | null; name: string; cells: Record<string, number>; totalSen: number };
export type RpEntry = {
  jeNo: string; entryDate: string; sourceType: string | null; sourceDocNo: string | null;
  narration: string | null; party: string | null; side: 'R' | 'P'; rowKey: string; column: string; sen: number;
};
export type RpReport = {
  from: string; to: string; byParty: boolean;
  columns: RpColumn[];
  opening: Record<string, number>;
  receipts: RpRow[];
  payments: RpRow[];
  totals: {
    receipts: Record<string, number>; payments: Record<string, number>; closing: Record<string, number>;
    openingTotalSen: number; receiptsTotalSen: number; paymentsTotalSen: number; closingTotalSen: number;
  };
  entries: RpEntry[];
  /** The rows on the Cash Flow tree (docs/bugs/0912; directed since
      2026-09-18): the top level is In/Out categories with their own subtotal
      names, running subtotals, and the unassigned groups last; a figure per
      column on every row and category, % of the side's total. inSen − outSen
      is always receipts − payments. */
  layout: { stored: boolean; tree: LaidNode[]; inSen: number; outSen: number };
  /** The card money the bank has not received (owner 2026-09-28): what was swiped on
      the card-machine clearing accounts in the period (the settlement module's own
      movements aside) and what those accounts still hold at the period's end. Since
      2026-11-05 the swipes are in the Card column and Balance c/f says the same. */
  card: { takingsSen: number; transitSen: number; codes: string[] };
  /** Customers' money AutoCount recorded after the books started, which no journal carries
      (owner 2026-11-08): printed under the customer receipts, in no total. */
  autoCount?: { sen: number; count: number; entries: RpEntry[] };
};

/** The card-machine clearing accounts as one money column (owner 2026-11-05): a swipe is
    Cash In on its own day, into this column; the payout is a transfer to the bank. */
export const CARD_COLUMN = 'CARD';
export type BalancePart = { id: string; label: string; per: Record<string, number>; sen: number };
/** A balance line's two parts, the banks and the card money not yet in the bank, when the
    report has the Card column; none otherwise. */
export function balanceParts(r: { columns: RpColumn[] }, id: string, per: Record<string, number>, total: number): BalancePart[] {
  if (!r.columns.some((c) => c.code === CARD_COLUMN)) return [];
  const card = per[CARD_COLUMN] ?? 0;
  const bankPer = Object.fromEntries(Object.entries(per).filter(([k]) => k !== CARD_COLUMN));
  return [
    { id: `${id}:bank`, label: 'Bank', per: bankPer, sen: total - card },
    { id: `${id}:card`, label: 'Card money not yet in the bank', per: { [CARD_COLUMN]: card }, sen: card },
  ];
}

export const rpReportPath = (from: string, to: string, accounts: readonly string[], byParty: boolean): string =>
  `/accounting/reports/receipts-payments?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
  + (accounts.length > 0 ? `&accounts=${encodeURIComponent(accounts.join(','))}` : '')
  + (byParty ? '&party=1' : '');

export const useRpReport = (from: string, to: string, accounts: readonly string[], byParty: boolean) => useQuery({
  queryKey: ['report-rp', from, to, accounts.join(','), byParty],
  queryFn: () => authedFetch<RpReport>(rpReportPath(from, to, accounts, byParty)),
  enabled: Boolean(from && to),
  staleTime: 30_000,
  retry: retryUnlessClientError,
});

/* ── The AutoCount line (owner 2026-11-08: 可以帮我注明是从auto count带过来的吗？) ── */

export const AUTOCOUNT_LINE_ID = 'memo:autocount';
export const AUTOCOUNT_LINE_LABEL = 'From AutoCount, not in the books';
const CUSTOMER_KEY = /:(DEP|BAL):/;
const isGroup = (n: LaidNode): boolean => n.id.includes(':grp:');

/** Where the AutoCount line prints: right after the customer receipts, at their category's depth,
    so that category's own Total prints above it and nothing reads it as counted. The category is
    the deepest one holding every Deposit and Balance row (never the Deposit or Balance heading);
    with none, after the last customer row; with no customer row, last in the first money-in block. */
export function autoCountPlace(tree: LaidNode[]): { blockId: string; after: string | null; depth: number } | null {
  let firstIn: string | null = null;
  for (const top of tree) {
    if (top.kind === 'subtotal' || top.flow !== 'in') continue;
    firstIn ??= top.id;
    const flat = flattenLaid(top.children);
    const keys = flat.flatMap(({ node }) => (node.kind === 'account' && node.key && CUSTOMER_KEY.test(node.key) ? [node.key] : []));
    if (keys.length === 0) continue;
    let start = -1;
    flat.forEach(({ node }, i) => {
      if (node.kind !== 'account' && !isGroup(node) && keys.every((k) => leafKeys(node).includes(k))) start = i;
    });
    if (start < 0) start = flat.reduce((last, { node }, i) => (node.kind === 'account' && node.key && CUSTOMER_KEY.test(node.key) ? i : last), -1);
    let end = start;
    while (end + 1 < flat.length && flat[end + 1]!.depth > flat[start]!.depth) end += 1;
    return { blockId: top.id, after: flat[end]!.node.id, depth: flat[start]!.depth };
  }
  return firstIn ? { blockId: firstIn, after: null, depth: 1 } : null;
}

/** The lines with the AutoCount line in its place; unchanged when the period has none. */
export function withAutoCountLine<L extends { id: string }>(r: { autoCount?: RpReport['autoCount']; layout: { tree: LaidNode[] } }, lines: L[], make: (depth: number, sen: number) => L): L[] {
  const sen = r.autoCount?.sen ?? 0;
  if (!r.autoCount || r.autoCount.count === 0) return lines;
  const place = autoCountPlace(r.layout.tree);
  if (!place) return lines;
  const at = place.after ? lines.findIndex((l) => l.id === place.after) : lines.findIndex((l) => l.id === `tot:${place.blockId}`) - 1;
  if (at < 0) return lines;
  return [...lines.slice(0, at + 1), make(place.depth, sen), ...lines.slice(at + 1)];
}
