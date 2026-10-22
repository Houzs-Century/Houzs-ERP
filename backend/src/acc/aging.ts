// ----------------------------------------------------------------------------
// aging — the formal debtor and creditor aging (owner 2026-10-02: 「现在的 aging
// 没有那种正式 account 的 debtor & creditor aging」).
//
// What makes it formal, as the owner settled it the same day:
//   B1/B2  columns by the invoice's MONTH as at the chosen date — 本月, 1, 2, 3,
//          4 个月以上 (「跟发票的月份」) — with a switch to days (0–30 … 120+) and
//          to the due date;
//   B3a    money not tied to an invoice — a customer's deposit on an order not
//          invoiced yet, a supplier advance, a credit note not knocked off — sits
//          in its own column, 未冲, never spent against the oldest bill;
//   B4     it replaces AR Aging and AP Aging, under the same names.
// And every party's balance is its balance in the books: the report is built
// from the control accounts' own lines as at the date (acc/party-ledger.ts), so
// its total IS the control accounts' balance — the footer prints both.
//
// How a line finds what it pays or is paid by — one rule, GROUPS:
//   every line is put in a group; inside a group the money against (credits on
//   AR, debits on AP) knocks off the group's bills oldest first, and what is
//   left of it is 未冲. What a group is decides everything:
//   AR  the sales ORDER the line belongs to — its payments, invoice, deposit
//       invoices, credit notes, conversions and refunds — so an order's money
//       pays the order's own invoices (the rule the AR Invoices list already
//       uses for order deposits) and a deposit on an order not invoiced yet is
//       未冲. An Other Debtor bill is its own group; a receipt's allocation to
//       it joins it, the rest of the receipt is 未冲.
//   AP  the INVOICE: an AP Payment's ticks, an advance applied, a supplier
//       credit note's knock-offs each join the invoice they were applied to,
//       from their own date; the rest of a payment or credit note is 未冲.
// A line nothing names is its own group — a bill if it is owed, 未冲 if it is
// money against. Pure: scm/routes/accounting-aging.ts loads, this decides.
// ----------------------------------------------------------------------------

export type AgingBuckets = 'month' | 'day';
export type AgingBasis = 'invoice' | 'due';

/** Five columns either way: 本月 · 1 · 2 · 3 · 4 个月以上, or 0–30 · 31–60 ·
    61–90 · 91–120 · 120 天以上. */
export const AGING_COLUMNS = 5;

const DAY_MS = 86_400_000;
const isoDay = (iso: string): number => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);

/** The column a date falls in, as at `asOf`. By month: whole calendar months
    between the two (the same month is 本月 whatever its day). By day: 0–30,
    31–60, 61–90, 91–120, more. A date after `asOf` — a bill not due yet, by due
    date — is the first column. */
export function agingColumn(asOf: string, date: string, buckets: AgingBuckets): number {
  if (buckets === 'month') {
    const months = (Number(asOf.slice(0, 4)) * 12 + Number(asOf.slice(5, 7))) - (Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)));
    return Math.max(0, Math.min(AGING_COLUMNS - 1, months));
  }
  const days = Math.floor((isoDay(asOf) - isoDay(date)) / DAY_MS);
  if (days <= 30) return 0;
  if (days <= 60) return 1;
  if (days <= 90) return 2;
  if (days <= 120) return 3;
  return 4;
}

export type AgingParty = { key: string; code: string | null; name: string };

/** One piece of a line, in its group. `amountSen` is from the holder's side:
    positive is owed (a customer's invoice on AR, a supplier's bill on AP),
    negative is money against it (a payment, a credit). */
export type AgingEntry = {
  group: string;
  party: AgingParty;
  docNo: string;
  kind: string;
  date: string;
  dueDate: string | null;
  amountSen: number;
};

export type OpenItem = { group: string; docNo: string; kind: string; date: string; dueDate: string | null; amountSen: number; openSen: number; column: number };
export type UnappliedItem = { docNo: string; kind: string; date: string; amountSen: number };

export type AgingRow = {
  key: string;
  code: string | null;
  name: string;
  balanceSen: number;
  cells: number[];
  unappliedSen: number;
  items: OpenItem[];
  unapplied: UnappliedItem[];
};

const byDateThenDoc = (a: { date: string; docNo: string }, b: { date: string; docNo: string }): number =>
  a.date.localeCompare(b.date) || a.docNo.localeCompare(b.docNo);

/**
 * Knock off inside each group and lay the result out by party: each party's
 * open bills in their columns, its money left over in 未冲, and its balance —
 * which is the sum of every entry it holds, so the report adds up to the lines
 * it was given, to the sen.
 */
export function ageEntries(entries: readonly AgingEntry[], opts: { asOf: string; basis: AgingBasis; buckets: AgingBuckets }): AgingRow[] {
  const groups = new Map<string, AgingEntry[]>();
  for (const e of entries) {
    if (e.amountSen === 0) continue;
    const g = groups.get(e.group);
    if (g) g.push(e); else groups.set(e.group, [e]);
  }

  const rows = new Map<string, AgingRow>();
  const rowOf = (p: AgingParty): AgingRow => {
    let r = rows.get(p.key);
    if (!r) {
      r = { key: p.key, code: p.code, name: p.name, balanceSen: 0, cells: Array<number>(AGING_COLUMNS).fill(0), unappliedSen: 0, items: [], unapplied: [] };
      rows.set(p.key, r);
    }
    return r;
  };

  for (const list of groups.values()) {
    const owed = list.filter((e) => e.amountSen > 0).sort(byDateThenDoc);
    const against = list.filter((e) => e.amountSen < 0).sort(byDateThenDoc);
    let pool = against.reduce((n, e) => n - e.amountSen, 0);
    const poolTotal = pool;
    for (const bill of owed) {
      const take = Math.min(pool, bill.amountSen);
      pool -= take;
      const openSen = bill.amountSen - take;
      const row = rowOf(bill.party);
      row.balanceSen += openSen;
      if (openSen > 0) {
        const on = opts.basis === 'due' ? (bill.dueDate ?? bill.date) : bill.date;
        const column = agingColumn(opts.asOf, on, opts.buckets);
        row.cells[column] += openSen;
        row.items.push({ group: bill.group, docNo: bill.docNo, kind: bill.kind, date: bill.date, dueDate: bill.dueDate, amountSen: bill.amountSen, openSen, column });
      }
    }
    /* The money used went to the bills oldest first; what is left of it is the
       newest pieces — those are what stays 未冲. */
    let used = poolTotal - pool;
    for (const m of against) {
      const size = -m.amountSen;
      const spent = Math.min(used, size);
      used -= spent;
      const left = size - spent;
      if (left <= 0) continue;
      const row = rowOf(m.party);
      row.balanceSen -= left;
      row.unappliedSen -= left;
      row.unapplied.push({ docNo: m.docNo, kind: m.kind, date: m.date, amountSen: -left });
    }
  }

  for (const r of rows.values()) {
    r.items.sort(byDateThenDoc);
    r.unapplied.sort(byDateThenDoc);
  }
  return [...rows.values()]
    .filter((r) => r.balanceSen !== 0 || r.items.length > 0 || r.unapplied.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

export type AgingTotals = { balanceSen: number; cells: number[]; unappliedSen: number };

export function agingTotals(rows: readonly AgingRow[]): AgingTotals {
  const t: AgingTotals = { balanceSen: 0, cells: Array<number>(AGING_COLUMNS).fill(0), unappliedSen: 0 };
  for (const r of rows) {
    t.balanceSen += r.balanceSen;
    t.unappliedSen += r.unappliedSen;
    r.cells.forEach((v, i) => { t.cells[i] += v; });
  }
  return t;
}

/** A line split into pieces: the parts named for other groups (each its own
    amount, date and document), and what is left of the line in its own group.
    The parts never exceed the line — a part bigger than what is left is cut to
    it — so the pieces always add back to the line. */
export function splitLine(
  line: Omit<AgingEntry, 'group'> & { group: string },
  parts: ReadonlyArray<{ group: string; amountSen: number; date: string; docNo?: string; kind?: string }>,
): AgingEntry[] {
  const sign = line.amountSen < 0 ? -1 : 1;
  let left = Math.abs(line.amountSen);
  const out: AgingEntry[] = [];
  for (const p of parts) {
    const take = Math.min(left, Math.max(0, Math.round(p.amountSen)));
    if (take <= 0) continue;
    left -= take;
    out.push({ ...line, group: p.group, date: p.date, docNo: p.docNo ?? line.docNo, kind: p.kind ?? line.kind, amountSen: sign * take });
  }
  if (left > 0) out.push({ ...line, amountSen: sign * left });
  return out;
}
