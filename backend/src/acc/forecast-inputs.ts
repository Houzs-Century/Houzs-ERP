// ----------------------------------------------------------------------------
// forecast-inputs — the Cash Flow's Capex & financing table (step 3 of the
// Hookka forecast port, docs/forecast-port-spec.md part 2; Hookka
// `keyableAccounts`, `cleanKeyedInputs`, `keyedInputGroups`).
//
// Finance keys money it plans to move outside the trading cycle — capex, loans
// and hire purchase, related-party and director loans, deposits, fixed
// deposits, shareholder funds — per account and month: + money in, − money
// out, whole sen. The accounts offered are the ones the Cash Flow layout places
// under FUNDING IN / (OUT) (`cf:funding`), trade finance aside (its plan is
// step 5), each active leaf once, an accumulated depreciation or amortisation
// account never. A keyed amount becomes forecast money on its own account in
// its own month — the Cash Flow's forecast column, wherever that month shows.
// Pure: no reads.
// ----------------------------------------------------------------------------

import type { LayoutItem } from './report-layout';
import type { CashLeg } from './cashflow-pnl-forecast';

/** The Cash Flow layout's funding block and, inside it, the trade-finance categories left to step 5. */
export const FUNDING_CATEGORY = 'cf:funding';
export const TRADE_FINANCE_CATEGORY = 'cf:funding:tf';
/** Who a keyed amount comes from, in the forecast's entries. */
export const KEYED_PARTY = 'Keyed on Cash Flow (Capex & financing)';
/** How many months the table offers, from the current month. */
export const KEYED_MONTHS = 12;

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const NOT_KEYABLE_NAME = /DEPRN|DEPRECIATION|AMORTI[SZ]ATION/i;

export type KeyableAccount = { code: string; name: string; group: { id: string; label: string } };

/** The accounts the table offers, in the layout's order: each active leaf the
    funding block places, once — grouped by the categories that place it (a
    loan sits under its drawdown and its repayment: one row, both names) — and
    in code order within its group. `chart`: the company's active leaf accounts. */
export function keyableAccounts(tree: readonly LayoutItem[], chart: ReadonlyMap<string, string>): KeyableAccount[] {
  const top = tree.find((it) => it.kind === 'category' && it.id === FUNDING_CATEGORY);
  if (!top || top.kind !== 'category') return [];
  const placedIn = new Map<string, Array<{ id: string; label: string }>>();
  const walk = (items: readonly LayoutItem[], at: { id: string; label: string }): void => {
    for (const it of items) {
      if (it.kind === 'subtotal') continue;
      if (it.kind === 'account') {
        const list = placedIn.get(it.code) ?? [];
        if (!list.some((c) => c.id === at.id)) list.push(at);
        placedIn.set(it.code, list);
        continue;
      }
      if (it.id === TRADE_FINANCE_CATEGORY || it.id.startsWith(`${TRADE_FINANCE_CATEGORY}:`)) continue;
      const here = { id: it.id, label: it.label };
      if (it.code) walk([{ kind: 'account', code: it.code }], here);
      walk(it.children, here);
    }
  };
  walk(top.children, { id: top.id, label: top.label });
  const groups = new Map<string, { label: string; rows: KeyableAccount[] }>();
  for (const [code, cats] of placedIn) {
    const name = chart.get(code);
    if (name === undefined || NOT_KEYABLE_NAME.test(name)) continue;
    const id = cats.map((c) => c.id).join('+');
    const group = groups.get(id) ?? { label: cats.map((c) => c.label).join(' / '), rows: [] };
    group.rows.push({ code, name, group: { id, label: group.label } });
    groups.set(id, group);
  }
  return [...groups.values()].flatMap((g) => g.rows.sort((a, b) => a.code.localeCompare(b.code)));
}

/** 'YYYY-MM' → account code → whole sen, + money in, − money out. A zero is never kept. */
export type KeyedInputs = Record<string, Record<string, number>>;

export type ValidatedInputs = { ok: true; months: KeyedInputs } | { ok: false; cell: string; reason: string };

/** The table as the page sends it, the whole map: a month key, an offered
    account, a whole number of sen; a zero is dropped, a month left empty goes.
    The first bad cell is named and nothing is kept. */
export function validateKeyedInputs(raw: unknown, offered: ReadonlySet<string>): ValidatedInputs {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, cell: 'months', reason: 'months must be an object keyed YYYY-MM' };
  const months: KeyedInputs = {};
  for (const ym of Object.keys(raw).sort()) {
    if (!MONTH_RE.test(ym)) return { ok: false, cell: ym, reason: 'not a month (YYYY-MM)' };
    const cells = (raw as Record<string, unknown>)[ym];
    if (cells === null || typeof cells !== 'object' || Array.isArray(cells)) return { ok: false, cell: ym, reason: 'a month holds an object of accounts' };
    for (const code of Object.keys(cells).sort()) {
      const v = (cells as Record<string, unknown>)[code];
      if (typeof v !== 'number' || !Number.isSafeInteger(v)) return { ok: false, cell: `${ym} ${code}`, reason: 'an amount is a whole number of sen' };
      if (v === 0) continue;
      if (!offered.has(code)) return { ok: false, cell: `${ym} ${code}`, reason: 'not a capex or financing account on the Cash Flow layout — clear it first' };
      (months[ym] ??= {})[code] = v;
    }
  }
  return { ok: true, months };
}

/** The keyed amounts as forecast money on their own accounts: + in, − out. */
export function keyedInputLegs(inputs: KeyedInputs, nameOf: (code: string) => string): CashLeg[] {
  const legs: CashLeg[] = [];
  for (const ym of Object.keys(inputs).sort()) {
    for (const [code, sen] of Object.entries(inputs[ym] ?? {})) {
      if (!sen) continue;
      legs.push({
        ym, fromYm: ym, source: 'input', flow: sen > 0 ? 'in' : 'out', code, key: code, name: nameOf(code), sen: Math.abs(sen),
        party: KEYED_PARTY, note: 'Keyed on the Cash Flow · forecast only, nothing posted',
      });
    }
  }
  return legs;
}

/** The accounts keyed in some month that the table no longer offers (the layout moved them): shown to be cleared. */
export function keyedNotOffered(inputs: KeyedInputs, offered: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  for (const cells of Object.values(inputs)) for (const code of Object.keys(cells)) if (!offered.has(code)) out.add(code);
  return [...out].sort();
}
