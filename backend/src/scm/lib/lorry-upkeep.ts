// ----------------------------------------------------------------------------
// lorry-upkeep — each lorry's repair & maintenance cost, from the books (owner
// 2026-11-25: 「我要看到的就是每辆lorry的维修成本，做成一个报表」). Every account the
// chart puts on the Logistics P&L's Upkeep row is one lorry (UPKEEP OF LORI -
// VNB 9058), and every bill on it counts in the months the P&L spreads it over,
// so the lorries add up to the P&L's Upkeep Cost.
// A bill whose description names another of our plates is flagged, never moved:
// the books decide which lorry a bill is, and Finance corrects the posting.
// PURE.
// ----------------------------------------------------------------------------

import { monthOf, share } from './logistics-cost';
import { addMonths, type SpreadRow } from './logistics-pnl';
import { normalizePlate } from './plate-normalize';

export type UpkeepBill = {
  lineId: string; day: string;
  /** The PV or JV that posted it; the journal entry's number when the ledger names none. */
  docNo: string | null;
  notes: string | null;
  amountSen: number;
  /** How many months the P&L spreads it over. */
  months: number;
  /** Its part in each month shown. */
  byMonth: Record<string, number>;
  /** Another plate its description names when it names none of its account's own. */
  otherPlate: string | null;
};

export type UpkeepLorry = {
  accountCode: string; accountName: string | null;
  /** The plate the account's name ends on, canonical; null when it names none. */
  plate: string | null;
  /** One of our lorries in the lorry master. */
  ours: boolean;
  byMonth: Record<string, number>;
  totalSen: number;
  bills: UpkeepBill[];
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

/** Each upkeep account as a lorry: its bills over the months shown. An account
 *  shows when money falls in them, or when it is one of our lorries. */
export function lorryUpkeep(input: {
  rows: readonly SpreadRow[];
  range: readonly string[];
  accounts: ReadonlyArray<{ code: string; name: string | null }>;
  ourPlates: ReadonlySet<string>;
}): UpkeepLorry[] {
  const inRange = new Set(input.range);
  const nameOf = new Map(input.accounts.map((a) => [a.code, a.name] as const));
  const rows = input.rows.filter((r) => r.kind === 'upkeep');
  for (const r of rows) if (!nameOf.has(r.accountCode)) nameOf.set(r.accountCode, r.accountName);
  const plateOf = new Map([...nameOf].map(([code, name]) => [code, plateOfAccountName(name)] as const));
  const known = [...new Set([...plateOf.values(), ...input.ourPlates].filter((p): p is string => !!p))];

  const out: UpkeepLorry[] = [];
  for (const [code, name] of nameOf) {
    const plate = plateOf.get(code) ?? null;
    const ours = plate != null && input.ourPlates.has(plate);
    const byMonth: Record<string, number> = {};
    const bills: UpkeepBill[] = rows.filter((r) => r.accountCode === code).map((r) => {
      const mine: Record<string, number> = {};
      share(r.amountSen, r.months).forEach((part, i) => {
        const m = addMonths(monthOf(r.day), i);
        if (!inRange.has(m)) return;
        mine[m] = (mine[m] ?? 0) + part;
        byMonth[m] = (byMonth[m] ?? 0) + part;
      });
      const named = platesNamed(r.notes, known);
      const otherPlate = plate && named.length > 0 && !named.includes(plate) ? named[0]! : null;
      return { lineId: r.lineId, day: r.day, docNo: r.sourceDocNo ?? r.docNo, notes: r.notes, amountSen: r.amountSen, months: r.months, byMonth: mine, otherPlate };
    });
    const totalSen = Object.values(byMonth).reduce((t, v) => t + v, 0);
    if (bills.length === 0 && !ours) continue;
    bills.sort((a, b) => a.day.localeCompare(b.day) || a.lineId.localeCompare(b.lineId));
    out.push({ accountCode: code, accountName: name, plate, ours, byMonth, totalSen, bills });
  }
  /* Our lorries by plate, then any other upkeep account by its code. */
  return out.sort((a, b) => Number(b.ours) - Number(a.ours) || (a.plate ?? '').localeCompare(b.plate ?? '') || a.accountCode.localeCompare(b.accountCode));
}
