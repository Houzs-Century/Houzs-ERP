// ----------------------------------------------------------------------------
// acc-logistics-pnl — the Logistics P&L, the owner's own Logistic Cost Report
// built from the books (owner 2026-10-29, 做 —「不要我填」). Registered on the
// /acc-events router beside the Logistics cost report, behind the same Finance ›
// Accounting guard:
//
//   GET /logistics/pnl?from=&to=     the P&L by region, with every bill line,
//                                    trip and spread it counted
//   PUT /logistics/income-rate       { pct } — the share of the DOs' value counted
//                                    as transport income (3% until changed)
//   PUT /logistics/area-rate         { area, rateRm | null, reset? } — the rate per
//                                    setup / dismantle trip in one area
//   PUT /logistics/spread            { lineId, months | null } — how many months
//                                    one upkeep / insurance bill is spread over
//   PUT /logistics/trip              { tripKey, inHouse | null } — tick or untick
//                                    one setup / dismantle trip; null = the rule
//
// Every PUT is Finance's — the money right, like the cost-account list.
// The arithmetic: scm/lib/logistics-pnl.ts.
// ----------------------------------------------------------------------------

import { activeCompanySql, requireActiveCompanyId } from '../lib/companyScope';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { chunkIn, paginateAll } from '../lib/paginate-all';
import { todayMyt } from '../lib/my-time';
import { dateOrNull } from '../lib/date-coerce';
import { countsInTheBooks } from '../../acc/reversal-pairs';
import { defaultOwnCostAccounts, delivererOf, monthOf, regionOfDo } from '../lib/logistics-cost';
import {
  AREAS, MAX_SPREAD, addMonths, buildLogisticsPnl, coveredKinds, incomeLines, isAreaKey, monthsBetween, pnlAccountsOf, rateOf, setupTrips,
  type BillLine, type Fair, type Leg, type TripKind,
} from '../lib/logistics-pnl';
import { fail, loadCostSetup, readMonthDos } from './acc-logistics';

/* eslint-disable @typescript-eslint/no-explicit-any -- PostgREST client, untyped throughout the acc layer */
type Row = Record<string, any>;

const monthStart = (ymd: string): string => `${ymd.slice(0, 7)}-01`;
const monthEnd = (ymd: string): string => {
  const d = new Date(`${ymd.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
};
const day = (v: unknown): string | null => (v == null || v === '' ? null : String(v).slice(0, 10));
const actorOf = (c: any): string | null => (c.get('houzsUser') as { name?: string } | undefined)?.name ?? null;
const NO_RIGHT = "You don't have permission to change the logistics report's settings.";

/* ── GET /logistics/pnl ───────────────────────────────────────────────────── */
export const logisticsPnlHandler = async (c: any): Promise<Response> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const today = todayMyt();
  const from = dateOrNull(c.req.query('from')) ?? monthStart(today);
  const to = dateOrNull(c.req.query('to')) ?? monthEnd(today);
  if (from > to) return c.json({ error: 'bad_range', message: 'The From date is after the To date.' }, 400);
  const sb = c.get('supabase');
  const companyId = co.companyId;
  const wholeFrom = monthStart(from);
  const wholeTo = monthEnd(to);

  const setup = await loadCostSetup(sb, companyId);
  if (!setup.ok) return fail(c, setup.what, setup.reason);
  const ownCost = setup.picked ?? defaultOwnCostAccounts(setup.chart, setup.lorries);
  const accounts = pnlAccountsOf(setup.chart, setup.lorries, ownCost);
  const nameOf = new Map(setup.chart.map((a) => [a.account_code, a.account_name] as const));

  const read = await readMonthDos(sb, companyId, wholeFrom, wholeTo);
  if (!read.ok) return fail(c, read.what, read.reason);
  const shown = read.dos.filter((d) => d.day >= from && d.day <= to);
  const ownTrips = new Set<string>();
  for (const d of shown) {
    const w = delivererOf(d, setup.lorries);
    if (w.kind === 'own') ownTrips.add(`${w.plate}|${d.day}`);
  }

  /* Finance's own: area rates, spreads, trip ticks. */
  const [rateRes, spreadRes, markRes] = await Promise.all([
    sb.from('acc_logistics_area_rates').select('area, rate_sen').eq('company_id', companyId),
    sb.from('acc_logistics_spreads').select('line_id, months').eq('company_id', companyId),
    sb.from('acc_logistics_trip_marks').select('trip_key, in_house').eq('company_id', companyId),
  ]);
  if (rateRes.error) return fail(c, 'area rates', rateRes.error.message);
  if (spreadRes.error) return fail(c, 'spreads', spreadRes.error.message);
  if (markRes.error) return fail(c, 'trip ticks', markRes.error.message);
  const rates = new Map(((rateRes.data ?? []) as Row[]).map((r) => [String(r.area), r.rate_sen == null ? null : Number(r.rate_sen)] as const));
  const spreadMonths = new Map(((spreadRes.data ?? []) as Row[]).map((r) => [String(r.line_id), Number(r.months)] as const));
  const marks = new Map(((markRes.data ?? []) as Row[]).map((r) => [String(r.trip_key), r.in_house === true] as const));

  /* The books: every leg on the P&L's accounts, from far enough back for the longest spread. */
  const spreadFrom = `${addMonths(monthOf(wholeFrom), -(MAX_SPREAD - 1))}-01`;
  const legsRes = await chunkIn<Row>(accounts.all, (b, lo, hi) => sb.from('v_gl_entries')
    .select('line_id, account_code, account_name, entry_date, debit_sen, credit_sen, posted, reversed, reversed_by_je, opening, notes, je_no')
    .eq('company_id', companyId).in('account_code', b).gte('entry_date', spreadFrom).lte('entry_date', wholeTo)
    .order('line_id').range(lo, hi));
  if (legsRes.error) return fail(c, 'ledger', legsRes.error.message);
  const legs: Leg[] = legsRes.data.filter((l) => l.opening !== true && countsInTheBooks(l)).map((l) => ({
    lineId: String(l.line_id), accountCode: String(l.account_code), accountName: l.account_name == null ? null : String(l.account_name),
    day: String(l.entry_date).slice(0, 10), debitSen: Number(l.debit_sen ?? 0), creditSen: Number(l.credit_sen ?? 0),
    notes: l.notes == null ? null : String(l.notes), docNo: l.je_no == null ? null : String(l.je_no),
  }));

  /* What Finance billed extra: Other Debtor bills a few months either side —
     a recharge is billed after the month it names. */
  const billFrom = `${addMonths(monthOf(wholeFrom), -3)}-01`;
  const billTo = monthEnd(`${addMonths(monthOf(wholeTo), 3)}-01`);
  const billsRes = await paginateAll<Row>((lo, hi) => sb.from('acc_debtor_bills')
    .select('id, bill_number, bill_date, status, debtor_id')
    .eq('company_id', companyId).neq('status', 'CANCELLED').gte('bill_date', billFrom).lte('bill_date', billTo)
    .order('bill_date').range(lo, hi));
  if (billsRes.error) return fail(c, 'other debtor bills', billsRes.error.message);
  const bills = billsRes.data ?? [];
  const [billLinesRes, debtorsRes] = await Promise.all([
    chunkIn<Row>(bills.map((b) => String(b.id)), (b, lo, hi) => sb.from('acc_debtor_bill_lines')
      .select('id, bill_id, line_no, description, credit_account_code, amount_sen')
      .eq('company_id', companyId).in('bill_id', b).order('id').range(lo, hi)),
    chunkIn<Row>([...new Set(bills.map((b) => String(b.debtor_id)))], (b, lo, hi) => sb.from('acc_debtors')
      .select('id, name').in('id', b).order('id').range(lo, hi)),
  ]);
  if (billLinesRes.error) return fail(c, 'other debtor bill lines', billLinesRes.error.message);
  if (debtorsRes.error) return fail(c, 'other debtors', debtorsRes.error.message);
  const billOf = new Map(bills.map((b) => [String(b.id), b] as const));
  const debtorOf = new Map(debtorsRes.data.map((d) => [String(d.id), String(d.name ?? '')] as const));
  const billLines: BillLine[] = billLinesRes.data.map((l) => {
    const b = billOf.get(String(l.bill_id))!;
    return {
      lineId: String(l.id), billNo: String(b.bill_number ?? ''), billDate: String(b.bill_date).slice(0, 10),
      debtorName: debtorOf.get(String(b.debtor_id)) ?? '', description: l.description == null ? null : String(l.description),
      accountCode: String(l.credit_account_code ?? ''), accountName: nameOf.get(String(l.credit_account_code ?? '')) ?? null,
      amountSen: Number(l.amount_sen ?? 0),
    };
  });

  /* The fairs set up or dismantled in the range, and what was outsourced on them. */
  let fairs: Fair[] = [];
  let tripsProblem: string | null = null;
  const outsourced = new Map<number, Set<TripKind>>();
  if (c.env?.DB) {
    try {
      const res = await c.env.DB.prepare(
        `SELECT p.id AS id, p.code AS code, p.name AS name, p.state AS state, p.venue AS venue,
                p.start_date AS startdate, p.end_date AS enddate
           FROM projects p
          WHERE p.archived_at IS NULL AND lower(coalesce(p.status, '')) <> 'cancelled'
            AND ((p.start_date >= ? AND p.start_date <= ?) OR (p.end_date >= ? AND p.end_date <= ?))${activeCompanySql(c, 'p.company_id')}
          ORDER BY p.start_date, p.id`,
      ).bind(from, to, from, to).all();
      fairs = ((res.results ?? []) as Row[]).map((r) => ({
        id: Number(r.id), code: r.code == null ? null : String(r.code), name: String(r.name ?? ''),
        state: r.state == null ? null : String(r.state), venue: r.venue == null ? null : String(r.venue),
        startDate: day(r.startdate), endDate: day(r.enddate),
      })).filter((f) => Number.isFinite(f.id));
    } catch (e) {
      tripsProblem = String((e as Error)?.message ?? e);
    }
  } else {
    tripsProblem = 'the fairs are not reachable from here';
  }
  if (fairs.length > 0) {
    const ids = fairs.map((f) => f.id);
    const fairAccounts = setup.chart.filter((a) => a.pms_row === 'transport_setup_dismantle').map((a) => a.account_code);
    const onFairAccounts = fairAccounts.length > 0 ? ids.map(String) : [];
    const [threeplRes, apRes, pvRes] = await Promise.all([
      chunkIn<Row>(ids.map(String), (b, lo, hi) => sb.from('threepl_bill_lines').select('id, project_id, kind, text')
        .eq('company_id', companyId).eq('assign', 'event').in('project_id', b).order('id').range(lo, hi)),
      chunkIn<Row>(onFairAccounts, (b, lo, hi) => sb.from('ap_invoice_lines').select('id, invoice_id, project_id, debit_account_code, description')
        .eq('company_id', companyId).in('project_id', b).in('debit_account_code', fairAccounts).order('id').range(lo, hi)),
      chunkIn<Row>(onFairAccounts, (b, lo, hi) => sb.from('payment_voucher_lines').select('id, pv_id, project_id, debit_account_code, description')
        .eq('company_id', companyId).in('project_id', b).in('debit_account_code', fairAccounts).order('id').range(lo, hi)),
    ]);
    if (threeplRes.error) return fail(c, '3PL bill lines', threeplRes.error.message);
    if (apRes.error) return fail(c, 'AP invoice lines', apRes.error.message);
    if (pvRes.error) return fail(c, 'payment voucher lines', pvRes.error.message);
    const [invRes, pvsRes] = await Promise.all([
      chunkIn<Row>([...new Set(apRes.data.map((l) => String(l.invoice_id)))], (b, lo, hi) => sb.from('ap_invoices').select('id, status')
        .eq('company_id', companyId).in('id', b).order('id').range(lo, hi)),
      chunkIn<Row>([...new Set(pvRes.data.map((l) => String(l.pv_id)))], (b, lo, hi) => sb.from('payment_vouchers').select('id, status')
        .eq('company_id', companyId).in('id', b).order('id').range(lo, hi)),
    ]);
    if (invRes.error) return fail(c, 'AP invoices', invRes.error.message);
    if (pvsRes.error) return fail(c, 'payment vouchers', pvsRes.error.message);
    const dead = new Set(['CANCELLED', 'REJECTED', 'VOID']);
    const liveInv = new Set(invRes.data.filter((x) => !dead.has(String(x.status ?? '').toUpperCase())).map((x) => String(x.id)));
    const livePv = new Set(pvsRes.data.filter((x) => !dead.has(String(x.status ?? '').toUpperCase())).map((x) => String(x.id)));
    const cover = (projectId: unknown, kinds: TripKind[]) => {
      const id = Number(projectId);
      const s = outsourced.get(id) ?? new Set<TripKind>();
      for (const k of kinds) s.add(k);
      outsourced.set(id, s);
    };
    for (const l of threeplRes.data) cover(l.project_id, coveredKinds(l.kind, l.text));
    for (const l of apRes.data) if (liveInv.has(String(l.invoice_id))) cover(l.project_id, coveredKinds(null, l.description));
    for (const l of pvRes.data) if (livePv.has(String(l.pv_id))) cover(l.project_id, coveredKinds(null, l.description));
  }

  const range = monthsBetween(from, to);
  const pnl = buildLogisticsPnl({
    from, to,
    dos: shown.map((d) => ({ region: regionOfDo(d).code, valueSen: d.valueSen })),
    doIncomeBp: setup.doIncomeBp,
    income: incomeLines(billLines, range),
    trips: setupTrips({ fairs, outsourced, marks, rates, from, to }),
    legs, accounts, spreadMonths,
    ownTrips: ownTrips.size,
  });
  return c.json({
    ...pnl,
    tripsProblem,
    areaRates: AREAS.map((a) => ({ key: a.key, label: a.label, region: a.region, rateSen: rateOf(a, rates), defaultRateSen: a.defaultRateSen, isDefault: !rates.has(a.key) })),
  });
};

/* ── The PUTs: Finance's settings ─────────────────────────────────────────── */
async function readBody(c: any): Promise<any> {
  try { return await c.req.json(); } catch { return undefined; }
}

/** PUT /logistics/income-rate — { pct }: 0–100, two decimals at most. */
export const saveIncomeRateHandler = async (c: any): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.post')) return c.json({ error: NO_RIGHT }, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const body = await readBody(c);
  if (body === undefined) return c.json({ error: 'invalid_json' }, 400);
  const pct = Number(body?.pct);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100 || Math.round(pct * 100) !== pct * 100) {
    return c.json({ error: 'bad_pct', message: 'The rate is a percentage from 0 to 100, two decimals at most.' }, 400);
  }
  const bp = Math.round(pct * 100);
  const { error } = await c.get('supabase').from('acc_logistics_settings').upsert(
    { company_id: co.companyId, do_income_bp: bp, updated_at: new Date().toISOString(), updated_by: actorOf(c) },
    { onConflict: 'company_id' },
  );
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  return c.json({ ok: true, doIncomeBp: bp });
};

/** PUT /logistics/area-rate — { area, rateRm | null, reset? }: null = no rate there; reset = the default again. */
export const saveAreaRateHandler = async (c: any): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.post')) return c.json({ error: NO_RIGHT }, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const body = await readBody(c);
  if (body === undefined) return c.json({ error: 'invalid_json' }, 400);
  const area = String(body?.area ?? '');
  if (!isAreaKey(area)) return c.json({ error: 'bad_area', message: `${area || '(empty)'} is not one of the areas.` }, 400);
  const sb = c.get('supabase');
  if (body?.reset === true) {
    const { error } = await sb.from('acc_logistics_area_rates').delete().eq('company_id', co.companyId).eq('area', area);
    if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
    return c.json({ ok: true, area, rateSen: AREAS.find((a) => a.key === area)!.defaultRateSen, isDefault: true });
  }
  const raw = body?.rateRm;
  const rm = raw == null ? null : Number(raw);
  if (rm != null && (!Number.isFinite(rm) || rm < 0 || rm > 100_000 || Math.round(rm * 100) !== rm * 100)) {
    return c.json({ error: 'bad_rate', message: 'The rate is ringgit per trip, two decimals at most — or none.' }, 400);
  }
  const rateSen = rm == null ? null : Math.round(rm * 100);
  const { error } = await sb.from('acc_logistics_area_rates').upsert(
    { company_id: co.companyId, area, rate_sen: rateSen, updated_at: new Date().toISOString(), updated_by: actorOf(c) },
    { onConflict: 'company_id,area' },
  );
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  return c.json({ ok: true, area, rateSen, isDefault: false });
};

/** PUT /logistics/spread — { lineId, months | null }: a ledger line of this company; null = its default again. */
export const saveSpreadHandler = async (c: any): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.post')) return c.json({ error: NO_RIGHT }, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const body = await readBody(c);
  if (body === undefined) return c.json({ error: 'invalid_json' }, 400);
  const lineId = String(body?.lineId ?? '').trim();
  if (!lineId || lineId.length > 64) return c.json({ error: 'bad_line', message: 'Name the ledger line to spread.' }, 400);
  const months = body?.months == null ? null : Number(body.months);
  if (months != null && (!Number.isInteger(months) || months < 1 || months > MAX_SPREAD)) {
    return c.json({ error: 'bad_months', message: `Spread over 1 to ${MAX_SPREAD} whole months.` }, 400);
  }
  const sb = c.get('supabase');
  const { data: line, error: lineErr } = await sb.from('v_gl_entries').select('line_id')
    .eq('company_id', co.companyId).eq('line_id', lineId).limit(1).maybeSingle();
  if (lineErr) return fail(c, 'ledger', lineErr.message);
  if (!line) return c.json({ error: 'line_unknown', message: 'That ledger line is not in this company’s books.' }, 404);
  if (months == null) {
    const { error } = await sb.from('acc_logistics_spreads').delete().eq('company_id', co.companyId).eq('line_id', lineId);
    if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
    return c.json({ ok: true, lineId, months: null });
  }
  const { error } = await sb.from('acc_logistics_spreads').upsert(
    { company_id: co.companyId, line_id: lineId, months, updated_at: new Date().toISOString(), updated_by: actorOf(c) },
    { onConflict: 'company_id,line_id' },
  );
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  return c.json({ ok: true, lineId, months });
};

const TRIP_KEY = /^(setup|dismantle)\|.{1,150}\|\d{4}-\d{2}-\d{2}$/;

/** PUT /logistics/trip — { tripKey, inHouse | null }: tick (ours) or untick one trip; null = the rule again. */
export const saveTripMarkHandler = async (c: any): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.post')) return c.json({ error: NO_RIGHT }, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const body = await readBody(c);
  if (body === undefined) return c.json({ error: 'invalid_json' }, 400);
  const tripKey = String(body?.tripKey ?? '');
  if (!TRIP_KEY.test(tripKey)) return c.json({ error: 'bad_trip', message: 'That is not a setup / dismantle trip of the report.' }, 400);
  const inHouse = body?.inHouse;
  if (inHouse != null && typeof inHouse !== 'boolean') return c.json({ error: 'bad_mark', message: 'inHouse is true, false or null.' }, 400);
  const sb = c.get('supabase');
  if (inHouse == null) {
    const { error } = await sb.from('acc_logistics_trip_marks').delete().eq('company_id', co.companyId).eq('trip_key', tripKey);
    if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
    return c.json({ ok: true, tripKey, inHouse: null });
  }
  const { error } = await sb.from('acc_logistics_trip_marks').upsert(
    { company_id: co.companyId, trip_key: tripKey, in_house: inHouse, updated_at: new Date().toISOString(), updated_by: actorOf(c) },
    { onConflict: 'company_id,trip_key' },
  );
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  return c.json({ ok: true, tripKey, inHouse });
};
