// ----------------------------------------------------------------------------
// accounting-reports — the standard statements (GL redesign item 6, owner
// 2026-09-05: 你可以做一个 standard P&L 先…balance sheet 同理; layout will be
// iterated with him later, the NUMBERS ship now).
//
// Both read ONE source — v_gl_entries (posted, on neither side of a reversal
// pair; acc/reversal-pairs.ts) — so they can
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
// Since 2026-09-15 (docs/bugs/0911) the P&L ALSO hands the same figures
// back arranged on the report's LAYOUT — the owner's tree of categories
// (acc/report-layout.ts; one tree per report, shared by every company,
// ticked per company), each line and subtotal with its % of sales. The flat
// section lists stay as they were: the layout only groups, orders and names;
// the section still decides the block, so the totals are the same money.
//
// The balance sheet is the same read cut at a date, grouped by the section's
// type (assets / liabilities / equity — every line still names its section,
// in AutoCount order, for the layout round to come), with the cumulative P&L
// to that date shown inside equity as current earnings — and its own
// self-check line: assets − liabilities − equity − earnings must be exactly
// zero or the report says so in red rather than pretending.
//
// STOCK (owner 2026-09-21: by right 抓的就是 live 的 closing stock — 报表选
// 8月31号就应该显示当时 stock 拥有的 amount, 9月21号就应该是 9月21号). The
// stock lines do NOT come from the GL's month-close pair: they come from the
// stock engine as of the date (acc/stock-close.ts, the same replay the close
// books from — owned goods, by bucket). The P&L prints Opening stock (the
// engine the day before the range) and Closing stock (the engine on its last
// day), one line per bucket on the bucket's own accounts; the balance sheet's
// STOCK is the engine as at its date. The GL's own 330 / 600 / 620 lines are
// set aside so nothing counts twice, and the earnings figure is adjusted by
// the same difference, so the self-check still reads zero. At a month-end
// the close has booked, engine and ledger are the same number; anywhere
// else (the open month, a mid-month date) the closing is flagged
// PROVISIONAL — it is what the shelves hold today, not yet a journal.
// ----------------------------------------------------------------------------

import { hasHouzsPerm } from '../lib/houzs-perms';
import { requireActiveCompanyId } from '../lib/companyScope';
import { paginateAll } from '../lib/paginate-all';
import { ACCOUNT_SECTIONS, defaultSectionFor } from '../lib/account-sections';
import { layOutBlock, type LaidNode } from '../../acc/report-layout';
import { countsInTheBooks } from '../../acc/reversal-pairs';
import { allowedIds, resolveLayout } from './accounting-report-layouts';
import { resolveRoles, STOCK_BUCKET_ROLES, type AccountRole } from '../../acc/rules';
import { stockValueByBucketAsOf } from '../../acc/stock-close';
import { STOCK_BUCKETS, type StockBucket } from '../lib/stock-bucket';

const requirePerm = (c: any): boolean => hasHouzsPerm(c, 'scm.payment_voucher.post');
const NO_PERM = { error: "You don't have permission to read the financial statements." };

export type AccountRow = { account_code: string; account_name?: string | null; account_type: string; section: string | null };
export type SumRow = { code: string; name: string; type: string; drSen: number; crSen: number };

/** Sum the GL lines the books count per account inside [from, to] — posted,
    and on neither side of a reversal pair (docs/bugs/0923: a contra dated in
    a later month is not that month's movement). Shared with the Performance
    P&L (accounting-performance.ts), whose expense side is this read cut to
    the EXPENSES section. */
export async function loadSums(
  sb: any,
  companyId: number,
  from: string | null,
  to: string | null,
): Promise<{ ok: true; sums: SumRow[] } | { ok: false; reason: string }> {
  const { data, error } = await paginateAll((f, t) => {
    let q = sb.from('v_gl_entries')
      .select('account_code, account_name, account_type, debit_sen, credit_sen, posted, reversed, reversed_by_je')
      .eq('company_id', companyId);
    if (from) q = q.gte('entry_date', from);
    if (to) q = q.lte('entry_date', to);
    return q.range(f, t);
  });
  if (error) return { ok: false, reason: (error as { message?: string }).message ?? String(error) };
  const at = new Map<string, SumRow>();
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    if (!countsInTheBooks(r as { posted?: boolean | null; reversed?: boolean | null; reversed_by_je?: string | null })) continue;
    const code = String(r.account_code);
    const cur = at.get(code) ?? { code, name: String(r.account_name ?? code), type: String(r.account_type ?? ''), drSen: 0, crSen: 0 };
    cur.drSen += Number(r.debit_sen ?? 0);
    cur.crSen += Number(r.credit_sen ?? 0);
    at.set(code, cur);
  }
  return { ok: true, sums: [...at.values()].sort((a, b) => a.code.localeCompare(b.code)) };
}

/** The chart of the active company, read once per report. */
export async function loadAccounts(sb: any, companyId: number): Promise<{ ok: true; accounts: AccountRow[] } | { ok: false; reason: string }> {
  const { data, error } = await sb.from('accounts').select('account_code, account_name, account_type, section').eq('company_id', companyId);
  if (error) return { ok: false, reason: String((error as { message?: string }).message ?? error) };
  return { ok: true, accounts: (data ?? []) as AccountRow[] };
}

/** Where each summed account sits: its stored section, else the default
    shelf for its type (a row older than the migration, or a code the chart
    no longer carries). */
export function sectionResolver(accounts: AccountRow[]): (r: SumRow) => string {
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

/* ── The stock lines, from the engine ─────────────────────────────────────── */

/** The day before a date, YYYY-MM-DD. */
const dayBefore = (iso: string): string => new Date(Date.parse(`${iso}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
/** The last day of a date's month, YYYY-MM-DD. */
const monthEndOf = (iso: string): string => {
  const [y, m] = iso.split('-').map(Number) as [number, number];
  return `${iso.slice(0, 7)}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};
/** The name a stock line prints when the chart has no row for its code yet (the seed not run). */
const STOCK_ROLE_NAMES: Partial<Record<AccountRole, string>> = {
  INVENTORY_CUSTOMER: 'STOCK - CUSTOMER', INVENTORY_DISPLAY: 'STOCK - DISPLAY', INVENTORY_SERVICE: 'STOCK - SERVICE',
  OPENING_STOCK_CUSTOMER: 'STOCKS AT THE BEGINNING OF YEAR - CUSTOMER', OPENING_STOCK_DISPLAY: 'STOCKS AT THE BEGINNING OF YEAR - DISPLAY', OPENING_STOCK_SERVICE: 'STOCKS AT THE BEGINNING OF YEAR - SERVICE',
  CLOSING_STOCK_CUSTOMER: 'STOCKS AT THE END OF YEAR - CUSTOMER', CLOSING_STOCK_DISPLAY: 'STOCKS AT THE END OF YEAR - DISPLAY', CLOSING_STOCK_SERVICE: 'STOCKS AT THE END OF YEAR - SERVICE',
};
/** Every code the ledger books stock on — the legacy one-account pair and the nine bucket accounts. */
const stockCodesOf = (roles: Record<AccountRole, string>): Set<string> => new Set([
  roles.INVENTORY, roles.CLOSING_STOCK,
  ...STOCK_BUCKETS.flatMap((b) => [roles[STOCK_BUCKET_ROLES[b].inventory], roles[STOCK_BUCKET_ROLES[b].opening], roles[STOCK_BUCKET_ROLES[b].closing]]),
]);

type StockLines = {
  /** What the range OPENED on (the engine the day before it) and CLOSED on (the engine on its last day), per bucket. */
  opening: Record<StockBucket, number>; closing: Record<StockBucket, number>;
  /** The engine's total on the last day — what the balance sheet's stock reads. */
  closingTotalSen: number;
  /** True unless the ledger has booked a closing for that very month-end. */
  closingProvisional: boolean;
  roles: Record<AccountRole, string>;
  codes: Set<string>;
};

/** The engine's opening and closing per bucket for [from, to]; a null from = since always (no opening). */
async function loadStockLines(sb: any, companyId: number, from: string | null, to: string): Promise<{ ok: true; stock: StockLines } | { ok: false; reason: string }> {
  const roles = await resolveRoles(sb, companyId);
  const [openingR, closingR] = await Promise.all([
    from ? stockValueByBucketAsOf(sb, companyId, dayBefore(from)) : Promise.resolve({ ok: true as const, buckets: { customer: 0, display: 0, service: 0 }, totalSen: 0 }),
    stockValueByBucketAsOf(sb, companyId, to),
  ]);
  if (!openingR.ok) return { ok: false, reason: `opening stock: ${openingR.reason}` };
  if (!closingR.ok) return { ok: false, reason: `closing stock: ${closingR.reason}` };
  /* Booked = an active STOCKADJ closing entry for the month AND the date is that month's end. */
  let booked = false;
  if (to === monthEndOf(to)) {
    const { data, error } = await sb.from('journal_entries')
      .select('id, reversed')
      .eq('company_id', companyId).eq('source_type', 'STOCKADJ').eq('source_doc_no', `STOCKADJ-${companyId}-${to.slice(0, 7)}`);
    if (error) return { ok: false, reason: `closing entry: ${error.message}` };
    booked = ((data ?? []) as Array<{ reversed: boolean | null }>).some((j) => !j.reversed);
  }
  return { ok: true, stock: { opening: openingR.buckets, closing: closingR.buckets, closingTotalSen: closingR.totalSen, closingProvisional: !booked, roles, codes: stockCodesOf(roles) } };
}

/** A stock line on the statement: the role's account, its chart name (or the role's own when the chart lacks the row). */
const stockLine = (stock: StockLines, names: Map<string, string>, role: AccountRole, section: string, amountSen: number): ReportLine => {
  const code = stock.roles[role];
  return { code, name: names.get(code) ?? STOCK_ROLE_NAMES[role] ?? code, section, amountSen };
};
/** The P&L's stock lines, in bucket order: the openings (debits), then the closings (credits). */
const stockPnlLines = (stock: StockLines, names: Map<string, string>): ReportLine[] => [
  ...STOCK_BUCKETS.filter((b) => stock.opening[b] !== 0).map((b) => stockLine(stock, names, STOCK_BUCKET_ROLES[b].opening, 'COST OF GOODS SOLD', stock.opening[b])),
  ...STOCK_BUCKETS.filter((b) => stock.closing[b] !== 0).map((b) => stockLine(stock, names, STOCK_BUCKET_ROLES[b].closing, 'COST OF GOODS SOLD', -stock.closing[b])),
];

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
  const [sums, accs, laid, stockR] = await Promise.all([
    loadSums(sb, co.companyId, from, to),
    loadAccounts(sb, co.companyId),
    resolveLayout(sb, allowedIds(c), 'pnl'),
    loadStockLines(sb, co.companyId, from, to),
  ]);
  if (!sums.ok) return c.json({ error: 'load_failed', reason: sums.reason }, 500);
  if (!accs.ok) return c.json({ error: 'load_failed', reason: accs.reason }, 500);
  if (!laid.ok) return c.json({ error: 'load_failed', reason: laid.reason }, 500);
  if (!stockR.ok) return c.json({ error: 'load_failed', reason: stockR.reason }, 500);
  const stock = stockR.stock;
  const secOf = sectionResolver(accs.accounts);
  /* The GL's own stock lines are set aside: the engine's take their place. */
  const rows: Sectioned[] = sums.sums.filter((r) => !stock.codes.has(r.code)).map((r) => ({ r, section: secOf(r) }));
  const names = new Map(accs.accounts.map((a) => [a.account_code, a.account_name ?? a.account_code]));

  const tradingIncome = lines(inSections(rows, ['SALES', 'SALES ADJUSTMENTS']), credit);
  const costOfSales = [...lines(inSections(rows, ['COST OF GOODS SOLD']), debit), ...stockPnlLines(stock, names)];
  const otherIncome = lines(inSections(rows, ['OTHER INCOMES', 'EXTRA-ORDINARY INCOME']), credit);
  const expenses = lines(inSections(rows, ['EXPENSES']), debit);
  const taxation = lines(inSections(rows, ['TAXATION']), debit);

  const grossProfitSen = total(tradingIncome) - total(costOfSales);
  const profitBeforeTaxSen = grossProfitSen + total(otherIncome) - total(expenses);
  const netProfitSen = profitBeforeTaxSen - total(taxation);

  /* Every % on the P&L is of sales — nothing to divide by means no %. */
  const baseSen = total(tradingIncome) !== 0 ? total(tradingIncome) : null;
  const onTree = (block: string, ls: ReportLine[]): LaidNode[] =>
    layOutBlock(laid.layout.blocks[block] ?? [], ls, co.companyId, baseSen);

  return c.json({
    from, to,
    tradingIncome, costOfSales, otherIncome, expenses, taxation,
    /* The closing stock is the engine's as of `to`; provisional until the close books that month-end. */
    stock: { closingProvisional: stock.closingProvisional, asOf: to },
    layout: {
      stored: laid.stored,
      baseSen,
      tradingIncome: onTree('tradingIncome', tradingIncome),
      costOfSales: onTree('costOfSales', costOfSales),
      otherIncome: onTree('otherIncome', otherIncome),
      expenses: onTree('expenses', expenses),
      taxation: onTree('taxation', taxation),
    },
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
  const [sums, accs, laid, stockR] = await Promise.all([
    loadSums(sb, co.companyId, null, asOf),
    loadAccounts(sb, co.companyId),
    resolveLayout(sb, allowedIds(c), 'balance_sheet'),
    loadStockLines(sb, co.companyId, null, asOf),
  ]);
  if (!sums.ok) return c.json({ error: 'load_failed', reason: sums.reason }, 500);
  if (!accs.ok) return c.json({ error: 'load_failed', reason: accs.reason }, 500);
  if (!laid.ok) return c.json({ error: 'load_failed', reason: laid.reason }, 500);
  if (!stockR.ok) return c.json({ error: 'load_failed', reason: stockR.reason }, 500);
  const stock = stockR.stock;
  const secOf = sectionResolver(accs.accounts);
  const names = new Map(accs.accounts.map((a) => [a.account_code, a.account_name ?? a.account_code]));
  /* The GL's own stock lines are set aside — on the asset side AND inside
     earnings, where the close's pair moves the same money — and the engine's
     stand in their place on both, so the sheet still balances. */
  const rows: Sectioned[] = sums.sums.filter((r) => !stock.codes.has(r.code)).map((r) => ({ r, section: secOf(r) }));
  const stockAssetLines = STOCK_BUCKETS.filter((b) => stock.closing[b] !== 0)
    .map((b) => stockLine(stock, names, STOCK_BUCKET_ROLES[b].inventory, 'CURRENT ASSETS', stock.closing[b]));

  const assets = [...lines(inSections(rows, sectionsOfType('ASSET')), debit), ...stockAssetLines];
  const liabilities = lines(inSections(rows, sectionsOfType('LIABILITY')), credit);
  const equity = lines(inSections(rows, sectionsOfType('EQUITY')), credit);
  /* Every ringgit the P&L has recognised to this date lives in equity as the
     period's earnings — that is what makes the sheet balance under double
     entry, and splitting it out is how the standard statement reads. */
  const earningsSen = inSections(rows, sectionsOfType('INCOME')).reduce((s, x) => s + credit(x.r), 0)
    - inSections(rows, sectionsOfType('EXPENSE')).reduce((s, x) => s + debit(x.r), 0)
    /* The engine's closing stock is the stock effect on earnings to this date — the GL's pair was taken out of `rows` above. */
    + stock.closingTotalSen;

  const assetsSen = total(assets);
  const liabilitiesSen = total(liabilities);
  const equitySen = total(equity);
  /* Every % on the balance sheet is of total assets, both sides (owner
     2026-09-14: balance sheet 也需要) — nothing to divide by means no %. */
  const baseSen = assetsSen !== 0 ? assetsSen : null;
  const onTree = (block: string, ls: ReportLine[]): LaidNode[] =>
    layOutBlock(laid.layout.blocks[block] ?? [], ls, co.companyId, baseSen);
  return c.json({
    asOf,
    assets, liabilities, equity,
    stock: { closingProvisional: stock.closingProvisional, asOf },
    layout: {
      stored: laid.stored,
      baseSen,
      assets: onTree('assets', assets),
      liabilities: onTree('liabilities', liabilities),
      equity: onTree('equity', equity),
    },
    totals: {
      assetsSen, liabilitiesSen, equitySen, earningsSen,
      /* 0 or the ledger is broken — shown, never absorbed. */
      checkSen: assetsSen - liabilitiesSen - equitySen - earningsSen,
    },
  });
};
