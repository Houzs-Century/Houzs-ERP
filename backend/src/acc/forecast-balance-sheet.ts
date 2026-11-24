// ----------------------------------------------------------------------------
// forecast-balance-sheet — the Forecast Balance Sheet (step 6 of the Hookka
// forecast port, docs/forecast-port-spec.md part 4, Hookka `forecastBsDeltas`;
// owner 2026-11-24 「开始做第 6 步」).
//
// From the last month-end's actual Balance Sheet, each month from the current
// one to the last the Forecast P&L has figures for moves it by double entries
// (debit-positive sen per account; every month adds up to zero):
//   · what the Forecast P&L month earns and spends before money moves: its
//     sales owed by customers (the debtor control), its purchases owed to
//     suppliers (the creditor control), its salaries owed (the salary accrual,
//     when the chart has one, paid the month after), its depreciation and the
//     like (beside the accumulated depreciation);
//   · the money as the Cash Flow's P&L forecast moves it: customers' money
//     settles the debtors, a purchase the creditors, a trade-finance drawdown
//     or repayment the facility, a Capex & financing amount its own account,
//     every other cost or income the profit — only from the Forecast P&L's
//     months from the current one, the books standing for the months before;
//   · what was open at the start: the bills the books owed, paid when due (past
//     due in the first month); the open orders' balances collected on delivery,
//     never beyond the debtors on the start sheet, the earliest dropped first
//     (D4: Houzs holds deposits as a customer credit, so its debtors are often
//     below zero and nothing is collected); the salaries owed, paid in the
//     first month.
// The profit lands on Current period earnings, the cash on a line of its own
// beside the bank accounts, the depreciation beside the accumulated
// depreciation; stock stays as at the start (periodic, provisional). Pure.
// ----------------------------------------------------------------------------

export const FC_CASH = 'FC-CASH';
export const FC_PROFIT = 'FC-PROFIT';
export const FC_DEPN = 'FC-DEPN';
export const FC_CASH_NAME = 'Forecast cash in / out (since the start)';
export const FC_DEPN_NAME = 'Forecast depreciation (since the start)';

/** What a Forecast P&L month earns and spends before money moves. */
export type Accrual = { salesSen: number; purchasesSen: number; salariesSen: number; depnSen: number };
/** Money moving: in = Dr cash / Cr `against`; out = Dr `against` / Cr cash. */
export type BsMove = { ym: string; sen: number; against: string; flow: 'in' | 'out' };

export type BsForecastInput = {
  /** Oldest first; the first is the current month. */
  months: readonly string[];
  accounts: { ar: string; ap: string; accrual: string | null };
  accruals: Readonly<Record<string, Accrual | undefined>>;
  /** The P&L forecast's money, the trade-finance plan, the Capex & financing table. */
  moves: readonly BsMove[];
  /** The bills the books owed at the start, by the month they are paid. */
  openingBills: ReadonlyArray<{ ym: string; sen: number }>;
  /** The open orders' balances to collect, already capped at the start's debtors. */
  openingReceipts: ReadonlyArray<{ ym: string; sen: number }>;
  /** The salary accrual's credit balance at the start. */
  openingSalarySen: number;
};

/** Month → account → debit-positive sen. */
export type BsDeltas = Record<string, Record<string, number>>;

export function bsDeltas(input: BsForecastInput): BsDeltas {
  const { months, accounts } = input;
  const inMonths = new Set(months);
  const out: BsDeltas = Object.fromEntries(months.map((ym) => [ym, {} as Record<string, number>]));
  const first = months[0] ?? '';
  const at = (ym: string): string => (ym < first ? first : ym);
  const post = (ym: string, debit: string, credit: string, sen: number): void => {
    const m = (out as Partial<BsDeltas>)[ym];
    if (!sen || !inMonths.has(ym) || !m) return;
    m[debit] = (m[debit] ?? 0) + sen;
    m[credit] = (m[credit] ?? 0) - sen;
  };
  for (const b of input.openingBills) post(at(b.ym), accounts.ap, FC_CASH, b.sen);
  for (const r of input.openingReceipts) post(at(r.ym), FC_CASH, accounts.ar, r.sen);
  if (accounts.accrual && input.openingSalarySen > 0) post(first, accounts.accrual, FC_CASH, input.openingSalarySen);
  months.forEach((ym, i) => {
    const a = input.accruals[ym];
    if (!a) return;
    post(ym, accounts.ar, FC_PROFIT, a.salesSen);
    post(ym, FC_PROFIT, accounts.ap, a.purchasesSen);
    if (accounts.accrual) {
      post(ym, FC_PROFIT, accounts.accrual, a.salariesSen);
      const next = months[i + 1];
      if (next) post(next, accounts.accrual, FC_CASH, a.salariesSen);
    }
    post(ym, FC_PROFIT, FC_DEPN, a.depnSen);
  });
  for (const m of input.moves) {
    if (m.flow === 'in') post(m.ym, FC_CASH, m.against, m.sen);
    else post(m.ym, m.against, FC_CASH, m.sen);
  }
  for (const m of Object.values(out)) for (const [code, sen] of Object.entries(m)) if (!sen) delete m[code];
  return out;
}

/** Customers' money to come at the start, never beyond the debtors on the
    start sheet: when it is more, the earliest months are dropped first. */
export function capReceipts(rows: ReadonlyArray<{ ym: string; sen: number }>, capSen: number): Array<{ ym: string; sen: number }> {
  if (capSen <= 0) return [];
  const by = new Map<string, number>();
  for (const r of rows) if (r.sen > 0) by.set(r.ym, (by.get(r.ym) ?? 0) + r.sen);
  const list = [...by].sort(([a], [b]) => a.localeCompare(b)).map(([ym, sen]) => ({ ym, sen }));
  let over = list.reduce((s, r) => s + r.sen, 0) - capSen;
  for (const r of list) {
    if (over <= 0) break;
    const take = Math.min(over, r.sen);
    r.sen -= take;
    over -= take;
  }
  return list.filter((r) => r.sen > 0);
}

/** The running total of each month's movements, month by month. */
export function cumulate(months: readonly string[], deltas: BsDeltas): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  let run: Record<string, number> = {};
  for (const ym of months) {
    run = { ...run };
    for (const [code, sen] of Object.entries(deltas[ym] ?? {})) run[code] = (run[code] ?? 0) + sen;
    out[ym] = run;
  }
  return out;
}

export type SheetLine = { code: string; name: string; section: string; amountSen: number; key?: string; label?: string };
export type Side = 'assets' | 'liabilities' | 'equity';
export type StartSheet = { assets: SheetLine[]; liabilities: SheetLine[]; equity: SheetLine[]; earningsSen: number };

/** A forecast month's sheet: the start's lines moved by the movements so far —
    an asset up by a debit, a liability or equity up by a credit; an account new
    to the sheet takes its side, name and section from the chart; the forecast
    cash and depreciation on lines of their own, filed beside the account they
    sit by; the profit on the earnings. */
export function forecastSheet(
  start: StartSheet,
  moved: Readonly<Record<string, number>>,
  chartOf: (code: string) => { name: string; side: Side; section: string } | null,
  anchors: { cash: { code: string; section: string } | null; depn: { code: string; section: string } | null },
): StartSheet {
  const sides: Record<Side, SheetLine[]> = {
    assets: start.assets.map((l) => ({ ...l })), liabilities: start.liabilities.map((l) => ({ ...l })), equity: start.equity.map((l) => ({ ...l })),
  };
  const sign: Record<Side, number> = { assets: 1, liabilities: -1, equity: -1 };
  const find = (code: string): { side: Side; line: SheetLine } | null => {
    for (const side of ['assets', 'liabilities', 'equity'] as const) {
      const line = sides[side].find((l) => l.code === code && l.key == null);
      if (line) return { side, line };
    }
    return null;
  };
  for (const [code, sen] of Object.entries(moved)) {
    if (!sen || code === FC_PROFIT) continue;
    if (code === FC_CASH || code === FC_DEPN) {
      const anchor = code === FC_CASH ? anchors.cash : anchors.depn;
      const name = code === FC_CASH ? FC_CASH_NAME : FC_DEPN_NAME;
      sides.assets.push({ code: anchor?.code ?? code, key: code, name, label: name, section: anchor?.section ?? (code === FC_CASH ? 'CURRENT ASSETS' : 'FIXED ASSETS'), amountSen: sen });
      continue;
    }
    const hit = find(code);
    if (hit) { hit.line.amountSen += sign[hit.side] * sen; continue; }
    const c = chartOf(code);
    const side: Side = c?.side ?? 'assets';
    sides[side].push({ code, name: c?.name ?? code, section: c?.section ?? 'CURRENT ASSETS', amountSen: sign[side] * sen });
  }
  const keep = (ls: SheetLine[]): SheetLine[] => ls.filter((l) => l.amountSen !== 0);
  return { assets: keep(sides.assets), liabilities: keep(sides.liabilities), equity: keep(sides.equity), earningsSen: start.earningsSen - (moved[FC_PROFIT] ?? 0) };
}
