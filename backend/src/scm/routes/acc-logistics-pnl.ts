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
//   PUT /logistics/fair-income-rate  { pct } — the share of each fair's sales
//                                    counted as transport income (1% until changed)
//   PUT /logistics/area-rate         { area, rateRm | null, reset? } — the rate per
//                                    setup / dismantle trip in one area
//   PUT /logistics/spread            { lineId, months | null } — how many months
//                                    one upkeep / insurance bill is spread over
//   PUT /logistics/trip              { tripKey, inHouse | null } — tick or untick
//                                    one setup / dismantle trip; null = the rule
//
// Every PUT is Finance's — the money right. Which account feeds which row is
// the Chart of Accounts' Logistics column (scm/lib/logistics-rows.ts).
// The arithmetic: scm/lib/logistics-pnl.ts.
// ----------------------------------------------------------------------------

import { requireActiveCompanyId } from '../lib/companyScope';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { chunkIn, paginateAll } from '../lib/paginate-all';
import { todayMyt } from '../lib/my-time';
import { dateOrNull } from '../lib/date-coerce';
import { countsInTheBooks } from '../../acc/reversal-pairs';
import { delivererOf, monthOf, regionOfDo, type LogisticsDo, type RegionCode } from '../lib/logistics-cost';
import {
  AREAS, MAX_SPREAD, addMonths, areaOf, buildLogisticsPnl, incomeLines, isAreaKey, monthsBetween, pnlAccountsOf, rateOf,
  type BillLine, type Leg, type SetupTrip,
} from '../lib/logistics-pnl';
import { buildMonthCost, fairBlock, monthCostTotal, type FairBlock, type FairLineIn, type ThreeplBill } from '../lib/logistics-breakdown';
import { readFairTrips, type FairRow } from '../lib/fair-trips';
import { LOGISTICS_CHARGE_DOC } from '../lib/event-books';
import { pnlAndLinesForProjects, type PnlWithLines } from '../../services/eventPnlBatch';
import { LEDGER_COST_CATEGORIES } from '../../services/projects';
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
  const accounts = pnlAccountsOf(setup.chart);
  const nameOf = new Map(setup.chart.map((a) => [a.account_code, a.account_name] as const));

  const read = await readMonthDos(sb, companyId, wholeFrom, wholeTo);
  if (!read.ok) return fail(c, read.what, read.reason);
  const shown = read.dos.filter((d) => d.day >= from && d.day <= to);
  const regionOf = new Map(read.dos.map((d) => [d.id, regionOfDo(d).code] as const));
  const ownTripsIn = (dos: readonly LogisticsDo[]) => {
    const keys = new Set<string>();
    for (const d of dos) {
      const w = delivererOf(d, setup.lorries);
      if (w.kind === 'own') keys.add(`${w.plate}|${d.day}`);
    }
    return keys.size;
  };

  /* Finance's own spreads (the rates and ticks are read with the trips). */
  const spreadRes = await sb.from('acc_logistics_spreads').select('line_id, months').eq('company_id', companyId);
  if (spreadRes.error) return fail(c, 'spreads', spreadRes.error.message);
  const spreadMonths = new Map(((spreadRes.data ?? []) as Row[]).map((r) => [String(r.line_id), Number(r.months)] as const));
  const rateRes = await sb.from('acc_logistics_area_rates').select('area, rate_sen').eq('company_id', companyId);
  if (rateRes.error) return fail(c, 'area rates', rateRes.error.message);
  const rates = new Map(((rateRes.data ?? []) as Row[]).map((r) => [String(r.area), r.rate_sen == null ? null : Number(r.rate_sen)] as const));

  /* The books: every leg on the P&L's accounts, from far enough back for the longest spread. */
  const spreadFrom = `${addMonths(monthOf(wholeFrom), -(MAX_SPREAD - 1))}-01`;
  const legsRes = await chunkIn<Row>(accounts.all, (b, lo, hi) => sb.from('v_gl_entries')
    .select('line_id, account_code, account_name, entry_date, debit_sen, credit_sen, posted, reversed, reversed_by_je, opening, notes, je_no, source_type, source_doc_no, party_name')
    .eq('company_id', companyId).in('account_code', b).gte('entry_date', spreadFrom).lte('entry_date', wholeTo)
    .order('line_id').range(lo, hi));
  if (legsRes.error) return fail(c, 'ledger', legsRes.error.message);
  const legs: Leg[] = legsRes.data.filter((l) => l.opening !== true && countsInTheBooks(l)).map((l) => ({
    lineId: String(l.line_id), accountCode: String(l.account_code), accountName: l.account_name == null ? null : String(l.account_name),
    day: String(l.entry_date).slice(0, 10), debitSen: Number(l.debit_sen ?? 0), creditSen: Number(l.credit_sen ?? 0),
    notes: l.notes == null ? null : String(l.notes), docNo: l.je_no == null ? null : String(l.je_no),
    sourceType: l.source_type == null ? null : String(l.source_type), sourceDocNo: l.source_doc_no == null ? null : String(l.source_doc_no),
    partyName: l.party_name == null ? null : String(l.party_name),
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

  /* The fairs set up or dismantled in the range and their trips — the ONE read
     the fairs' own books use too (scm/lib/fair-trips.ts). */
  let fairs: FairRow[] = [];
  let trips: SetupTrip[] = [];
  let tripsProblem: string | null = null;
  if (c.env?.DB) {
    const ft = await readFairTrips(c.env.DB, companyId, { from, to });
    if (ft.ok) { fairs = ft.fairs; trips = ft.trips; } else tripsProblem = ft.reason;
  } else {
    tripsProblem = 'the fairs are not reachable from here';
  }

  /* Each fair opened in the range: its sales and its own books (Project Overview's engine). */
  const opened = fairs.filter((f) => f.startDate != null && f.startDate >= from && f.startDate <= to);
  let fairBooks = new Map<number, PnlWithLines>();
  let fairsProblem: string | null = tripsProblem;
  if (!fairsProblem && opened.length > 0) {
    const pl = await pnlAndLinesForProjects(c.env, opened.map((f) => ({ id: f.id, brand: f.brand, total_sales: f.totalSales })), companyId, LEDGER_COST_CATEGORIES);
    if (pl.ok) fairBooks = pl.byId; else fairsProblem = pl.reason;
  }
  const fairRegion = (f: FairRow): RegionCode => areaOf(f.state)?.region ?? 'KL';
  const salesRmOf = (id: number): number => { const p = fairBooks.get(id)?.pnl; return p ? (p.by_so ?? p.by_sales).sales : 0; };

  /* The carriers' bills behind the outsource legs (by AP invoice number), their
     3PL lines, and the fair lines with no fair picked. */
  const outsourceLegs = legs.filter((l) => accounts.outsource.has(l.accountCode) && l.day >= wholeFrom && l.day <= wholeTo);
  const apNos = [...new Set(outsourceLegs.filter((l) => l.sourceType === 'API' && l.sourceDocNo).map((l) => l.sourceDocNo!))];
  const [apRes, noFairRes] = await Promise.all([
    chunkIn<Row>(apNos, (b, lo, hi) => sb.from('ap_invoices').select('id, invoice_number, invoice_date, supplier_id')
      .eq('company_id', companyId).in('invoice_number', b).order('id').range(lo, hi)),
    paginateAll<Row>((lo, hi) => sb.from('threepl_bill_lines').select('id, ap_invoice_id, amount_sen')
      .eq('company_id', companyId).eq('assign', 'event').is('project_id', null).order('id').range(lo, hi)),
  ]);
  if (apRes.error) return fail(c, 'AP invoices', apRes.error.message);
  if (noFairRes.error) return fail(c, '3PL bill lines', noFairRes.error.message);
  const apIds = apRes.data.map((x) => String(x.id));
  const noFairApIds = [...new Set((noFairRes.data ?? []).map((l) => String(l.ap_invoice_id)))];
  const [tplRes, supRes, noFairApRes] = await Promise.all([
    chunkIn<Row>(apIds, (b, lo, hi) => sb.from('threepl_bill_lines').select('id, ap_invoice_id, threepl_company_id, amount_sen, assign, do_ids')
      .eq('company_id', companyId).in('ap_invoice_id', b).order('id').range(lo, hi)),
    chunkIn<Row>([...new Set(apRes.data.map((x) => String(x.supplier_id)))], (b, lo, hi) => sb.from('suppliers').select('id, name')
      .eq('company_id', companyId).in('id', b).order('id').range(lo, hi)),
    chunkIn<Row>(noFairApIds, (b, lo, hi) => sb.from('ap_invoices').select('id, invoice_date, status')
      .eq('company_id', companyId).in('id', b).order('id').range(lo, hi)),
  ]);
  if (tplRes.error) return fail(c, '3PL bill lines', tplRes.error.message);
  if (supRes.error) return fail(c, 'suppliers', supRes.error.message);
  if (noFairApRes.error) return fail(c, 'AP invoices', noFairApRes.error.message);
  const carrierIds = [...new Set(tplRes.data.map((l) => l.threepl_company_id).filter((x) => x != null).map(String))];
  const carRes = await chunkIn<Row>(carrierIds, (b, lo, hi) => sb.from('threepl_companies').select('id, name')
    .eq('company_id', companyId).in('id', b).order('id').range(lo, hi));
  if (carRes.error) return fail(c, '3PL companies', carRes.error.message);
  const carrierName = new Map(carRes.data.map((x) => [String(x.id), String(x.name ?? '')] as const));
  const supplierName = new Map(supRes.data.map((x) => [String(x.id), String(x.name ?? '')] as const));
  const linesOfAp = new Map<string, Row[]>();
  for (const l of tplRes.data) { const k = String(l.ap_invoice_id); linesOfAp.set(k, [...(linesOfAp.get(k) ?? []), l]); }
  const threeplBills = new Map<string, ThreeplBill>();
  for (const ap of apRes.data) {
    const ls = linesOfAp.get(String(ap.id)) ?? [];
    const named = ls.map((l) => (l.threepl_company_id == null ? '' : carrierName.get(String(l.threepl_company_id)) ?? '')).filter(Boolean);
    threeplBills.set(String(ap.invoice_number), {
      billNo: String(ap.invoice_number), day: String(ap.invoice_date ?? '').slice(0, 10),
      carrier: mostCommon(named), supplier: supplierName.get(String(ap.supplier_id)) ?? null,
      lines: ls.map((l) => ({ amountSen: Number(l.amount_sen ?? 0), assign: l.assign == null ? null : String(l.assign), doIds: Array.isArray(l.do_ids) ? (l.do_ids as unknown[]).map(String) : [] })),
    });
  }
  /* A bill may name DOs of another month: their regions too. */
  const missing = [...new Set([...threeplBills.values()].flatMap((b) => b.lines.flatMap((l) => l.doIds)).filter((id) => !regionOf.has(id)))];
  if (missing.length > 0) {
    const more = await readDoRegions(sb, companyId, missing);
    if (!more.ok) return fail(c, more.what, more.reason);
    for (const [id, r] of more.regions) regionOf.set(id, r);
  }
  const noFairDay = new Map(noFairApRes.data.filter((x) => String(x.status ?? '').toUpperCase() !== 'CANCELLED').map((x) => [String(x.id), String(x.invoice_date ?? '').slice(0, 10)] as const));
  const charged = new Set(read.charges.map((ch) => String(ch.do_id)));

  const range = monthsBetween(from, to);
  const pnlFor = (f: string, t: string) => {
    const ms = monthsBetween(f, t);
    return buildLogisticsPnl({
      from: f, to: t,
      dos: read.dos.filter((d) => d.day >= f && d.day <= t).map((d) => ({ region: regionOf.get(d.id) ?? 'KL', valueSen: d.valueSen })),
      doIncomeBp: setup.doIncomeBp,
      fairs: opened.filter((x) => x.startDate! >= f && x.startDate! <= t).map((x) => ({ region: fairRegion(x), salesSen: Math.round(salesRmOf(x.id) * 100) })),
      fairIncomeBp: setup.fairIncomeBp,
      income: incomeLines(billLines, ms, accounts.income),
      trips: trips.filter((x) => x.day >= f && x.day <= t),
      legs, accounts, spreadMonths,
      ownTrips: ownTripsIn(read.dos.filter((d) => d.day >= f && d.day <= t)),
    });
  };
  const pnl = pnlFor(from, to);

  /* Month by month: the P&L, the delivery cost, the fairs. */
  const perMonth = range.map((m) => {
    const f = m === monthOf(from) ? from : `${m}-01`;
    const t = m === monthOf(to) ? to : monthEnd(`${m}-01`);
    const p = range.length === 1 ? pnl : pnlFor(f, t);
    const inHouseSen = p.rows.find((r) => r.key === 'inhouse_total')?.totalSen ?? 0;
    const cost = buildMonthCost({
      month: m, dos: read.dos.filter((d) => d.day >= f && d.day <= t), regionOf, lorries: setup.lorries, charged, inHouseSen,
      legs: outsourceLegs.filter((l) => l.day >= f && l.day <= t).map((l) => ({
        accountRegion: accounts.outsource.get(l.accountCode)!, netSen: l.debitSen - l.creditSen,
        billNo: l.sourceType === 'API' ? l.sourceDocNo ?? null : null, partyName: l.partyName ?? null,
      })),
      bills: threeplBills,
    });
    const fairBlocks: FairBlock[] = opened.filter((x) => x.startDate! >= f && x.startDate! <= t).map((x) => {
      const b = fairBooks.get(x.id);
      const col = b ? (b.pnl.by_so ?? b.pnl.by_sales) : null;
      return fairBlock({
        fair: { id: x.id, code: x.code, name: x.name, venue: x.venue, startDate: x.startDate, endDate: x.endDate, region: fairRegion(x) },
        salesRm: col?.sales ?? 0, fairIncomeBp: setup.fairIncomeBp, lines: (b?.lines ?? []) as FairLineIn[],
        books: { setupRm: col?.setup ?? 0, transportSetupDismantleRm: col?.transportSetupDismantle ?? 0 }, chargeDocNo: LOGISTICS_CHARGE_DOC,
      });
    });
    const noFair = (noFairRes.data ?? []).filter((l) => { const d = noFairDay.get(String(l.ap_invoice_id)); return d != null && d >= f && d <= t; });
    return {
      month: m, rows: p.rows, dos: p.dos, cost, costTotalSen: monthCostTotal(cost),
      fairs: fairBlocks, noFair: { lines: noFair.length, sen: noFair.reduce((s, l) => s + Number(l.amount_sen ?? 0), 0) },
    };
  });
  return c.json({
    ...pnl,
    tripsProblem,
    fairsProblem,
    perMonth,
    areaRates: AREAS.map((a) => ({ key: a.key, label: a.label, region: a.region, rateSen: rateOf(a, rates), defaultRateSen: a.defaultRateSen, isDefault: !rates.has(a.key) })),
  });
};

const mostCommon = (xs: readonly string[]): string | null => {
  const n = new Map<string, number>();
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
};

/** The regions of DOs read by id (a 3PL bill naming another month's DOs). */
async function readDoRegions(sb: any, companyId: number, ids: string[]): Promise<{ ok: true; regions: Map<string, RegionCode> } | { ok: false; what: string; reason: string }> {
  const res = await chunkIn<Row>(ids, (b, lo, hi) => sb.from('delivery_orders').select('id, state, city, postcode, address1, address2')
    .eq('company_id', companyId).in('id', b).order('id').range(lo, hi));
  if (res.error) return { ok: false, what: 'delivery orders', reason: res.error.message };
  return {
    ok: true,
    regions: new Map(res.data.map((d) => [String(d.id), regionOfDo({
      state: d.state == null ? null : String(d.state), city: d.city == null ? null : String(d.city),
      postcode: d.postcode == null ? null : String(d.postcode),
      address: [d.address1, d.address2].filter((x) => x != null && x !== '').join(' | ') || null,
    }).code] as const)),
  };
}

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

/** PUT /logistics/fair-income-rate — { pct }: the share of each fair's sales counted as
    Transport Income (1% to start, owner 2026-11-05); 0–100, two decimals at most. */
export const saveFairIncomeRateHandler = async (c: any): Promise<Response> => {
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
    { company_id: co.companyId, fair_income_bp: bp, updated_at: new Date().toISOString(), updated_by: actorOf(c) },
    { onConflict: 'company_id' },
  );
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  return c.json({ ok: true, fairIncomeBp: bp });
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
