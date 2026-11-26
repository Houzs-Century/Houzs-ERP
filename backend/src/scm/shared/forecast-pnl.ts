// ----------------------------------------------------------------------------
// forecast-pnl — the Forecast P&L's own rules (owner 2026-09-21: 照 P&L 现在那
// 棵树一行一个户口填; 按采购户口填 %; 填 % 反推 amount, 填 amount 反推 %).
//
// A planning grid, months × the P&L's own accounts. A SALES line takes an
// AMOUNT — the month's forecast sales are the sum of the sales lines, and
// they are what a percentage is of. Every other line takes EITHER a share in
// basis points (15% = 1500) OR an amount in sen, never both: a % line's amount
// is basis × bp / 10000, an amount line's share is amount / basis. The BASIS is
// the month's whole forecast sales — except for a line whose account is bound
// to an item group's sales (a PURCHASE account, scm.acc_item_group_accounts):
// its basis is those sales lines alone (owner 2026-09-29: purchase of bedding
// 应该是根据回他的 sales 的 amount 算，而不是 total sales, sofa 同理), which the
// route stamps on the account as `basis`. Totals follow the P&L's five blocks — trading income, cost
// of sales, other income, expenses, taxation — to gross profit, profit before
// tax and net profit, the statement's own arithmetic, so the forecast and the
// actual read alike on the Dashboard. A new month inherits the previous
// month's percentages and starts its amounts blank. Nothing here touches the
// books.
//
// A PURCHASE account's month may be split by supplier (owner 2026-11-24, the
// Hookka port's first step, docs/forecast-port-spec.md): each supplier of the
// company, or Other, an amount or a share of the account's own basis. An
// account with any supplier figure that month IS their sum; its own cell is
// superseded — kept, and counted again once the suppliers are cleared.
// Supplier figures under an account that is not a purchase account count
// nowhere.
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
/** An account the grid may name: an active leaf of one of the P&L's sections,
    sectioned as the statement sections it. `basis` — the sales accounts a
    percentage on this line is OF (a purchase account's own group's sales, from
    the item-group bindings); absent or empty = the month's whole sales.
    `purchase` — a purchase account (isPurchaseOfChart), whose month may be
    split by supplier. */
export type ForecastAccount = { code: string; name: string; section: string; type: string; basis?: string[]; purchase?: boolean };

/** A month's supplier figures: purchase account code → supplier id (or
    OTHER_SUPPLIER) → the cell, an amount in sen or a share in basis points of
    the account's own basis. A supplier not keyed is not there. */
export type SupplierLines = Record<string, Record<string, ForecastCell>>;
/** 'YYYY-MM' → the month's supplier figures; a month with none may be absent. */
export type SupplierGrid = Record<string, SupplierLines>;
/** The supplier row for suppliers not in the list yet. */
export const OTHER_SUPPLIER = 'other';

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
/** A purchase account: its month may be split by supplier. */
export const isPurchaseAccount = (a: ForecastAccount): boolean => a.purchase === true;

/** Which cost-of-sales lines are purchase accounts (step 1 of the forecast
    port, 2026-11-24: the purchases under Cost of Goods Sold): a line an item
    group's purchase invoices post to (`boundToGroup`, the item-group bindings
    of the company), or one the chart names a purchase ("PURCHASE …" /
    "PURCHASES …"), a purchases return left out. The other cost-of-sales
    lines — opening and closing stock, discount received, purchases return,
    carriage inwards, the deposit-based cost — stay one figure. */
export function isPurchaseOfChart(a: { section: string; name: string }, boundToGroup: boolean): boolean {
  if (blockOfSection(a.section) !== 'costOfSales') return false;
  if (boundToGroup) return true;
  const name = a.name.trim();
  return /^PURCHASES?\b/i.test(name) && !/\bRETURNS?\b/i.test(name);
}

export const isAmountCell = (c: ForecastCell): c is { amtSen: number } => 'amtSen' in c;
/** The name a refusal gives a cell: "2026-10 900-T003 amount". */
export const cellLabel = (month: string, code: string, field: 'amount' | 'percent'): string => `${month} ${code} ${field}`;
/** The name a refusal gives a supplier's cell: "2026-10 601-0003 <supplier id> amount" — the page's box carries the same. */
export const supplierCellLabel = (month: string, code: string, supplierId: string, field: 'amount' | 'percent'): string => `${month} ${code} ${supplierId} ${field}`;

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const cellOf = (lines: ForecastLines, code: string): ForecastCell | undefined => (Object.prototype.hasOwnProperty.call(lines, code) ? lines[code] : undefined);

type CellCheck = { ok: true; cell: ForecastCell } | { ok: false; field: 'amount' | 'percent' | null; reason: string };
function checkCell(raw: unknown, sales: boolean): CellCheck {
  if (!isPlainObject(raw)) return { ok: false, field: null, reason: 'a cell is { bp } or { amtSen }' };
  const hasBp = raw.bp !== undefined && raw.bp !== null;
  const hasAmt = raw.amtSen !== undefined && raw.amtSen !== null;
  if (hasBp && hasAmt) return { ok: false, field: null, reason: 'a cell is an amount OR a percent, never both' };
  if (!hasBp && !hasAmt) return { ok: false, field: null, reason: 'an empty cell is left out, not sent' };
  if (hasAmt) {
    if (!isInt(raw.amtSen)) return { ok: false, field: 'amount', reason: 'amount must be a whole number of sen' };
    return { ok: true, cell: { amtSen: raw.amtSen } };
  }
  if (sales) return { ok: false, field: 'percent', reason: 'a sales line takes an amount — it is what the percentages are of' };
  if (!isInt(raw.bp) || raw.bp < 0) return { ok: false, field: 'percent', reason: 'percent must be a whole number of basis points, zero or more' };
  return { ok: true, cell: { bp: raw.bp } };
}

export type ValidatedGrid = { ok: true; grid: ForecastGrid } | { ok: false; cell: string; reason: string };

/** The grid as the page sends it, checked cell by cell: a month key, an account
    the P&L carries, exactly one of bp / amtSen, whole numbers, a sales line an
    amount. The first bad cell is named and nothing is kept. */
export function validateGrid(raw: unknown, accounts: ForecastAccount[]): ValidatedGrid {
  const byCode = new Map(accounts.map((a) => [a.code, a]));
  const months = isPlainObject(raw) ? raw : null;
  if (!months) return { ok: false, cell: 'months', reason: 'months must be an object keyed YYYY-MM' };
  const grid: ForecastGrid = {};
  for (const month of Object.keys(months).sort()) {
    if (!FORECAST_MONTH_RE.test(month)) return { ok: false, cell: month, reason: 'not a month (YYYY-MM)' };
    const lines = months[month];
    if (!isPlainObject(lines)) return { ok: false, cell: month, reason: 'a month holds an object of lines' };
    const clean: ForecastLines = {};
    for (const [code, cell] of Object.entries(lines)) {
      const acc = byCode.get(code);
      if (!acc) return { ok: false, cell: `${month} ${code}`, reason: 'not an account on the P&L' };
      const c = checkCell(cell, isSalesAccount(acc));
      if (!c.ok) return { ok: false, cell: c.field ? cellLabel(month, code, c.field) : `${month} ${code}`, reason: c.reason };
      clean[code] = c.cell;
    }
    grid[month] = clean;
  }
  return { ok: true, grid };
}

export type ValidatedSuppliers = { ok: true; suppliers: SupplierGrid } | { ok: false; cell: string; reason: string };

/** The supplier figures as the page sends them, checked cell by cell: a month
    the grid carries, a purchase account on the P&L, a supplier of the company
    (`supplierIds`, read under the company predicate) or Other, and the cell
    rules of a line. The first bad cell is named and nothing is kept; an
    account or a month with no supplier left is dropped. */
export function validateSuppliers(raw: unknown, grid: ForecastGrid, accounts: ForecastAccount[], supplierIds: ReadonlySet<string>): ValidatedSuppliers {
  const byCode = new Map(accounts.map((a) => [a.code, a]));
  if (!isPlainObject(raw)) return { ok: false, cell: 'suppliers', reason: 'suppliers must be an object keyed YYYY-MM' };
  const out: SupplierGrid = {};
  for (const month of Object.keys(raw).sort()) {
    if (!FORECAST_MONTH_RE.test(month)) return { ok: false, cell: month, reason: 'not a month (YYYY-MM)' };
    if (!Object.prototype.hasOwnProperty.call(grid, month)) return { ok: false, cell: month, reason: 'supplier figures for a month that is not on the grid' };
    const byAccount = raw[month];
    if (!isPlainObject(byAccount)) return { ok: false, cell: month, reason: 'a month holds an object of purchase accounts' };
    const clean: SupplierLines = {};
    for (const code of Object.keys(byAccount).sort()) {
      const acc = byCode.get(code);
      if (!acc) return { ok: false, cell: `${month} ${code}`, reason: 'not an account on the P&L' };
      if (!isPurchaseAccount(acc)) return { ok: false, cell: `${month} ${code}`, reason: 'only a purchase account is split by supplier' };
      const cells = byAccount[code];
      if (!isPlainObject(cells)) return { ok: false, cell: `${month} ${code}`, reason: 'an account holds an object of suppliers' };
      const kept: Record<string, ForecastCell> = {};
      for (const id of Object.keys(cells).sort()) {
        if (id !== OTHER_SUPPLIER && !supplierIds.has(id)) return { ok: false, cell: `${month} ${code} ${id}`, reason: 'not a supplier of this company' };
        const c = checkCell(cells[id], false);
        if (!c.ok) return { ok: false, cell: c.field ? supplierCellLabel(month, code, id, c.field) : `${month} ${code} ${id}`, reason: c.reason };
        kept[id] = c.cell;
      }
      if (Object.keys(kept).length > 0) clean[code] = kept;
    }
    if (Object.keys(clean).length > 0) out[month] = clean;
  }
  return { ok: true, suppliers: out };
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

const round = (v: number): number => Math.sign(v) * Math.round(Math.abs(v));

/** One supplier's figure under a purchase line, worked out as the line's own cell would be. */
export type SupplierFigure = {
  supplierId: string;
  amountSen: number;
  bp: number | null;
  keyed: 'amount' | 'percent';
};

export type ForecastLine = {
  code: string; name: string; section: string; block: ForecastBlockKey;
  amountSen: number;
  bp: number | null;
  basisSen: number;
  keyed: 'amount' | 'percent' | 'suppliers';
  bySupplier: SupplierFigure[];
};
export type ForecastTotals = {
  tradingIncomeSen: number; costOfSalesSen: number; grossProfitSen: number; otherIncomeSen: number;
  expensesSen: number; profitBeforeTaxSen: number; taxationSen: number; netProfitSen: number;
};
export type ForecastFigures = { salesSen: number; lines: ForecastLine[]; totals: ForecastTotals };

/** What a line's percentage is OF: the keyed amounts on the sales lines its
    account is bound to (a purchase line's own group's sales — a line whose
    group sold nothing this month has a zero basis, so its % is of nothing),
    else the month's whole forecast sales. */
export function basisSalesSen(lines: ForecastLines, account: ForecastAccount, salesSen: number): number {
  if (!account.basis || account.basis.length === 0) return salesSen;
  let sum = 0;
  for (const code of account.basis) {
    const c = cellOf(lines, code);
    if (c && isAmountCell(c)) sum += c.amtSen;
  }
  return sum;
}

const workOut = (c: ForecastCell, basisSen: number): { amountSen: number; bp: number | null; keyed: 'amount' | 'percent' } => (isAmountCell(c)
  ? { amountSen: c.amtSen, bp: basisSen !== 0 ? round((c.amtSen / basisSen) * 10000) : null, keyed: 'amount' }
  : { amountSen: round((basisSen * c.bp) / 10000), bp: c.bp, keyed: 'percent' });

/** The suppliers keyed under a line this month, worked out against the line's
    basis, by supplier id with Other last; none for a line that is not a
    purchase account (its supplier figures count nowhere). */
export function supplierFigures(suppliers: SupplierLines, account: ForecastAccount, basisSen: number): SupplierFigure[] {
  if (!isPurchaseAccount(account) || !Object.prototype.hasOwnProperty.call(suppliers, account.code)) return [];
  const cells = suppliers[account.code] ?? {};
  return Object.keys(cells)
    .sort((x, y) => (x === OTHER_SUPPLIER ? 1 : y === OTHER_SUPPLIER ? -1 : x < y ? -1 : x > y ? 1 : 0))
    .map((id) => ({ supplierId: id, ...workOut(cells[id]!, basisSen) }));
}

/** One month's figures: every keyed line's amount and share, and the P&L's
    totals over them. A purchase line with supplier figures this month is
    their sum; its own cell is superseded. Every reader — the page, the
    figures door, the Dashboard — passes the month's supplier figures, so all
    of them read the same totals. */
export function monthFigures(lines: ForecastLines, suppliers: SupplierLines, accounts: ForecastAccount[]): ForecastFigures {
  const salesSen = forecastSalesSen(lines, accounts);
  const out: ForecastLine[] = [];
  for (const a of accounts) {
    const block = blockOfSection(a.section);
    if (!block) continue;
    const basisSen = basisSalesSen(lines, a, salesSen);
    const bySupplier = supplierFigures(suppliers, a, basisSen);
    if (bySupplier.length > 0) {
      const amountSen = bySupplier.reduce((s, f) => s + f.amountSen, 0);
      out.push({ code: a.code, name: a.name, section: a.section, block, amountSen, bp: basisSen !== 0 ? round((amountSen / basisSen) * 10000) : null, basisSen, keyed: 'suppliers', bySupplier });
      continue;
    }
    const c = cellOf(lines, a.code);
    if (!c) continue;
    out.push({ code: a.code, name: a.name, section: a.section, block, ...workOut(c, basisSen), basisSen, bySupplier: [] });
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

/** The same for the supplier figures: each supplier's percentage carries over,
    its amount starts blank; an account left with no supplier is not there. */
export function inheritSuppliers(prev: SupplierLines | undefined): SupplierLines {
  const next: SupplierLines = {};
  for (const [code, cells] of Object.entries(prev ?? {})) {
    const kept: Record<string, ForecastCell> = {};
    for (const [id, c] of Object.entries(cells)) if (!isAmountCell(c)) kept[id] = { bp: c.bp };
    if (Object.keys(kept).length > 0) next[code] = kept;
  }
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
