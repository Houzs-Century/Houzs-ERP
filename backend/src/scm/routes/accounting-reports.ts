// ----------------------------------------------------------------------------
// accounting-reports — the standard statements (GL redesign item 6, owner
// 2026-09-05: 你可以做一个 standard P&L 先…balance sheet 同理; layout will be
// iterated with him later, the NUMBERS ship now).
//
// Both read ONE source — v_gl_entries (posted, not reversed) — so they can
// never disagree with the Journal/GL/TB tabs beside them, and both CLASSIFY
// BY SECTION (owner 2026-09-06, the AutoCount tree stored on scm.accounts —
// 你先帮我分类,然后我自己还能调动: drag an account on the chart page and the
// statements follow it, the way AutoCount's do). The vocabulary's one home is
// lib/account-sections.ts; a row the chart has not sectioned (older than the
// migration, or a code the chart no longer carries) takes the default shelf
// for its type — the same rule the migration seeded with.
//
//   Trading income   SALES + SALES ADJUSTMENTS
//   Cost of sales    COST OF GOODS SOLD — purchases by group, returns,
//                    carriage AND the month-close pair (620 closing / its
//                    reversal), so gross profit already reads purchases +
//                    opening − closing without this file doing any stock
//                    arithmetic of its own.
//   Gross profit     the difference
//   Other income     OTHER INCOMES + EXTRA-ORDINARY INCOME
//   Expenses         EXPENSES
//   Profit before tax
//   Taxation         TAXATION (shown only when something posted there)
//   Net profit
//
// The balance sheet is the same read cut at a date, grouped by the section's
// type (assets / liabilities / equity — every line still names its section,
// in AutoCount order, for the layout round to come), with the cumulative P&L
// to that date shown inside equity as current earnings — and its own
// self-check line: assets − liabilities − equity − earnings must be exactly
// zero or the report says so in red rather than pretending.
// ----------------------------------------------------------------------------

import { hasHouzsPerm } from '../lib/houzs-perms';
import { requireActiveCompanyId } from '../lib/companyScope';
import { paginateAll } from '../lib/paginate-all';
import { ACCOUNT_SECTIONS, defaultSectionFor } from '../lib/account-sections';

const requirePerm = (c: any): boolean => hasHouzsPerm(c, 'scm.payment_voucher.post');
const NO_PERM = { error: "You don't have permission to read the financial statements." };

type AccountRow = { account_code: string; account_type: string; section: string | null };
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

/** The chart of the active company, read once per report. */
async function loadAccounts(sb: any, companyId: number): Promise<{ ok: true; accounts: AccountRow[] } | { ok: false; reason: string }> {
  const { data, error } = await sb.from('accounts').select('account_code, account_type, section').eq('company_id', companyId);
  if (error) return { ok: false, reason: String((error as { message?: string }).message ?? error) };
  return { ok: true, accounts: (data ?? []) as AccountRow[] };
}

/** Where each summed account sits: its stored section, else the default
    shelf for its type (a row older than the migration, or a code the chart
    no longer carries). */
function sectionResolver(accounts: AccountRow[]): (r: SumRow) => string {
  const stored = new Map(accounts.map((a) => [a.account_code, a.section]));
  return (r) => stored.get(r.code) ?? defaultSectionFor(r.type, r.code);
}

const SECTION_ORDER = new Map(ACCOUNT_SECTIONS.map((s, i) => [s.section, i]));
const sectionsOfType = (type: string): string[] => ACCOUNT_SECTIONS.filter((s) => s.type === type).map((s) => s.section);

type Sectioned = { r: SumRow; section: string };
type ReportLine = { code: string; name: string; section: string; amountSen: number };

const lines = (rows: Sectioned[], amount: (r: SumRow) => number): ReportLine[] =>
  rows.map((x) => ({ code: x.r.code, name: x.r.name, section: x.section, amountSen: amount(x.r) }))
    .filter((l) => l.amountSen !== 0)
    .sort((a, b) => ((SECTION_ORDER.get(a.section) ?? 99) - (SECTION_ORDER.get(b.section) ?? 99)) || a.code.localeCompare(b.code));
const total = (ls: ReportLine[]): number => ls.reduce((s, l) => s + l.amountSen, 0);
const inSections = (rows: Sectioned[], sections: string[]): Sectioned[] => rows.filter((x) => sections.includes(x.section));

const credit = (r: SumRow): number => r.crSen - r.drSen;
const debit = (r: SumRow): number => r.drSen - r.crSen;

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
  const [sums, accs] = await Promise.all([loadSums(sb, co.companyId, from, to), loadAccounts(sb, co.companyId)]);
  if (!sums.ok) return c.json({ error: 'load_failed', reason: sums.reason }, 500);
  if (!accs.ok) return c.json({ error: 'load_failed', reason: accs.reason }, 500);
  const secOf = sectionResolver(accs.accounts);
  const rows: Sectioned[] = sums.sums.map((r) => ({ r, section: secOf(r) }));

  const tradingIncome = lines(inSections(rows, ['SALES', 'SALES ADJUSTMENTS']), credit);
  const costOfSales = lines(inSections(rows, ['COST OF GOODS SOLD']), debit);
  const otherIncome = lines(inSections(rows, ['OTHER INCOMES', 'EXTRA-ORDINARY INCOME']), credit);
  const expenses = lines(inSections(rows, ['EXPENSES']), debit);
  const taxation = lines(inSections(rows, ['TAXATION']), debit);

  const grossProfitSen = total(tradingIncome) - total(costOfSales);
  const profitBeforeTaxSen = grossProfitSen + total(otherIncome) - total(expenses);
  const netProfitSen = profitBeforeTaxSen - total(taxation);

  return c.json({
    from, to,
    tradingIncome, costOfSales, otherIncome, expenses, taxation,
    totals: {
      tradingIncomeSen: total(tradingIncome),
      costOfSalesSen: total(costOfSales),
      grossProfitSen,
      otherIncomeSen: total(otherIncome),
      expensesSen: total(expenses),
      profitBeforeTaxSen,
      taxationSen: total(taxation),
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
  const [sums, accs] = await Promise.all([loadSums(sb, co.companyId, null, asOf), loadAccounts(sb, co.companyId)]);
  if (!sums.ok) return c.json({ error: 'load_failed', reason: sums.reason }, 500);
  if (!accs.ok) return c.json({ error: 'load_failed', reason: accs.reason }, 500);
  const secOf = sectionResolver(accs.accounts);
  const rows: Sectioned[] = sums.sums.map((r) => ({ r, section: secOf(r) }));

  const assets = lines(inSections(rows, sectionsOfType('ASSET')), debit);
  const liabilities = lines(inSections(rows, sectionsOfType('LIABILITY')), credit);
  const equity = lines(inSections(rows, sectionsOfType('EQUITY')), credit);
  /* Every ringgit the P&L has recognised to this date lives in equity as the
     period's earnings — that is what makes the sheet balance under double
     entry, and splitting it out is how the standard statement reads. */
  const earningsSen = inSections(rows, sectionsOfType('INCOME')).reduce((s, x) => s + credit(x.r), 0)
    - inSections(rows, sectionsOfType('EXPENSE')).reduce((s, x) => s + debit(x.r), 0);

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
