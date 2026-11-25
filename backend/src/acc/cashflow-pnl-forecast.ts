// ----------------------------------------------------------------------------
// cashflow-pnl-forecast — the Forecast P&L as cash, month by month: the Cash
// Flow's "P&L forecast" column (step 2 of the Hookka forecast port,
// docs/forecast-port-spec.md part 1, Hookka `buildPnlForecastLegs`).
//
// Each forecast month's figures (scm/shared/forecast-pnl monthFigures — the
// page's own, the supplier split included) become money moving in the month
// it is expected:
//   · sales arrive by the last 3 complete months' customer receipts measured
//     against their order month, each as a Deposit or a Settlement (owner
//     2026-11-24, D2: the deposit counts in the order month, the balance
//     follows delivery; every customer COD, D1) — on the debtor control;
//   · a purchase line split by supplier pays each supplier after its own
//     payment term (Other, and a supplier without a usable term, a month
//     later — owner 2026-11-24: he fills the terms in); a purchase line keyed
//     whole pays by its own recent suppliers' terms, weighted by what each
//     billed it;
//   · salaries — the P&L layout's Salary & related lines — the month after
//     (they are accrued at month end and paid the next month);
//   · every other cost, other income and taxation in its own month;
//   · non-cash lines (depreciation, amortisation, write-offs, stock) are left
//     out and named.
// A leg names the account the Cash Flow places it on, so the forecast lands on
// the same line of the same tree as the actual money. Pure: no reads.
// ----------------------------------------------------------------------------

import { shareByWeight } from './product-profit';
import {
  OTHER_SUPPLIER, blockOfSection, isPurchaseAccount, monthFigures,
  type ForecastAccount, type ForecastGrid, type SupplierGrid,
} from '../scm/shared/forecast-pnl';

export type TermInfo = { months: number; flagged: boolean };

/** A supplier's payment term → whole months after the bill. The supplier
    page's own choices: COD, Advance Payment and the two split terms (50/50,
    30/70 — the deposit before, the rest on delivery) are the same month;
    NET n and "n days" round n / 30; "n months" is n. Blank or anything else
    is a month later and flagged, so the page can name it. */
export function parseTermMonths(raw: string | null): TermInfo {
  const s = String(raw ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (!s) return { months: 1, flagged: true };
  const compact = s.replace(/[.\s]/g, '');
  if (compact === 'COD' || compact === 'CASH' || compact === 'ADVANCEPAYMENT' || compact === '50/50' || compact === '30/70') return { months: 0, flagged: false };
  let m = /^NET ?(\d{1,3})$/.exec(s);
  if (m) return { months: Math.round(Number(m[1]) / 30), flagged: false };
  m = /^(\d{1,3}) ?DAYS?$/.exec(s);
  if (m) return { months: Math.round(Number(m[1]) / 30), flagged: false };
  m = /^(\d{1,2}) ?MONTHS?$/.exec(s);
  if (m) return { months: Number(m[1]), flagged: false };
  return { months: 1, flagged: true };
}

/** "2026-11" + 2 → "2027-01". */
export function addMonthsYm(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}

/** Whole months from `from` to `to` (both YYYY-MM), negative when `to` is earlier. */
export function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number) as [number, number];
  const [ty, tm] = to.split('-').map(Number) as [number, number];
  return (ty - fy) * 12 + (tm - fm);
}

/** The window the timings are measured over: the 3 complete months before today's. */
export function measuredWindow(today: string): { from: string; to: string } {
  const current = today.slice(0, 7);
  const last = addMonthsYm(current, -1);
  const [y, m] = last.split('-').map(Number) as [number, number];
  const end = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${addMonthsYm(current, -3)}-01`, to: `${last}-${String(end).padStart(2, '0')}` };
}

/** Shares of money and the delay each comes with, in whole months. */
export type TermMix = Array<{ months: number; weight: number }>;

/** A mix from (delay, amount) pairs, shortest delay first; nothing to go by =
    everything a month later. */
export function termMixOf(rows: Iterable<{ months: number; sen: number }>): TermMix {
  const by = new Map<number, number>();
  for (const r of rows) if (r.sen > 0 && Number.isInteger(r.months) && r.months >= 0) by.set(r.months, (by.get(r.months) ?? 0) + r.sen);
  const mix = [...by.entries()].sort(([a], [b]) => a - b).map(([months, weight]) => ({ months, weight }));
  return mix.length > 0 ? mix : [{ months: 1, weight: 1 }];
}

export type ReceiptKind = 'DEP' | 'BAL';
/** The customers' money by kind and delay after the order month. */
export type ReceiptMix = Array<{ kind: ReceiptKind; months: number; weight: number }>;

/** The receipts mix from (kind, delay, amount) rows; a delay before the order
    month counts as the order month. Nothing to go by = everything in the
    order month as a deposit (every customer COD, D1). */
export function receiptMixOf(rows: Iterable<{ kind: ReceiptKind; months: number; sen: number }>): ReceiptMix {
  const by = new Map<string, { kind: ReceiptKind; months: number; weight: number }>();
  for (const r of rows) {
    if (!(r.sen > 0) || !Number.isInteger(r.months)) continue;
    const months = Math.max(0, r.months);
    const k = `${r.kind}:${months}`;
    const at = by.get(k) ?? { kind: r.kind, months, weight: 0 };
    at.weight += r.sen;
    by.set(k, at);
  }
  const mix = [...by.values()].sort((a, b) => a.months - b.months || (a.kind === b.kind ? 0 : a.kind === 'DEP' ? -1 : 1));
  return mix.length > 0 ? mix : [{ kind: 'DEP', months: 0, weight: 1 }];
}

/** An amount in whole sen spread over weights; the parts add back to it exactly. */
export function spreadSen<T extends { weight: number }>(sen: number, mix: T[]): Array<T & { sen: number }> {
  const parts = shareByWeight(sen, mix.map((m) => m.weight));
  return mix.map((m, i) => ({ ...m, sen: parts[i] ?? 0 })).filter((p) => p.sen !== 0);
}

/** Lines whose P&L amount moves no cash. */
export const isNonCashName = (name: string): boolean => /DEPRECIATION|AMORTI[SZ]ATION|WRITTEN OFF|WRITE[- ]?OFF|\bSTOCKS?\b/i.test(name);

/** One forecast money movement, on the account the Cash Flow places it on. */
export type CashLeg = {
  /** The month the money moves (YYYY-MM). */
  ym: string;
  /** The forecast month it comes from (an order's or a bill's own month). */
  fromYm: string;
  /** The document behind it: an order's or a bill's number; none for the Forecast P&L or a keyed amount. */
  ref: string | null;
  /** The Forecast P&L, an amount keyed in the Capex & financing table, an open order, a supplier's bill, the trade-finance plan. */
  source: 'pnl' | 'input' | 'order' | 'bill' | 'tf';
  flow: 'in' | 'out';
  /** The account it lands on, and the row's own key (the code, or the debtor control's kind row). */
  code: string;
  key: string;
  /** The row's name: the account's, or the debtor control's forecast row. */
  name: string;
  /** Under the debtor control: Deposit or Settlement, as the actual money prints. */
  group?: { id: ReceiptKind; label: string };
  /** Signed for the flow: money in on an In leg, out on an Out leg. */
  sen: number;
  /** Who: the supplier, "Forecast sales", or the line itself. */
  party: string;
  /** How it was timed. */
  note: string;
};

/** The debtor control's forecast row, under its Deposit and its Settlement. */
export const FORECAST_ROW_NAME = 'Forecast sales';
const KIND_LABEL: Record<ReceiptKind, string> = { DEP: 'Deposit', BAL: 'Settlement' };

export type PnlCashInput = {
  grid: ForecastGrid;
  suppliers: SupplierGrid;
  accounts: ForecastAccount[];
  /** The debtor control: where the customers' money lands. */
  arCode: string;
  receiptMix: ReceiptMix;
  /** A purchase line keyed whole: its recent suppliers' terms, weighted by what each billed it. */
  purchaseMix: (code: string) => TermMix;
  /** A supplier's term in months (flagged when it has none usable) and its name. */
  supplierTerm: (id: string) => TermInfo;
  supplierName: (id: string) => string;
  /** The P&L layout's Salary & related accounts: paid the month after. */
  salaryCodes: ReadonlySet<string>;
};

const monthWords = (n: number): string => (n === 0 ? 'the same month' : n === 1 ? 'a month later' : `${n} months later`);
const monthTitle = (ym: string): string =>
  new Date(`${ym}-01T00:00:00Z`).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

/** Every stored forecast month as cash legs, with the lines left out as
    non-cash and the suppliers timed a month later for want of a term. */
export function buildPnlCashLegs(input: PnlCashInput): { legs: CashLeg[]; nonCash: Array<{ code: string; name: string }>; flagged: string[] } {
  const legs: CashLeg[] = [];
  const nonCash = new Map<string, string>();
  const flagged = new Set<string>();
  const byCode = new Map(input.accounts.map((a) => [a.code, a]));
  for (const S of Object.keys(input.grid).sort()) {
    const f = monthFigures(input.grid[S] ?? {}, input.suppliers[S] ?? {}, input.accounts);
    const from = `${monthTitle(S)} Forecast P&L`;
    /* Sales: by the receipts mix, each part a Deposit or a Settlement on the debtor control. */
    for (const p of spreadSen(f.salesSen, input.receiptMix)) {
      legs.push({
        ym: addMonthsYm(S, p.months), fromYm: S, ref: null, source: 'pnl', flow: 'in', code: input.arCode, key: `${input.arCode}:${p.kind}:FC`, name: FORECAST_ROW_NAME,
        group: { id: p.kind, label: KIND_LABEL[p.kind] }, sen: p.sen, party: 'Forecast sales',
        note: `${from} sales · ${KIND_LABEL[p.kind].toLowerCase()} · ${monthWords(p.months)} after the order month`,
      });
    }
    for (const l of f.lines) {
      if (l.block === 'tradingIncome' || l.amountSen === 0) continue;
      const a = byCode.get(l.code);
      if (!a) continue;
      const leg = (ym: string, sen: number, party: string, note: string): void => {
        if (sen === 0) return;
        legs.push({ ym, fromYm: S, ref: null, source: 'pnl', flow: l.block === 'otherIncome' ? 'in' : 'out', code: l.code, key: l.code, name: l.name, sen, party, note });
      };
      if (blockOfSection(a.section) === 'costOfSales' && isPurchaseAccount(a)) {
        if (l.keyed === 'suppliers') {
          for (const s of l.bySupplier) {
            const other = s.supplierId === OTHER_SUPPLIER;
            const term = other ? { months: 1, flagged: false } : input.supplierTerm(s.supplierId);
            if (term.flagged) flagged.add(s.supplierId);
            const ym = addMonthsYm(S, term.months);
            leg(ym, s.amountSen, other ? 'Other (new suppliers)' : input.supplierName(s.supplierId),
              `${from} · ${other ? 'Other' : 'the supplier'} pays ${monthWords(term.months)}${term.flagged ? ' (no payment term set)' : ''}`);
          }
          continue;
        }
        for (const p of spreadSen(l.amountSen, input.purchaseMix(l.code))) {
          leg(addMonthsYm(S, p.months), p.sen, l.name, `${from} · ${monthWords(p.months)} (its recent suppliers' terms)`);
        }
        continue;
      }
      if (isNonCashName(l.name)) { nonCash.set(l.code, l.name); continue; }
      if (l.block === 'expenses' && input.salaryCodes.has(l.code)) {
        leg(addMonthsYm(S, 1), l.amountSen, l.name, `${from} · paid the month after`);
        continue;
      }
      leg(S, l.amountSen, l.name, from);
    }
  }
  return {
    legs,
    nonCash: [...nonCash].map(([code, name]) => ({ code, name })).sort((x, y) => x.code.localeCompare(y.code)),
    flagged: [...flagged].sort(),
  };
}

/** The months a forecast column shows: the range asked, then — when it
    reaches the current month — every later month the legs reach, at most a
    year past the current month. A month after the current one is `future`. */
export const FORECAST_MONTHS_AHEAD = 12;
export function forecastMonths(from: string, to: string, currentYm: string, legs: readonly CashLeg[]): Array<{ month: string; future: boolean }> {
  const out: Array<{ month: string; future: boolean }> = [];
  for (let ym = from; ym <= to; ym = addMonthsYm(ym, 1)) out.push({ month: ym, future: ym > currentYm });
  if (to < currentYm) return out;
  const cap = addMonthsYm(currentYm, FORECAST_MONTHS_AHEAD);
  let last = to;
  for (const l of legs) if (l.ym > last && l.ym <= cap) last = l.ym;
  for (let ym = addMonthsYm(to, 1); ym <= last; ym = addMonthsYm(ym, 1)) out.push({ month: ym, future: true });
  return out;
}
