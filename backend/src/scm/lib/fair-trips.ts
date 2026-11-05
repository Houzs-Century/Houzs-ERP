// ----------------------------------------------------------------------------
// fair-trips — the ONE read of the setup / dismantle trips, for both of their
// readers (owner 2026-11-05: the in-house charge is Logistics INCOME and a COST
// of the fair, and 「两边要一样」):
//   • the Logistics P&L (scm/routes/acc-logistics-pnl.ts) — the trips of a range;
//   • the fair's own books (scm/lib/event-books.ts) — the trips of some fairs,
//     each fair's share of its trips' charge on its Transport Setup & Dismantle row.
// Both read the same fairs (not archived, not cancelled), the same outsourced
// lines, Finance's ticks and rates, and price them with setupTrips — so the
// P&L's Set/Dismantle Income always equals the fairs' charges.
// Through env.DB (the Postgres connection the event page already uses).
// ----------------------------------------------------------------------------

import { share } from './logistics-cost';
import { coveredKinds, setupTrips, type Fair, type SetupTrip, type TripKind } from './logistics-pnl';

type Db = { prepare: (sql: string) => { bind: (...v: unknown[]) => { all: <T = Record<string, unknown>>() => Promise<{ results?: T[] }> } } };
type Row = Record<string, unknown>;

const day = (v: unknown): string | null => (v == null || v === '' ? null : String(v).slice(0, 10));
const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ');
const FAIR_COLS = `p.id AS id, p.code AS code, p.name AS name, p.state AS state, p.venue AS venue,
                p.start_date AS startdate, p.end_date AS enddate, p.brand AS brand,
                (SELECT f.total_sales FROM project_finance f WHERE f.project_id = p.id LIMIT 1) AS totalsales`;
const LIVE_FAIR = `p.archived_at IS NULL AND lower(coalesce(p.status, '')) <> 'cancelled'`;

export type FairRow = Fair & { brand: string | null; totalSales: number | null };
const toFair = (r: Row): FairRow => ({
  id: Number(r.id), code: r.code == null ? null : String(r.code), name: String(r.name ?? ''),
  state: r.state == null ? null : String(r.state), venue: r.venue == null ? null : String(r.venue),
  startDate: day(r.startdate), endDate: day(r.enddate),
  brand: r.brand == null ? null : String(r.brand), totalSales: r.totalsales == null ? null : Number(r.totalsales),
});

export type FairTripsRead =
  | { ok: true; fairs: FairRow[]; trips: SetupTrip[] }
  | { ok: false; reason: string };

/** The fairs set up or dismantled in a range, or the fairs sharing a day and
    venue with some fairs; their outsourced lines, Finance's ticks and rates, and
    the trips priced. A failed read says so — never a guessed zero. */
export async function readFairTrips(
  db: Db, companyId: number | null,
  scope: { from: string; to: string } | { projectIds: readonly number[] },
): Promise<FairTripsRead> {
  try {
    const co = companyId != null ? ' AND p.company_id = ?' : '';
    const coArg = companyId != null ? [companyId] : [];
    let fairs: FairRow[];
    let from = '0000-01-01';
    let to = '9999-12-31';
    if ('from' in scope) {
      ({ from, to } = scope);
      const res = await db.prepare(
        `SELECT ${FAIR_COLS} FROM projects p
          WHERE ${LIVE_FAIR}
            AND ((p.start_date >= ? AND p.start_date <= ?) OR (p.end_date >= ? AND p.end_date <= ?))${co}
          ORDER BY p.start_date, p.id`,
      ).bind(from, to, from, to, ...coArg).all<Row>();
      fairs = (res.results ?? []).map(toFair).filter((f) => Number.isFinite(f.id));
    } else {
      const ids = [...new Set(scope.projectIds.filter((x) => Number.isInteger(x)))];
      if (ids.length === 0) return { ok: true, fairs: [], trips: [] };
      const own = await db.prepare(
        `SELECT p.start_date AS startdate, p.end_date AS enddate FROM projects p WHERE p.id IN (${marks(ids.length)})${co}`,
      ).bind(...ids, ...coArg).all<Row>();
      const starts = [...new Set((own.results ?? []).map((r) => day(r.startdate)).filter((d): d is string => !!d))];
      const ends = [...new Set((own.results ?? []).map((r) => day(r.enddate)).filter((d): d is string => !!d))];
      if (starts.length === 0 && ends.length === 0) return { ok: true, fairs: [], trips: [] };
      /* Every fair on those days: booths at one venue on one day share a trip. */
      const conds = [
        ...(starts.length ? [`p.start_date IN (${marks(starts.length)})`] : []),
        ...(ends.length ? [`p.end_date IN (${marks(ends.length)})`] : []),
      ].join(' OR ');
      const res = await db.prepare(
        `SELECT ${FAIR_COLS} FROM projects p WHERE ${LIVE_FAIR} AND (${conds})${co} ORDER BY p.start_date, p.id`,
      ).bind(...starts, ...ends, ...coArg).all<Row>();
      fairs = (res.results ?? []).map(toFair).filter((f) => Number.isFinite(f.id));
    }
    if (fairs.length === 0) return { ok: true, fairs, trips: [] };

    const ids = fairs.map((f) => f.id);
    const lco = companyId != null ? ' AND l.company_id = ?' : '';
    const dead = `upper(coalesce(d.status, '')) NOT IN ('CANCELLED', 'REJECTED', 'VOID')`;
    /* What was outsourced on the fairs: a 3PL bill line on the fair, or a line on a
       fair-transport account (the chart's Transport Setup & Dismantle row) of a live bill or voucher. */
    const covered = await db.prepare(
      `SELECT l.project_id AS projectid, l.kind AS kind, l.text AS words
         FROM scm.threepl_bill_lines l
        WHERE l.assign = 'event' AND l.project_id IN (${marks(ids.length)})${lco}
       UNION ALL
       SELECT l.project_id, NULL, l.description
         FROM scm.ap_invoice_lines l
         JOIN scm.ap_invoices d ON d.id = l.invoice_id
         JOIN scm.accounts a ON a.company_id = l.company_id AND a.account_code = l.debit_account_code
        WHERE a.pms_row = 'transport_setup_dismantle' AND ${dead} AND l.project_id IN (${marks(ids.length)})${lco}
       UNION ALL
       SELECT l.project_id, NULL, l.description
         FROM scm.payment_voucher_lines l
         JOIN scm.payment_vouchers d ON d.id = l.pv_id
         JOIN scm.accounts a ON a.company_id = l.company_id AND a.account_code = l.debit_account_code
        WHERE a.pms_row = 'transport_setup_dismantle' AND ${dead} AND l.project_id IN (${marks(ids.length)})${lco}`,
    ).bind(...ids, ...coArg, ...ids, ...coArg, ...ids, ...coArg).all<Row>();
    const outsourced = new Map<number, Set<TripKind>>();
    for (const r of covered.results ?? []) {
      const id = Number(r.projectid);
      const s = outsourced.get(id) ?? new Set<TripKind>();
      for (const k of coveredKinds(r.kind == null ? null : String(r.kind), r.words == null ? null : String(r.words))) s.add(k);
      outsourced.set(id, s);
    }

    /* Finance's own ticks and rates — the company's. */
    const rates = new Map<string, number | null>();
    const ticks = new Map<string, boolean>();
    if (companyId != null) {
      const [rateRes, markRes] = await Promise.all([
        db.prepare('SELECT area, rate_sen AS ratesen FROM scm.acc_logistics_area_rates WHERE company_id = ?').bind(companyId).all<Row>(),
        db.prepare('SELECT trip_key AS tripkey, in_house AS inhouse FROM scm.acc_logistics_trip_marks WHERE company_id = ?').bind(companyId).all<Row>(),
      ]);
      for (const r of rateRes.results ?? []) rates.set(String(r.area), r.ratesen == null ? null : Number(r.ratesen));
      for (const r of markRes.results ?? []) ticks.set(String(r.tripkey), r.inhouse === true || r.inhouse === 't');
    }
    return { ok: true, fairs, trips: setupTrips({ fairs, outsourced, marks: ticks, rates, from, to }) };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** One fair's share of one trip's charge. */
export type FairCharge = { projectId: number; tripKey: string; kind: TripKind; day: string; rateSen: number | null; booths: number; sen: number };

/** Each fair's share of its in-house trips: a trip's charge shared equally by the
    fairs on it (the remainder to the first), so the shares add up to the trip. */
export function chargesByFair(trips: readonly SetupTrip[]): Map<number, FairCharge[]> {
  const out = new Map<number, FairCharge[]>();
  for (const t of trips) {
    if (t.amountSen === 0) continue;
    share(t.amountSen, t.fairs.length).forEach((sen, i) => {
      const f = t.fairs[i]!;
      const list = out.get(f.id) ?? [];
      list.push({ projectId: f.id, tripKey: t.key, kind: t.kind, day: t.day, rateSen: t.rateSen, booths: t.fairs.length, sen });
      out.set(f.id, list);
    });
  }
  return out;
}
