// ----------------------------------------------------------------------------
// lorry-spend — what each of our lorries costs, from the books (owner
// 2026-11-25: 「我应该要的是每一辆lorry的spend，就是包括petrol，tol，等等」, after
// the repairs-only view). Every line the Logistics P&L counts in an in-house row
// (petrol, toll & parking; upkeep; HP instalment; road tax & insurance; other
// lorry cost; manpower) goes to the lorry its account names (PETROL ... - LORI
// VNB 9058, HP CREDITOR - VNB 9058), else to the lorry its description names
// (INSURANCE FOR VNB 9058), else to Not tied to a lorry (driver pay). Upkeep and
// road tax & insurance count in the months the P&L spreads them over, so the
// lorries and Not tied add up to the P&L's Total In-house Expenses.
// A line on a lorry's account whose description names only another of our plates
// is flagged, never moved: the books decide, Finance corrects the posting.
// PURE.
// ----------------------------------------------------------------------------

import { monthOf, share } from './logistics-cost';
import { addMonths, type InHouseLine, type SpreadRow } from './logistics-pnl';
import { normalizePlate } from './plate-normalize';

export type SpendKind = 'petrol' | 'upkeep' | 'instalment' | 'roadtax' | 'other' | 'manpower';

export type SpendLine = {
  lineId: string; kind: SpendKind; accountCode: string; day: string;
  /** The PV or JV that posted it; the journal entry's number when the ledger names none. */
  docNo: string | null;
  notes: string | null;
  amountSen: number;
  /** How many months the P&L spreads it over (1 for a line it does not spread). */
  months: number;
  /** Its part in each month shown, as the P&L counts it. */
  byMonth: Record<string, number>;
  /** Another plate its description names when it names none of its account's own. */
  otherPlate: string | null;
};

export type LorrySpend = {
  /** Canonical plate; null = the lines that name no lorry. */
  plate: string | null;
  /** One of our lorries in the lorry master. */
  ours: boolean;
  lines: SpendLine[];
  byMonth: Record<string, number>;
  totalSen: number;
};

const PLATE_IN_NAME = /\b([A-Z]{1,3})\s*-?\s*([1-9]\d{0,3})\b/g;

/** The plate an account's name ends on: "UPKEEP OF LORI - VNB 9058" → VNB9058. */
export function plateOfAccountName(name: string | null | undefined): string | null {
  let last: string | null = null;
  for (const m of String(name ?? '').toUpperCase().matchAll(PLATE_IN_NAME)) last = `${m[1]}${m[2]}`;
  return last;
}

/** The known plates a text names, spaced or not ("VNB 9058" and "VNB9058"). */
export function platesNamed(text: string | null | undefined, known: readonly string[]): string[] {
  const flat = normalizePlate(text);
  return flat ? known.filter((p) => flat.includes(p)) : [];
}

/** Each lorry's in-house lines over the months shown; our lorries show at zero too. */
export function lorrySpend(input: {
  lines: readonly InHouseLine[];
  spreads: readonly SpreadRow[];
  range: readonly string[];
  /** The chart's account names (where a lorry account names its plate); a line's own name when absent. */
  accountNames: ReadonlyMap<string, string | null>;
  ourPlates: ReadonlySet<string>;
}): LorrySpend[] {
  const inRange = new Set(input.range);
  type Raw = { lineId: string; kind: SpendKind; accountCode: string; accountName: string | null; day: string; docNo: string | null; sourceDocNo?: string | null; notes: string | null; amountSen: number; months: number };
  const raw: Raw[] = [
    ...input.lines.map((l) => ({ ...l, months: 1 })),
    ...input.spreads.map((r) => ({
      lineId: r.lineId, kind: r.kind, accountCode: r.accountCode, accountName: r.accountName, day: r.day,
      docNo: r.docNo, sourceDocNo: r.sourceDocNo, notes: r.notes, amountSen: r.amountSen, months: r.months,
    })),
  ];
  const plateOfAccount = (r: Raw) => plateOfAccountName(input.accountNames.get(r.accountCode) ?? r.accountName);
  const known = [...new Set([...raw.map(plateOfAccount), ...input.ourPlates].filter((p): p is string => !!p))];

  const byPlate = new Map<string, LorrySpend>();
  const entryOf = (plate: string | null): LorrySpend => {
    const key = plate ?? '';
    let e = byPlate.get(key);
    if (!e) {
      e = { plate, ours: plate != null && input.ourPlates.has(plate), lines: [], byMonth: {}, totalSen: 0 };
      byPlate.set(key, e);
    }
    return e;
  };
  for (const p of input.ourPlates) entryOf(p);

  for (const r of raw) {
    const own = plateOfAccount(r);
    const named = platesNamed(r.notes, known);
    const plate = own ?? named.at(0) ?? null;
    const mine: Record<string, number> = {};
    share(r.amountSen, r.months).forEach((part, i) => {
      const m = addMonths(monthOf(r.day), i);
      if (inRange.has(m)) mine[m] = (mine[m] ?? 0) + part;
    });
    const e = entryOf(plate);
    for (const [m, v] of Object.entries(mine)) { e.byMonth[m] = (e.byMonth[m] ?? 0) + v; e.totalSen += v; }
    e.lines.push({
      lineId: r.lineId, kind: r.kind, accountCode: r.accountCode, day: r.day, docNo: r.sourceDocNo ?? r.docNo, notes: r.notes,
      amountSen: r.amountSen, months: r.months, byMonth: mine,
      otherPlate: own && named.length > 0 && !named.includes(own) ? named[0]! : null,
    });
  }
  for (const e of byPlate.values()) e.lines.sort((x, y) => x.day.localeCompare(y.day) || x.lineId.localeCompare(y.lineId));
  /* Our lorries by plate, then any other plate, then the lines that name no lorry. */
  const rank = (e: LorrySpend) => (e.plate == null ? 2 : e.ours ? 0 : 1);
  return [...byPlate.values()].sort((a, b) => rank(a) - rank(b) || (a.plate ?? '').localeCompare(b.plate ?? ''));
}
