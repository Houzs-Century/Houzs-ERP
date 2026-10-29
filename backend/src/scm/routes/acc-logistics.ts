// ----------------------------------------------------------------------------
// acc-logistics — the Logistics cost report (owner 2026-10-29: 物流报告 按地区、
// 每趟、setup & dismantle —「都需要」; 自己罗厘的成本也要算 →「那就先算 overall
// … trip 除成本」). Registered on the /acc-events router beside Event costs and
// Event Commission, behind the same Finance › Accounting guard:
//
//   GET /logistics?from=&to=        the report (scm/lib/logistics-cost.ts decides)
//   GET /logistics/settings         which accounts are our lorries' cost: the
//                                   company's own tick list, or the chart's default
//   PUT /logistics/settings         { accounts: string[] | null } — null = default
//
// The reads: the DOs of the whole months the range touches (a month's trips
// divide its whole cost) with their crews, lines and 3PL charges; the
// carriers' bill lines; the ticked accounts' postings; the fairs starting in the
// range with their books (the same reader Project Overview uses).
// ----------------------------------------------------------------------------

import { activeCompanySql, requireActiveCompanyId } from '../lib/companyScope';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { chunkIn, paginateAll } from '../lib/paginate-all';
import { todayMyt } from '../lib/my-time';
import { dateOrNull } from '../lib/date-coerce';
import { countsInTheBooks } from '../../acc/reversal-pairs';
import { booksLinesFor, readEventBooksMany } from '../lib/event-books';
import { toEventRow } from '../lib/event-tags';
import {
  buildLogisticsReport, defaultOwnCostAccounts, monthOf,
  type ChartAccount, type EventCost, type LogisticsDo, type LogisticsLorry, type OwnCostLeg, type ThreeplRun,
} from '../lib/logistics-cost';

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
const fail = (c: any, what: string, reason: string) => c.json({ error: 'load_failed', message: `The ${what} could not be read — try again.`, reason }, 500);

/** The chart, our lorries, and the company's tick list — what both doors read. */
async function loadCostSetup(sb: any, companyId: number): Promise<
  { ok: true; chart: ChartAccount[]; lorries: LogisticsLorry[]; picked: string[] | null } | { ok: false; what: string; reason: string }
> {
  const [chartRes, lorryRes, setRes] = await Promise.all([
    sb.from('accounts').select('account_code, account_name, account_type, is_active').eq('company_id', companyId),
    sb.from('lorries').select('id, plate, is_internal').eq('company_id', companyId),
    sb.from('acc_logistics_settings').select('own_cost_accounts').eq('company_id', companyId).maybeSingle(),
  ]);
  if (chartRes.error) return { ok: false, what: 'chart of accounts', reason: chartRes.error.message };
  if (lorryRes.error) return { ok: false, what: 'lorries', reason: lorryRes.error.message };
  if (setRes.error) return { ok: false, what: 'settings', reason: setRes.error.message };
  const own = (setRes.data as { own_cost_accounts?: string[] | null } | null)?.own_cost_accounts ?? null;
  return {
    ok: true,
    chart: (chartRes.data ?? []) as ChartAccount[],
    lorries: ((lorryRes.data ?? []) as Row[]).map((l) => ({ id: String(l.id), plate: String(l.plate ?? ''), isInternal: l.is_internal === true })),
    picked: own && own.length > 0 ? own.map(String) : null,
  };
}

/* ── GET /logistics ───────────────────────────────────────────────────────── */
export const logisticsCostHandler = async (c: any): Promise<Response> => {
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
  const accounts = setup.picked ?? defaultOwnCostAccounts(setup.chart, setup.lorries);

  /* The DOs going out in the whole months: by the customer delivery date Delivery
     Planning schedules, else — none scheduled — by the DO's own date. */
  const DO_COLS = 'id, do_number, so_doc_no, status, state, city, postcode, address1, address2, do_date, customer_delivery_date';
  const [scheduled, unscheduled] = await Promise.all([
    paginateAll<Row>((lo, hi) => sb.from('delivery_orders').select(DO_COLS).eq('company_id', companyId).neq('status', 'CANCELLED')
      .gte('customer_delivery_date', wholeFrom).lte('customer_delivery_date', wholeTo).order('id').range(lo, hi)),
    paginateAll<Row>((lo, hi) => sb.from('delivery_orders').select(DO_COLS).eq('company_id', companyId).neq('status', 'CANCELLED')
      .is('customer_delivery_date', null).gte('do_date', wholeFrom).lte('do_date', wholeTo).order('id').range(lo, hi)),
  ]);
  if (scheduled.error) return fail(c, 'delivery orders', scheduled.error.message);
  if (unscheduled.error) return fail(c, 'delivery orders', unscheduled.error.message);
  const doRows = [...(scheduled.data ?? []), ...(unscheduled.data ?? [])];
  const doIds = [...new Set(doRows.map((d) => String(d.id)))];
  const soNos = [...new Set(doRows.map((d) => d.so_doc_no).filter((x) => x != null && x !== '').map(String))];

  /* Their orders' address lines too: a DO copies two of them, and a Singapore
     order keyed with no state says SINGAPORE only on a later one. */
  const [crew, items, charges, orders] = await Promise.all([
    chunkIn<Row>(doIds, (b, lo, hi) => sb.from('delivery_order_crew').select('do_id, lorry_id, lorry_plate')
      .eq('company_id', companyId).in('do_id', b).order('do_id').range(lo, hi)),
    chunkIn<Row>(doIds, (b, lo, hi) => sb.from('delivery_order_items').select('id, delivery_order_id, line_total_sen')
      .eq('company_id', companyId).in('delivery_order_id', b).order('id').range(lo, hi)),
    chunkIn<Row>(doIds, (b, lo, hi) => sb.from('threepl_do_charges').select('id, do_id, billed_sen')
      .eq('company_id', companyId).in('do_id', b).order('id').range(lo, hi)),
    chunkIn<Row>(soNos, (b, lo, hi) => sb.from('mfg_sales_orders').select('doc_no, address1, address2, address3, address4')
      .eq('company_id', companyId).in('doc_no', b).order('doc_no').range(lo, hi)),
  ]);
  if (crew.error) return fail(c, 'delivery crews', crew.error.message);
  if (items.error) return fail(c, 'delivery order lines', items.error.message);
  if (charges.error) return fail(c, '3PL charges', charges.error.message);
  if (orders.error) return fail(c, 'sales orders', orders.error.message);

  const linesOf = (r: Row | undefined, keys: string[]): string[] => (r ? keys.map((k) => String(r[k] ?? '').trim()).filter(Boolean) : []);
  const orderOf = new Map(orders.data.map((o) => [String(o.doc_no), o] as const));
  const crewOf = new Map(crew.data.map((r) => [String(r.do_id), r] as const));
  const valueOf = new Map<string, number>();
  for (const it of items.data) valueOf.set(String(it.delivery_order_id), (valueOf.get(String(it.delivery_order_id)) ?? 0) + Number(it.line_total_sen ?? 0));
  const seen = new Set<string>();
  const dos: LogisticsDo[] = [];
  for (const d of doRows) {
    const id = String(d.id);
    if (seen.has(id)) continue;
    seen.add(id);
    const when = day(d.customer_delivery_date) ?? day(d.do_date);
    if (!when) continue;
    const k = crewOf.get(id);
    dos.push({
      id, doNumber: String(d.do_number ?? id), soDocNo: d.so_doc_no == null ? null : String(d.so_doc_no), day: when,
      state: d.state == null ? null : String(d.state),
      city: d.city == null ? null : String(d.city), postcode: d.postcode == null ? null : String(d.postcode),
      address: [...linesOf(d, ['address1', 'address2']),
        ...linesOf(d.so_doc_no == null ? undefined : orderOf.get(String(d.so_doc_no)), ['address1', 'address2', 'address3', 'address4'])].join(' | ') || null,
      valueSen: valueOf.get(id) ?? 0,
      crewLorryId: k?.lorry_id == null ? null : String(k.lorry_id), crewPlate: k?.lorry_plate == null ? null : String(k.lorry_plate),
    });
  }

  /* The carriers' bill lines: the runs (assigned to DOs), what nobody assigned,
     and the fair lines with no fair. */
  const lines = await paginateAll<Row>((lo, hi) => sb.from('threepl_bill_lines')
    .select('id, ap_invoice_id, threepl_company_id, line_date, amount_sen, do_ids, text, assign, project_id')
    .eq('company_id', companyId).order('id').range(lo, hi));
  if (lines.error) return fail(c, '3PL bill lines', lines.error.message);
  const billLines = lines.data ?? [];
  const runLines = billLines.filter((l) => l.assign === 'do' && Array.isArray(l.do_ids) && l.do_ids.length > 0);
  const apIds = [...new Set(runLines.map((l) => String(l.ap_invoice_id)))];
  const carrierIds = [...new Set(runLines.map((l) => l.threepl_company_id).filter((x) => x != null).map(String))];
  const [bills, carriers] = await Promise.all([
    chunkIn<Row>(apIds, (b, lo, hi) => sb.from('ap_invoices').select('id, invoice_number, invoice_date')
      .eq('company_id', companyId).in('id', b).order('id').range(lo, hi)),
    chunkIn<Row>(carrierIds, (b, lo, hi) => sb.from('threepl_companies').select('id, name')
      .eq('company_id', companyId).in('id', b).order('id').range(lo, hi)),
  ]);
  if (bills.error) return fail(c, 'AP invoices', bills.error.message);
  if (carriers.error) return fail(c, '3PL companies', carriers.error.message);
  const billOf = new Map(bills.data.map((b) => [String(b.id), b] as const));
  const carrierOf = new Map(carriers.data.map((x) => [String(x.id), String(x.name ?? '')] as const));
  const runs: ThreeplRun[] = runLines.map((l) => ({
    lineId: String(l.id), apInvoiceNo: billOf.get(String(l.ap_invoice_id))?.invoice_number ?? null,
    carrier: l.threepl_company_id == null ? null : carrierOf.get(String(l.threepl_company_id)) ?? null,
    lineDate: day(l.line_date), invoiceDate: day(billOf.get(String(l.ap_invoice_id))?.invoice_date),
    amountSen: Number(l.amount_sen ?? 0), doIds: (l.do_ids as unknown[]).map(String), text: String(l.text ?? ''),
  }));
  const tally = (rows: Row[]) => ({ count: rows.length, sen: rows.reduce((s, l) => s + Number(l.amount_sen ?? 0), 0) });
  const openLines = tally(billLines.filter((l) => l.assign == null && Number(l.amount_sen ?? 0) !== 0));
  const eventLinesNoFair = tally(billLines.filter((l) => l.assign === 'event' && l.project_id == null));

  /* Our lorries' cost: what the ticked accounts booked in the whole months — a
     cancelled or corrected document's pair left out, the opening never. */
  let ownCost: OwnCostLeg[] = [];
  if (accounts.length > 0) {
    const legs = await chunkIn<Row>(accounts, (b, lo, hi) => sb.from('v_gl_entries')
      .select('line_id, account_code, account_name, entry_date, debit_sen, credit_sen, posted, reversed, reversed_by_je, opening')
      .eq('company_id', companyId).in('account_code', b).gte('entry_date', wholeFrom).lte('entry_date', wholeTo)
      .order('line_id').range(lo, hi));
    if (legs.error) return fail(c, 'ledger', legs.error.message);
    ownCost = legs.data.filter((l) => l.opening !== true && countsInTheBooks(l)).map((l) => ({
      month: monthOf(String(l.entry_date)), accountCode: String(l.account_code), accountName: l.account_name == null ? null : String(l.account_name),
      amountSen: Number(l.debit_sen ?? 0) - Number(l.credit_sen ?? 0),
    }));
  }

  /* Setup & dismantle: the fairs starting in the range, each from its own books. */
  let events: EventCost[] = [];
  let eventsProblem: string | null = null;
  if (c.env?.DB) {
    try {
      const res = await c.env.DB.prepare(
        `SELECT p.id AS id, p.code AS code, p.name AS name, p.start_date AS startdate, p.end_date AS enddate,
                p.status AS status, p.archived_at AS archivedat
           FROM projects p
          WHERE p.start_date IS NOT NULL AND p.start_date >= ? AND p.start_date <= ?${activeCompanySql(c, 'p.company_id')}
          ORDER BY p.start_date, p.id`,
      ).bind(from, to).all();
      const fairs = ((res.results ?? []) as Row[]).map(toEventRow).filter((e) => Number.isFinite(e.id));
      const books = await readEventBooksMany(c.env.DB, fairs.map((e) => e.id), companyId);
      if (!books.ok) eventsProblem = books.reason;
      else {
        events = fairs.map((e) => {
          const ls = booksLinesFor(e.id, books.byProject.get(e.id) ?? []);
          const sumOf = (row: string) => ls.filter((l) => l.category === row).reduce((s, l) => s + Math.round(Number(l.amount) * 100), 0);
          return { id: e.id, code: e.code, name: e.name, startDate: e.startDate, endDate: e.endDate, setupSen: sumOf('setup'), transportSen: sumOf('transport_setup_dismantle') };
        }).filter((e) => e.setupSen !== 0 || e.transportSen !== 0);
      }
    } catch (e) {
      eventsProblem = String((e as Error)?.message ?? e);
    }
  } else {
    eventsProblem = 'the event books are not reachable from here';
  }

  const report = buildLogisticsReport({
    from, to, dos, lorries: setup.lorries,
    charges: charges.data.map((ch) => ({ doId: String(ch.do_id), billedSen: Number(ch.billed_sen ?? 0) })),
    runs, ownCost, events, openLines, eventLinesNoFair,
  });
  return c.json({ ...report, ownCostAccounts: accounts, ownCostDefault: setup.picked == null, eventsProblem });
};

/* ── GET /logistics/settings ──────────────────────────────────────────────── */
export const logisticsSettingsHandler = async (c: any): Promise<Response> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const setup = await loadCostSetup(c.get('supabase'), co.companyId);
  if (!setup.ok) return fail(c, setup.what, setup.reason);
  const defaults = defaultOwnCostAccounts(setup.chart, setup.lorries);
  const candidates = setup.chart
    .filter((a) => String(a.account_type ?? '').toUpperCase() === 'EXPENSE' && a.is_active !== false)
    .map((a) => ({ code: a.account_code, name: a.account_name }))
    .sort((a, b) => a.code.localeCompare(b.code));
  return c.json({ picked: setup.picked, defaults, candidates });
};

/* ── PUT /logistics/settings — { accounts: string[] | null } ─────────────────
   Finance's call (the money right, like every setup card). Every code must be an
   active expense account of this company; null or [] goes back to the default. */
export const saveLogisticsSettingsHandler = async (c: any): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.post')) return c.json({ error: "You don't have permission to change the logistics cost accounts." }, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const raw = body?.accounts;
  if (raw != null && !Array.isArray(raw)) return c.json({ error: 'bad_accounts', message: 'accounts must be a list of account codes, or null for the default.' }, 400);
  const codes = [...new Set(((raw ?? []) as unknown[]).map((x) => String(x ?? '').trim()).filter(Boolean))].sort();
  const sb = c.get('supabase');
  if (codes.length > 0) {
    const { data, error } = await sb.from('accounts').select('account_code, account_type, is_active').eq('company_id', co.companyId).in('account_code', codes);
    if (error) return fail(c, 'chart of accounts', error.message);
    const ok = new Set(((data ?? []) as Row[]).filter((a) => String(a.account_type ?? '').toUpperCase() === 'EXPENSE' && a.is_active !== false).map((a) => String(a.account_code)));
    const bad = codes.filter((x) => !ok.has(x));
    if (bad.length > 0) return c.json({ error: 'not_expense_accounts', message: `Not an active expense account of this company: ${bad.join(', ')}.` }, 400);
  }
  const actor = (c.get('houzsUser') as { name?: string } | undefined)?.name ?? null;
  const { error } = await sb.from('acc_logistics_settings').upsert(
    { company_id: co.companyId, own_cost_accounts: codes, updated_at: new Date().toISOString(), updated_by: actor },
    { onConflict: 'company_id' },
  );
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  return c.json({ ok: true, picked: codes.length > 0 ? codes : null });
};
