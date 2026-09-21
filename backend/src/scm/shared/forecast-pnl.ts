// ----------------------------------------------------------------------------
// forecast-pnl — the Forecast P&L's own rules (owner 2026-09-21: 照 P&L 现在那
// 棵树一行一个户口填; 按采购户口填 %; 填 % 反推 amount, 填 amount 反推 %).
//
// A planning grid, months × the P&L's own accounts. A SALES line takes an
// AMOUNT — the month's forecast sales are the sum of the sales lines, and
// they are what every percentage is of. Every other line takes EITHER a share
// of that sales figure in basis points (15% = 1500) OR an amount in sen, never
// both: a % line's amount is sales × bp / 10000, an amount line's share is
// amount / sales. Totals follow the P&L's five blocks — trading income, cost
// of sales, other income, expenses, taxation — to gross profit, profit before
// tax and net profit, the statement's own arithmetic, so the forecast and the
// actual read alike on the Dashboard. A new month inherits the previous
// month's percentages and starts its amounts blank. Nothing here touches the
// books.
//
// Byte-identical on both sides — backend/src/scm/shared and the frontend's
// vendor/shared copy; the route test pins FORECAST_BLOCKS to the statement's
// own REPORT_BLOCKS, so the two can never file a section apart.
// ----------------------------------------------------------------------------

export type ForecastCell = { bp: number } | { amtSen: number };
/** One month's keyed lines: account code → the cell. A line not keyed is not a line. */
export type ForecastLines = Record<string, ForecastCell>;
/** 'YYYY-MM' → the month's lines. A month exists once it was added, even empty. */
export type ForecastGrid = Record<string, ForecastLines>;
/** An account the grid may name: an active leaf of one of the P&L's sections, sectioned as the statement sections it. */
export type ForecastAccount = { code: string; name: string; section: string; type: string };

export const FORECAST_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** The P&L's blocks and the chart sections that fill them — the statement's own list. */
export const FORECAST_BLOCKS = [
  { key: 'tradingIncome', title: 'Trading income', sections: ['SALES', 'SALES ADJUSTMENTS'] },
  { key: 'costOfSales', title: 'Cost of sales', sections: ['COST OF GOODS SOLD'] },
  { key: 'otherIncome', title: 'Other income', sections: ['OTHER INCOMES', 'EXTRA-ORDINARY INCOME'] },
  { key: 'expenses', title: 'Expenses', sections: ['EXPENSES'] },
  { key: 'taxation', title: 'Taxation', sections: ['TAXATION'] },
] as const;
export type ForecastBlockKey = (typeof FORECAST_BLOCKS)[number]['key'];

export const blockOfSection = (section: string): ForecastBlockKey | null =>
  FORECAST_BLOCKS.find((b) => (b.sections as readonly string[]).includes(section))?.key ?? null;
export const isSalesAccount = (a: ForecastAccount): boolean => blockOfSection(a.section) === 'tradingIncome';

export const isAmountCell = (c: ForecastCell): c is { amtSen: number } => 'amtSen' in c;
/** The name a refusal gives a cell: "2026-10 900-T003 amount". */
export const cellLabel = (month: string, code: string, field: 'amount' | 'percent'): string => `${month} ${code} ${field}`;

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
/** The cell a month keyed for an account, or nothing — a Record lookup that says so in its type. */
const cellOf = (lines: ForecastLines, code: string): ForecastCell | undefined => (Object.prototype.hasOwnProperty.call(lines, code) ? lines[code] : undefined);

export type ValidatedGrid = { ok: true; grid: ForecastGrid } | { ok: false; cell: string; reason: string };

/** The grid as the page sends it, checked cell by cell: a month key, an account
    the P&L carries, exactly one of bp / amtSen, whole numbers, a sales line an
    amount. The first bad cell is named and nothing is kept. */
export function validateGrid(raw: unknown, accounts: ForecastAccount[]): ValidatedGrid {
  const byCode = new Map(accounts.map((a) => [a.code, a]));
  const months = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!months) return { ok: false, cell: 'months', reason: 'months must be an object keyed YYYY-MM' };
  const grid: ForecastGrid = {};
  for (const month of Object.keys(months).sort()) {
    if (!FORECAST_MONTH_RE.test(month)) return { ok: false, cell: month, reason: 'not a month (YYYY-MM)' };
    const lines = months[month];
    if (lines === null || typeof lines !== 'object' || Array.isArray(lines)) return { ok: false, cell: month, reason: 'a month holds an object of lines' };
    const clean: ForecastLines = {};
    for (const [code, cell] of Object.entries(lines as Record<string, unknown>)) {
      const acc = byCode.get(code);
      if (!acc) return { ok: false, cell: `${month} ${code}`, reason: 'not an account on the P&L' };
      if (cell === null || typeof cell !== 'object' || Array.isArray(cell)) return { ok: false, cell: `${month} ${code}`, reason: 'a cell is { bp } or { amtSen }' };
      const c = cell as Record<string, unknown>;
      const hasBp = c.bp !== undefined && c.bp !== null;
      const hasAmt = c.amtSen !== undefined && c.amtSen !== null;
      if (hasBp && hasAmt) return { ok: false, cell: `${month} ${code}`, reason: 'a cell is an amount OR a percent, never both' };
      if (!hasBp && !hasAmt) return { ok: false, cell: `${month} ${code}`, reason: 'an empty cell is left out, not sent' };
      if (hasAmt) {
        if (!isInt(c.amtSen)) return { ok: false, cell: cellLabel(month, code, 'amount'), reason: 'amount must be a whole number of sen' };
        clean[code] = { amtSen: c.amtSen };
      } else {
        if (isSalesAccount(acc)) return { ok: false, cell: cellLabel(month, code, 'percent'), reason: 'a sales line takes an amount — it is what the percentages are of' };
        if (!isInt(c.bp) || c.bp < 0) return { ok: false, cell: cellLabel(month, code, 'percent'), reason: 'percent must be a whole number of basis points, zero or more' };
        clean[code] = { bp: c.bp };
      }
    }
    grid[month] = clean;
  }
  return { ok: true, grid };
}

/** The month's forecast sales: the sum of what is keyed on the sales lines, signed as the P&L prints them (a discount keyed negative reduces it). */
export function forecastSalesSen(lines: ForecastLines, accounts: ForecastAccount[]): number {
  let sum = 0;
  for (const a of accounts) {
    if (!isSalesAccount(a)) continue;
    const c = cellOf(lines, a.code);
    if (c && isAmountCell(c)) sum += c.amtSen;
  }
  return sum;
}

/** Half-up rounding that keeps the sign. */
const round = (v: number): number => Math.sign(v) * Math.round(Math.abs(v));

export type ForecastLine = {
  code: string; name: string; section: string; block: ForecastBlockKey;
  /** The line's forecast amount in sen — keyed, or sales × bp / 10000. */
  amountSen: number;
  /** The line's share of the month's forecast sales in basis points — keyed, or amount / sales; null when there are no sales to divide by. */
  bp: number | null;
  keyed: 'amount' | 'percent';
};
export type ForecastTotals = {
  tradingIncomeSen: number; costOfSalesSen: number; grossProfitSen: number; otherIncomeSen: number;
  expensesSen: number; profitBeforeTaxSen: number; taxationSen: number; netProfitSen: number;
};
export type ForecastFigures = { salesSen: number; lines: ForecastLine[]; totals: ForecastTotals };

/** One month's figures: every keyed line's amount and share, and the P&L's totals over them. */
export function monthFigures(lines: ForecastLines, accounts: ForecastAccount[]): ForecastFigures {
  const salesSen = forecastSalesSen(lines, accounts);
  const out: ForecastLine[] = [];
  for (const a of accounts) {
    const block = blockOfSection(a.section);
    const c = cellOf(lines, a.code);
    if (!block || !c) continue;
    if (isAmountCell(c)) {
      out.push({ code: a.code, name: a.name, section: a.section, block, amountSen: c.amtSen, bp: salesSen !== 0 ? round((c.amtSen / salesSen) * 10000) : null, keyed: 'amount' });
    } else {
      out.push({ code: a.code, name: a.name, section: a.section, block, amountSen: round((salesSen * c.bp) / 10000), bp: c.bp, keyed: 'percent' });
    }
  }
  const sum = (key: ForecastBlockKey): number => out.filter((l) => l.block === key).reduce((s, l) => s + l.amountSen, 0);
  const tradingIncomeSen = sum('tradingIncome');
  const costOfSalesSen = sum('costOfSales');
  const otherIncomeSen = sum('otherIncome');
  const expensesSen = sum('expenses');
  const taxationSen = sum('taxation');
  const grossProfitSen = tradingIncomeSen - costOfSalesSen;
  const profitBeforeTaxSen = grossProfitSen + otherIncomeSen - expensesSen;
  return {
    salesSen, lines: out,
    totals: { tradingIncomeSen, costOfSalesSen, grossProfitSen, otherIncomeSen, expensesSen, profitBeforeTaxSen, taxationSen, netProfitSen: profitBeforeTaxSen - taxationSen },
  };
}

/** A new month starts from the previous month's percentages; its amounts — the sales above all — start blank. */
export function inheritMonth(prev: ForecastLines | undefined): ForecastLines {
  const next: ForecastLines = {};
  for (const [code, c] of Object.entries(prev ?? {})) if (!isAmountCell(c)) next[code] = { bp: c.bp };
  return next;
}

/** The grid's months in order. */
export const sortedMonths = (grid: ForecastGrid): string[] => Object.keys(grid).sort();

/** The month after a 'YYYY-MM'. */
export function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}
