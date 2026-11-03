// ----------------------------------------------------------------------------
// acc/balances-as-of — the Trial balance as at a day (the owner's Claude
// Design, batch 6 read c1). The all-time balances (scm.v_account_balances:
// every line the books count — posted, on neither side of a reversal pair,
// inside the company's books) less the lines the books count that are dated
// AFTER the day, per account. The same lines, the same rule, cut at a day;
// reads only.
//
// Subtracting the later lines instead of summing the earlier ones keeps the
// read small: the view adds the ledger up in the database, and the lines after
// a day are few (none, for today).
// ----------------------------------------------------------------------------

import { isReversalPair, type PairFlags } from './reversal-pairs';

export type AccountBalanceRow = {
  account_code: string;
  account_name: string | null;
  account_type: string;
  total_debit_sen: number;
  total_credit_sen: number;
  balance_sen: number;
  company_id?: number | null;
};

/** A line of scm.v_gl_entries dated after the day. */
export type LaterLine = PairFlags & { account_code: string; debit_sen: number | null; credit_sen: number | null };

/** The view's own sign: an asset or an expense reads debit less credit, the rest credit less debit. */
const DEBIT_SIDE = new Set(['ASSET', 'EXPENSE']);

export function balancesAsOf(allTime: readonly AccountBalanceRow[], later: readonly LaterLine[]): AccountBalanceRow[] {
  const after = new Map<string, { dr: number; cr: number }>();
  for (const l of later) {
    if (isReversalPair(l)) continue;
    const m = after.get(l.account_code) ?? { dr: 0, cr: 0 };
    m.dr += Number(l.debit_sen ?? 0);
    m.cr += Number(l.credit_sen ?? 0);
    after.set(l.account_code, m);
  }
  return allTime.map((b) => {
    const m = after.get(b.account_code);
    if (!m) return b;
    const dr = Number(b.total_debit_sen) - m.dr;
    const cr = Number(b.total_credit_sen) - m.cr;
    return { ...b, total_debit_sen: dr, total_credit_sen: cr, balance_sen: DEBIT_SIDE.has(b.account_type) ? dr - cr : cr - dr };
  });
}
