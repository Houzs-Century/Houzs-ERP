// ----------------------------------------------------------------------------
// accounting-reports — the standard statements (GL redesign item 6, owner
// 2026-09-05: 你可以做一个 standard P&L 先…balance sheet 同理; layout will be
// iterated with him later, the NUMBERS ship now).
//
// Both read ONE source — v_gl_entries (posted, not reversed) — so they can
// never disagree with the Journal/GL/TB tabs beside them. The P&L follows the
// owner's AutoCount arithmetic under the periodic scheme:
//
//   Trading income   INCOME accounts OUTSIDE the 700-0000 tree (his rule:
//                    other income 挂 700 下 — the same walker the chart badge
//                    uses, one source of truth)
//   Cost of sales    EXPENSE accounts coded 6xx — purchases by group (601/602),
//                    returns (612), carriage (615) AND the month-close pair
//                    (620 closing / its reversal), so gross profit already
//                    reads purchases + opening − closing without this file
//                    doing any stock arithmetic of its own.
//   Gross profit     the difference
//   Other income     the 700 tree
//   Expenses         every other EXPENSE (the 900 tree and friends)
//   Net profit       gross + other − expenses
//
// The balance sheet is the same read cut at a date, grouped by type, with the
// cumulative P&L to that date shown inside equity as current earnings — and
// its own self-check line: assets − liabilities − equity − earnings must be
// exactly zero or the report says so in red rather than pretending.
// ----------------------------------------------------------------------------

import { hasHouzsPerm } from '../lib/houzs-perms';
import { requireActiveCompanyId } from '../lib/companyScope';
import { paginateAll } from '../lib/paginate-all';

const requirePerm = (c: any): boolean => hasHouzsPerm(c, 'scm.payment_voucher.post');
const NO_PERM = { error: "You don't have permission to read the financial statements." };

const OTHER_INCOME_ROOT = '700-0000';

type AccountRow = { account_code: string; account_name: string; account_type: string; parent_code: string | null };
type SumRow = { code: string; name: string; type: string; drSen: number; crSen: number };

/** Sum posted, non-reversed GL lines per account inside [from, to]. */
async function loadSums(
  sb: any,
  companyId: number,
  from: string | null,
  to: string | null,
): Promise<{ ok: true; sums: SumRow[] } | { ok: false; reason: string }> {
  const { data, error } = await paginateAll((f, t) => {
    let q = sb.from('v_gl_entries')
      .select('account_code, account_name, account_type, debit_sen, credit_sen, posted, reversed')
      .eq('company_id', companyId);
    if (from) q = q.gte('entry_date', from);
    if (to) q = q.lte('entry_date', to);
    return q.range(f, t);
  });
  if (error) return { ok: false, reason: (error as { message?: string }).message ?? String(error) };
  const at = new Map<string, SumRow>();
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    if (r.posted !== true || r.reversed === true) continue;
    const code = String(r.account_code);
    const cur = at.get(code) ?? { code, name: String(r.account_name ?? code), type: String(r.account_type ?? ''), drSen: 0, crSen: 0 };
    cur.drSen += Number(r.debit_sen ?? 0);
    cur.crSen += Number(r.credit_sen ?? 0);
    at.set(code, cur);
  }
  return { ok: true, sums: [...at.values()].sort((a, b) => a.code.localeCompare(b.code)) };
}

/** parent walk → is this INCOME account under 700-0000? Same rule as the
    chart's derived badge — one vocabulary. */
function otherIncomeWalker(accounts: AccountRow[]): (code: string) => boolean {
  const parentOf = new Map(accounts.map((a) => [a.account_code, a.parent_code]));
  return (code: string): boolean => {
    let cur: string | null | undefined = code;
    for (let depth = 0; cur && depth < 6; depth += 1) {
      if (cur === OTHER_INCOME_ROOT) return true;
      cur = parentOf.get(cur);
    }
    return false;
  };
}

type ReportLine = { code: string; name: string; amountSen: number };
const lines = (rows: SumRow[], amount: (r: SumRow) => number): ReportLine[] =>
  rows.map((r) => ({ code: r.code, name: r.name, amountSen: amount(r) }))
    .filter((l) => l.amountSen !== 0);
const total = (ls: ReportLine[]): number => ls.reduce((s, l) => s + l.amountSen, 0);

/* ── GET /accounting/reports/pnl?from=YYYY-MM-DD&to=YYYY-MM-DD ────────────── */
export const pnlReport = async (c: any): Promise<Response> => {
  if (!requirePerm(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const from = String(c.req.query('from') ?? '').trim();
  const to = String(c.req.query('to') ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return c.json({ error: 'bad_range', message: 'from and to must be YYYY-MM-DD.' }, 400);
  }
  const sb = c.get('supabase');
  const [sums, accs] = await Promise.all([
    loadSums(sb, co.companyId, from, to),
    sb.from('accounts').select('account_code, account_name, account_type, parent_code').eq('company_id', co.companyId),
  ]);
  if (!sums.ok) return c.json({ error: 'load_failed', reason: sums.reason }, 500);
  if (accs.error) return c.json({ error: 'load_failed', reason: accs.error.message }, 500);
  const isOther = otherIncomeWalker((accs.data ?? []) as AccountRow[]);

  const income = sums.sums.filter((r) => r.type === 'INCOME');
  const expense = sums.sums.filter((r) => r.type === 'EXPENSE');

  const tradingIncome = lines(income.filter((r) => !isOther(r.code)), (r) => r.crSen - r.drSen);
  const otherIncome = lines(income.filter((r) => isOther(r.code)), (r) => r.crSen - r.drSen);
  const costOfSales = lines(expense.filter((r) => r.code.startsWith('6')), (r) => r.drSen - r.crSen);
  const expenses = lines(expense.filter((r) => !r.code.startsWith('6')), (r) => r.drSen - r.crSen);

  const grossProfitSen = total(tradingIncome) - total(costOfSales);
  const netProfitSen = grossProfitSen + total(otherIncome) - total(expenses);

  return c.json({
    from, to,
    tradingIncome, costOfSales, otherIncome, expenses,
    totals: {
      tradingIncomeSen: total(tradingIncome),
      costOfSalesSen: total(costOfSales),
      grossProfitSen,
      otherIncomeSen: total(otherIncome),
      expensesSen: total(expenses),
      netProfitSen,
    },
  });
};

/* ── GET /accounting/reports/balance-sheet?asOf=YYYY-MM-DD ────────────────── */
export const balanceSheetReport = async (c: any): Promise<Response> => {
  if (!requirePerm(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const asOf = String(c.req.query('asOf') ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    return c.json({ error: 'bad_date', message: 'asOf must be YYYY-MM-DD.' }, 400);
  }
  const sb = c.get('supabase');
  const sums = await loadSums(sb, co.companyId, null, asOf);
  if (!sums.ok) return c.json({ error: 'load_failed', reason: sums.reason }, 500);

  const assets = lines(sums.sums.filter((r) => r.type === 'ASSET'), (r) => r.drSen - r.crSen);
  const liabilities = lines(sums.sums.filter((r) => r.type === 'LIABILITY'), (r) => r.crSen - r.drSen);
  const equity = lines(sums.sums.filter((r) => r.type === 'EQUITY'), (r) => r.crSen - r.drSen);
  /* Every ringgit the P&L has recognised to this date lives in equity as the
     period's earnings — that is what makes the sheet balance under double
     entry, and splitting it out is how the standard statement reads. */
  const earningsSen = sums.sums.filter((r) => r.type === 'INCOME').reduce((s, r) => s + (r.crSen - r.drSen), 0)
    - sums.sums.filter((r) => r.type === 'EXPENSE').reduce((s, r) => s + (r.drSen - r.crSen), 0);

  const assetsSen = total(assets);
  const liabilitiesSen = total(liabilities);
  const equitySen = total(equity);
  return c.json({
    asOf,
    assets, liabilities, equity,
    totals: {
      assetsSen, liabilitiesSen, equitySen, earningsSen,
      /* 0 or the ledger is broken — shown, never absorbed. */
      checkSen: assetsSen - liabilitiesSen - equitySen - earningsSen,
    },
  });
};
