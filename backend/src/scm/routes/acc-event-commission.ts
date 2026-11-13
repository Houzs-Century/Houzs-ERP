// GET /acc-events/commission?from=YYYY-MM-DD&to=YYYY-MM-DD[&basis=so_date] —
// Accounting › Reports › Event Commission (owner 2026-10-20), by fair (default)
// or by the order's SO date. The rules and the two parts are
// scm/lib/event-commission.ts's; this reads what they need:
//   · the fairs starting in the range, with the event page's Total Sales and its
//     Commission row (services/eventPnlBatch.ts — the same figures);
//   · their orders, and the orders of EARLIER fairs that something happened to
//     in the range (a payment, a recorded upsale / drop, a cancellation);
//   · those orders' payments, recorded goods changes and cancellations, whole
//     (reaching 30% and "goods on a day" need the full history);
//   · each fair brand's rate card.
//
// Closing a month (owner 2026-10-26: 关月, Finance): POST /commission/close
// freezes a month — both bases — in scm.event_commission_closes; from then on
// the month's own range is served as closed, and the first open month carries
// what changed for the closed months' orders since (「X 月调整」, the lib's
// monthAdjustmentsOf). POST /commission/reopen undoes the latest close only.
//
// Finance's two buttons (owner 2026-11-12, 「1个这张单不要算，1个是这个算下个月」):
// POST /commission/marks { docNo, kind: 'exclude' | 'defer', month?, reason? }
// marks an order — not counted at all, or what it earns in an open month paid
// the month after; POST /commission/marks/undo { id } takes the mark away. Every
// report applies the marks (the lib's withMarks), the closed months' recalculation
// behind the adjustments included, and a one-month report receives what the
// month before moved to it. Each mark and undo lands in the order's History.
// A third kind, 'exclude_change' with a month (「这次改价不算」, the same day): the
// order's upsales / drop sales of that month move no commission — the changes are
// flagged before the report is built (withUncountedChanges); the order still earns.
//
// Finance's own lines (owner 2026-11-13, 「做」): POST /commission/lines
// { docNo, month, goodsSen, reason } types an amount of goods, plus or minus, on
// an order for an open month — for what the system holds no record of (an upsale
// made before the order came into the ERP). It is paid in that month at the
// order's own rate, beside the report (the lib's withManualLines), and frozen
// with the month when it closes. POST /commission/lines/remove { id } takes it
// away while its month is open. Each lands in the order's History.
// Mounted under /acc-events, behind scmAreaGuard("scm.finance.accounting"):
// reading needs view; closing, reopening, marking and typing a line edit on
// Finance › Accounting.

import { requireActiveCompanyId, scopeToCompanyId } from '../lib/companyScope';
import { chunkIn, paginateAll } from '../lib/paginate-all';
import { todayMyt } from '../lib/my-time';
import { dateOrNull } from '../lib/date-coerce';
import {
  NO_FAIR_FROM, buildEventCommission, deferredInFrom, manualLineRows, monthAdjustmentsOf, monthOfRange, paidByOrder, withManualLines, withMarks, withMonthAdjustments,
  withUncountedChanges,
  type ClosedMonthPaid, type CommissionBasis, type CommissionCancel, type CommissionChange, type CommissionFair, type CommissionManualLine, type CommissionMark,
  type CommissionPayment, type CommissionSo, type DeferredInRow, type EventCommissionReport, type ManualLineRow, type MonthAdjustmentRow,
} from '../lib/event-commission';
import { assertAuditWritable, auditUnavailableBody, recordEntityAudit } from '../lib/entity-audit';
import { recordSoAudit } from '../lib/so-audit';
import { pnlForProjects } from '../../services/eventPnlBatch';
import { loadCostRates } from '../../services/eventPnlInputs';
import { LEDGER_COST_CATEGORIES } from '../../services/projects';

const MAX_RANGE_DAYS = 400;
const n = (v: unknown): number => { const x = Number(v ?? 0); return Number.isFinite(x) ? x : 0; };
/* A DATE as YYYY-MM-DD and a stamp as ISO, whichever shape the client hands
   back: PostgREST sends text, a direct postgres.js read (the read-only dry runs)
   sends Date objects — and "Fri Oct 02 2026".slice(0, 10) is not a day. */
const dayOf = (v: unknown): string | null => {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString().slice(0, 10) : null;
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
};
const stampOf = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v ?? ''));
const monthStart = (ymd: string) => `${ymd.slice(0, 7)}-01`;
const monthEnd = (ymd: string) => {
  const d = new Date(`${ymd.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
};

type SoRead = {
  doc_no: string; project_id: number | string | null; salesperson_id: string | null; debtor_name: string | null;
  status: string; on_hold: boolean | null; mattress_sofa_sen: number | null; bedframe_sen: number | null;
  accessories_sen: number | null; others_sen: number | null; local_total_sen: number | null;
  total_revenue_sen: number | null; created_at: string; so_date: string | null; customer_so_no: string | null;
  branding: string | null; vp_brand: string | null; venue: string | null;
};
const SO_COLS = 'doc_no, project_id, salesperson_id, debtor_name, status, on_hold, mattress_sofa_sen, bedframe_sen, accessories_sen, others_sen, local_total_sen, total_revenue_sen, created_at, so_date, customer_so_no, branding, vp_brand, venue';

type FairRead = {
  id: number | string; name: string | null; brand: string | null; start_date: string | null; end_date: string | null; archived_at: string | null; status: string | null; total_sales: number | string | null;
  organizer: string | null; venue: string | null; state: string | null;
};
const FAIR_SQL = `SELECT p.id, p.name, p.brand, p.start_date, p.end_date, p.archived_at, p.status, pf.total_sales, p.organizer, p.venue, p.state
                    FROM projects p LEFT JOIN project_finance pf ON pf.project_id = p.id`;

const fail = (c: any, what: string, reason: string) =>
  c.json({ error: 'load_failed', message: `The ${what} could not be read — try again.`, reason }, 500);

/** A sales order row as the lib reads it. */
const commissionSoOf = (s: SoRead, staffName: ReadonlyMap<string, string | null>): CommissionSo => ({
  docNo: s.doc_no, projectId: s.project_id == null ? null : Number(s.project_id), salesperson: s.salesperson_id ? staffName.get(s.salesperson_id) ?? null : null,
  customer: s.debtor_name, status: String(s.status ?? '').toUpperCase(), onHold: s.on_hold === true,
  goodsSen: n(s.mattress_sofa_sen) + n(s.bedframe_sen) + n(s.accessories_sen) + n(s.others_sen),
  totalSen: n(s.total_revenue_sen) > 0 ? n(s.total_revenue_sen) : n(s.local_total_sen),
  createdAt: stampOf(s.created_at),
  soDate: dayOf(s.so_date),
  ref: s.customer_so_no?.trim() || null,
  brand: s.branding?.trim() || null,
  vpBrand: s.vp_brand?.trim() || null,
  venue: s.venue?.trim() || null,
});

type Live = { report: EventCommissionReport } | { response: Response };

/** The report for [from, to] as the data stands now; the price changes Finance
 *  left out (`marks`, 「这次改价不算」) move no commission in it. */
async function liveReport(c: any, companyId: number, from: string, to: string, basis: CommissionBasis, marks: readonly CommissionMark[]): Promise<Live> {
  const env = c.env;
  const sb = c.get('supabase');
  const fromTs = `${from}T00:00:00+08:00`;
  const toTs = `${to}T23:59:59.999+08:00`;
  const fail = (_c: any, what: string, reason: string): Live => ({
    response: _c.json({ error: 'load_failed', message: `The ${what} could not be read — try again.`, reason }, 500),
  });

  /* 1–2. Part 1's orders. By fair: the fairs starting in the range and all their
     orders. By SO date: every order opened in the range — one with no fair too
     (owner 2026-11-12: 「全部列出来，没有展会的标 No fair，要算佣金」). */
  let rangeFairs: FairRead[] = [];
  let partOne: { data: SoRead[]; error: { message: string } | null };
  if (basis === 'fair') {
    try {
      const res = await env.DB.prepare(`${FAIR_SQL}
         WHERE p.company_id = ? AND p.start_date IS NOT NULL AND p.start_date >= ? AND p.start_date <= ?
         ORDER BY p.start_date, p.id`).bind(companyId, from, to).all();
      rangeFairs = (res.results ?? []) as FairRead[];
    } catch (e) {
      return fail(c, 'fairs', String((e as Error)?.message ?? e));
    }
    partOne = await chunkIn<SoRead, number>(rangeFairs.map((f) => Number(f.id)), (batch, lo, hi) =>
      scopeToCompanyId(sb.from('mfg_sales_orders').select(SO_COLS).in('project_id', batch), companyId).order('doc_no').range(lo, hi));
  } else {
    const opened = await paginateAll<SoRead>((lo, hi) =>
      scopeToCompanyId(sb.from('mfg_sales_orders').select(SO_COLS).gte('so_date', from).lte('so_date', to), companyId)
        .order('doc_no').range(lo, hi));
    partOne = { data: opened.data ?? [], error: opened.error };
  }
  if (partOne.error) return fail(c, 'orders', partOne.error.message);
  const rangeIds = rangeFairs.map((f) => Number(f.id));

  /* 3. Orders of earlier fairs (by fair) / opened earlier (by SO date) that
     something happened to in the range. */
  const [payIn, chIn, cancelIn] = await Promise.all([
    paginateAll<{ so_doc_no: string }>((lo, hi) =>
      scopeToCompanyId(sb.from('mfg_sales_order_payments').select('so_doc_no').gte('paid_at', from).lte('paid_at', to), companyId).order('so_doc_no').range(lo, hi)),
    paginateAll<{ so_doc_no: string }>((lo, hi) =>
      scopeToCompanyId(sb.from('so_total_changes').select('so_doc_no').gte('changed_at', fromTs).lte('changed_at', toTs), companyId).order('so_doc_no').range(lo, hi)),
    paginateAll<{ doc_no: string }>((lo, hi) =>
      sb.from('mfg_so_status_changes').select('doc_no').eq('to_status', 'CANCELLED').gte('created_at', fromTs).lte('created_at', toTs).order('doc_no').range(lo, hi)),
  ]);
  if (payIn.error || chIn.error || cancelIn.error) {
    return fail(c, 'payments and changes', (payIn.error ?? chIn.error ?? cancelIn.error)!.message);
  }
  const known = new Set(partOne.data.map((s) => s.doc_no));
  const touched = [...new Set([
    ...(payIn.data ?? []).map((r) => r.so_doc_no), ...(chIn.data ?? []).map((r) => r.so_doc_no), ...(cancelIn.data ?? []).map((r) => r.doc_no),
  ])].filter((d) => d && !known.has(d));
  /* By SO date an order with no fair counts too, from NO_FAIR_FROM (the old ones
     before it stay out); by fair only orders on a fair. */
  const partTwoRead = await chunkIn<SoRead, string>(touched, (batch, lo, hi) => {
    const q = scopeToCompanyId(sb.from('mfg_sales_orders').select(SO_COLS).in('doc_no', batch), companyId);
    return (basis === 'fair' ? q.not('project_id', 'is', null) : q).order('doc_no').range(lo, hi);
  });
  if (partTwoRead.error) return fail(c, 'orders', partTwoRead.error.message);
  /* …and an older order with no fair whose price changed in the range: its
     upsales and drop sales count (owner 2026-11-13) — or that was cancelled in
     it: it gives back what it was paid on (owner 2026-11-13, 「要扣」). */
  const changedInRange = new Set((chIn.data ?? []).map((r) => r.so_doc_no));
  const cancelledInRange = new Set((cancelIn.data ?? []).map((r) => r.doc_no));
  const twoRows = basis === 'so_date'
    ? partTwoRead.data.filter((s) => s.project_id != null || (dayOf(s.so_date) ?? '') >= NO_FAIR_FROM || changedInRange.has(s.doc_no) || cancelledInRange.has(s.doc_no))
    : partTwoRead.data;

  /* The fairs the rest needs: by fair, the earlier fairs of those orders (started
     before the range); by SO date, every fair any of the orders is on. */
  const readFairs = async (ids: number[], startedBefore: string | null): Promise<FairRead[]> => {
    if (ids.length === 0) return [];
    const res = await env.DB.prepare(`${FAIR_SQL}
       WHERE p.company_id = ? AND p.id IN (${ids.map(() => '?').join(', ')})${startedBefore ? ' AND p.start_date < ?' : ''}`)
      .bind(companyId, ...ids, ...(startedBefore ? [startedBefore] : [])).all();
    return (res.results ?? []) as FairRead[];
  };
  const fairIdsOf = (rows: SoRead[]) => [...new Set(rows.filter((s) => s.project_id != null).map((s) => Number(s.project_id)).filter((id) => Number.isInteger(id)))];
  let earlierFairs: FairRead[];
  let partTwo: SoRead[];
  try {
    if (basis === 'fair') {
      earlierFairs = await readFairs(fairIdsOf(twoRows).filter((id) => !rangeIds.includes(id)), from);
      const earlierSet = new Set(earlierFairs.map((f) => Number(f.id)));
      partTwo = twoRows.filter((s) => earlierSet.has(Number(s.project_id)));
    } else {
      partTwo = twoRows.filter((s) => (dayOf(s.so_date) ?? '9999-12-31') < from);
      earlierFairs = await readFairs(fairIdsOf([...partOne.data, ...partTwo]), null);
    }
  } catch (e) {
    return fail(c, 'fairs', String((e as Error)?.message ?? e));
  }

  /* 4. Every order's whole history: payments, goods changes, cancellations; and the names. */
  const sos = [...partOne.data, ...partTwo];
  const docs = sos.map((s) => s.doc_no);
  const staffIds = [...new Set(sos.map((s) => s.salesperson_id).filter((v): v is string => !!v))];
  const [pays, chs, cancels, staff] = await Promise.all([
    chunkIn<{ so_doc_no: string; paid_at: string; amount_sen: number }, string>(docs, (batch, lo, hi) =>
      scopeToCompanyId(sb.from('mfg_sales_order_payments').select('so_doc_no, paid_at, amount_sen').in('so_doc_no', batch), companyId).order('so_doc_no').range(lo, hi)),
    chunkIn<Record<string, unknown>, string>(docs, (batch, lo, hi) =>
      scopeToCompanyId(sb.from('so_total_changes')
        .select('so_doc_no, changed_at, before_goods_sen, after_goods_sen, before_total_sen, after_total_sen, source, changed_by')
        .in('so_doc_no', batch), companyId).order('changed_at').range(lo, hi)),
    chunkIn<{ doc_no: string; created_at: string }, string>(docs, (batch, lo, hi) =>
      sb.from('mfg_so_status_changes').select('doc_no, created_at').eq('to_status', 'CANCELLED').in('doc_no', batch).order('created_at').range(lo, hi)),
    chunkIn<{ id: string; name: string | null }, string>(staffIds, (batch, lo, hi) =>
      sb.from('staff').select('id, name').in('id', batch).order('id').range(lo, hi)),
  ]);
  for (const r of [pays, chs, cancels, staff]) if (r.error) return fail(c, 'order history', r.error.message);

  /* 5. The event page's figures for the range's fairs, and the rate cards. */
  const fairsRead = [...rangeFairs, ...earlierFairs];
  let rates: Awaited<ReturnType<typeof loadCostRates>>;
  try {
    /* By SO date an order with no fair earns at its own brand's rate: every rate
       card is read, so its brand is found whatever its case. */
    const cards = basis === 'so_date'
      ? ((await env.DB.prepare('SELECT brand FROM project_cost_rates').bind().all()).results ?? []).map((r: Record<string, unknown>) => String(r.brand ?? ''))
      : [];
    rates = await loadCostRates(env, [...fairsRead.map((f) => f.brand), ...cards]);
  } catch (e) {
    return fail(c, 'rate cards', String((e as Error)?.message ?? e));
  }
  const pnl = await pnlForProjects(env, rangeFairs.map((f) => ({ id: Number(f.id), brand: f.brand, total_sales: f.total_sales })), companyId, LEDGER_COST_CATEGORIES);

  const staffName = new Map(staff.data.map((s) => [s.id, s.name]));
  const hasOrders = new Set(sos.map((s) => Number(s.project_id)));
  const fairs: CommissionFair[] = fairsRead
    .filter((f) => hasOrders.has(Number(f.id)) || (f.archived_at == null && String(f.status ?? '').toLowerCase() !== 'cancelled'))
    .map((f) => {
      const p = pnl.get(Number(f.id))?.by_sales;
      return {
        id: Number(f.id), name: String(f.name ?? `#${f.id}`), brand: f.brand, startDate: dayOf(f.start_date) ?? '',
        endDate: dayOf(f.end_date),
        totalSalesRm: p ? p.sales : (f.total_sales == null ? null : n(f.total_sales)),
        estimateRm: p ? p.commission.amount : null,
        organizer: f.organizer ?? null, venue: f.venue ?? null, state: f.state ?? null,
      };
    });
  const report = buildEventCommission({
    basis, from, to, fairs,
    ratePctByBrand: new Map([...rates].map(([brand, r]) => [brand, r.commission_normal_pct ?? null])),
    sos: sos.map((s) => commissionSoOf(s, staffName)),
    payments: pays.data.map((p): CommissionPayment => ({ docNo: p.so_doc_no, paidAt: dayOf(p.paid_at) ?? stampOf(p.paid_at), amountSen: n(p.amount_sen) })),
    changes: withUncountedChanges(chs.data.map((r): CommissionChange => ({
      docNo: String(r.so_doc_no), changedAt: stampOf(r.changed_at),
      beforeGoodsSen: n(r.before_goods_sen), afterGoodsSen: n(r.after_goods_sen),
      beforeTotalSen: n(r.before_total_sen), afterTotalSen: n(r.after_total_sen),
      source: String(r.source ?? 'edit'), changedBy: (r.changed_by as string | null) ?? null,
      uncounted: false,
    })), marks),
    cancels: cancels.data.map((r): CommissionCancel => ({ docNo: r.doc_no, at: stampOf(r.created_at) })),
  });
  return { report };
}

/* ── Closed months ───────────────────────────────────────────────────────── */

type CloseRead = {
  month: string; closed_at: string; closed_by: string | null;
  paid: Partial<Record<CommissionBasis, Record<string, number>>> | null;
  carried: Partial<Record<CommissionBasis, ClosedMonthPaid['carried']>> | null;
};
type Closed = { month: string; closedAt: string; closedBy: string | null; read: CloseRead | null };
/** How many closed months back the first open month still settles. */
const ADJUST_MONTHS_BACK = 12;
const ym = (v: unknown): string => (dayOf(v) ?? '').slice(0, 7);
const nextMonth = (month: string): string => {
  const d = new Date(`${month}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 7);
};
/** "2026-09" → "2026/09": a month in the one date format (year first, numeric — owner 2026-08-18 / 2026-09-25). */
export const monthLabel = (month: string): string => month.replace('-', '/');

async function readCloses(sb: any, companyId: number): Promise<{ closes: Closed[] } | { error: string }> {
  const { data, error } = await scopeToCompanyId(
    sb.from('event_commission_closes').select('month, closed_at, closed_by, paid, carried'), companyId).order('month');
  if (error) return { error: error.message };
  return { closes: ((data ?? []) as CloseRead[]).map((r) => ({ month: ym(r.month), closedAt: stampOf(r.closed_at), closedBy: r.closed_by ?? null, read: r })) };
}
const closesMeta = (closes: readonly Closed[]) => ({
  months: closes.map((k) => k.month),
  openFrom: closes.length > 0 ? nextMonth(closes[closes.length - 1]!.month) : null,
});

/* ── Finance's marks ─────────────────────────────────────────────────────── */

type MarkRead = { id: string; so_doc_no: string; kind: string; month: string | null; reason: string | null; marked_by: string | null; marked_at: string };
const MARK_COLS = 'id, so_doc_no, kind, month, reason, marked_by, marked_at';
const markOf = (r: MarkRead): CommissionMark => ({
  id: String(r.id), docNo: r.so_doc_no, kind: r.kind === 'defer' || r.kind === 'exclude_change' ? r.kind : 'exclude', month: r.month ? ym(r.month) : null,
  reason: r.reason ?? null, markedBy: r.marked_by ?? null, markedAt: stampOf(r.marked_at),
});
async function readMarks(sb: any, companyId: number): Promise<{ marks: CommissionMark[] } | { error: string }> {
  const res = await paginateAll<MarkRead>((lo, hi) =>
    scopeToCompanyId(sb.from('event_commission_marks').select(MARK_COLS), companyId).order('marked_at').range(lo, hi));
  if (res.error) return { error: res.error.message };
  return { marks: (res.data ?? []).map(markOf) };
}

/* ── Finance's own lines ─────────────────────────────────────────────────── */

type LineRead = { id: string; so_doc_no: string; month: string; goods_sen: number | string; reason: string | null; added_by: string | null; added_at: string };
const LINE_COLS = 'id, so_doc_no, month, goods_sen, reason, added_by, added_at';
const lineOf = (r: LineRead): CommissionManualLine => ({
  id: String(r.id), docNo: r.so_doc_no, month: ym(r.month), goodsSen: n(r.goods_sen),
  reason: r.reason ?? null, addedBy: r.added_by ?? null, addedAt: stampOf(r.added_at),
});
async function readLines(sb: any, companyId: number): Promise<{ lines: CommissionManualLine[] } | { error: string }> {
  const res = await paginateAll<LineRead>((lo, hi) =>
    scopeToCompanyId(sb.from('event_commission_lines').select(LINE_COLS), companyId).order('added_at').range(lo, hi));
  if (res.error) return { error: res.error.message };
  return { lines: (res.data ?? []).map(lineOf) };
}

/** Finance's lines on their orders' places: the orders, their fairs and the
 *  rate cards are read here — an order with a line need not be on the report. */
async function manualRowsFor(c: any, companyId: number, basis: CommissionBasis, lines: readonly CommissionManualLine[]): Promise<{ rows: ManualLineRow[] } | { response: Response }> {
  const env = c.env;
  const sb = c.get('supabase');
  const docs = [...new Set(lines.map((l) => l.docNo))];
  const read = await chunkIn<SoRead, string>(docs, (batch, lo, hi) =>
    scopeToCompanyId(sb.from('mfg_sales_orders').select(SO_COLS).in('doc_no', batch), companyId).order('doc_no').range(lo, hi));
  if (read.error) return { response: fail(c, 'orders', read.error.message) };
  const sos = read.data;
  const fairIds = [...new Set(sos.filter((s) => s.project_id != null).map((s) => Number(s.project_id)).filter((id) => Number.isInteger(id)))];
  let fairsRead: FairRead[] = [];
  let rates: Awaited<ReturnType<typeof loadCostRates>>;
  try {
    if (fairIds.length > 0) {
      const res = await env.DB.prepare(`${FAIR_SQL}
         WHERE p.company_id = ? AND p.id IN (${fairIds.map(() => '?').join(', ')})`).bind(companyId, ...fairIds).all();
      fairsRead = (res.results ?? []) as FairRead[];
    }
    /* An order with no fair earns at its own brand's card, whatever its case: read them all. */
    const cards = ((await env.DB.prepare('SELECT brand FROM project_cost_rates').bind().all()).results ?? []).map((r: Record<string, unknown>) => String(r.brand ?? ''));
    rates = await loadCostRates(env, [...fairsRead.map((f) => f.brand), ...cards]);
  } catch (e) {
    return { response: fail(c, 'rate cards', String((e as Error)?.message ?? e)) };
  }
  const staffIds = [...new Set(sos.map((s) => s.salesperson_id).filter((v): v is string => !!v))];
  const staff = await chunkIn<{ id: string; name: string | null }, string>(staffIds, (batch, lo, hi) =>
    sb.from('staff').select('id, name').in('id', batch).order('id').range(lo, hi));
  if (staff.error) return { response: fail(c, 'order history', staff.error.message) };
  const staffName = new Map(staff.data.map((s) => [s.id, s.name]));
  return {
    rows: manualLineRows({
      lines, basis,
      sos: sos.map((s) => commissionSoOf(s, staffName)),
      fairs: fairsRead.map((f): CommissionFair => ({
        id: Number(f.id), name: String(f.name ?? `#${f.id}`), brand: f.brand, startDate: dayOf(f.start_date) ?? '', endDate: dayOf(f.end_date),
        totalSalesRm: null, estimateRm: null, organizer: f.organizer ?? null, venue: f.venue ?? null, state: f.state ?? null,
      })),
      ratePctByBrand: new Map([...rates].map(([brand, r]) => [brand, r.commission_normal_pct ?? null])),
    }),
  };
}

/** What every report needs besides its range: the closed months, the marks and Finance's own lines. */
type Ctx = { closes: readonly Closed[]; marks: readonly CommissionMark[]; lines: readonly CommissionManualLine[] };
/** How many months back a chain of 「算下个月」 is followed. */
const DEFER_CHAIN_MAX = 3;
const prevMonth = (month: string): string => {
  const d = new Date(`${month}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
};

/** The live report with the marks applied, and — for a report of one month (or
 *  of it so far) — what the month before moved to it. */
async function markedLive(c: any, companyId: number, from: string, to: string, basis: CommissionBasis, ctx: Ctx, depth = 0): Promise<Live> {
  const live = await liveReport(c, companyId, from, to, basis, ctx.marks);
  if ('response' in live) return live;
  const month = monthOfRange(from, to);
  let deferredIn: DeferredInRow[] = [];
  const prev = month ? prevMonth(month) : null;
  if (prev && depth < DEFER_CHAIN_MAX && ctx.marks.some((m) => m.kind === 'defer' && m.month === prev)) {
    const before = await monthReport(c, companyId, prev, basis, ctx, depth + 1);
    if ('response' in before) return before;
    deferredIn = deferredInFrom(before.report, prev);
  }
  const marked = withMarks(live.report, ctx.marks, deferredIn);
  /* Finance's own lines of the months this range begins — the same rule as the
     closed months' adjustments (the range holds the month's first day). */
  const mine = ctx.lines.filter((l) => from <= `${l.month}-01` && `${l.month}-01` <= to);
  if (mine.length === 0) return { report: marked };
  const manual = await manualRowsFor(c, companyId, basis, mine);
  if ('response' in manual) return manual;
  return { report: withManualLines(marked, manual.rows) };
}

/** One month's report: as closed when it is, else live with the marks. */
async function monthReport(c: any, companyId: number, month: string, basis: CommissionBasis, ctx: Ctx, depth: number): Promise<Live> {
  if (ctx.closes.some((k) => k.month === month)) {
    const col = basis === 'so_date' ? 'report_so_date' : 'report_fair';
    const sb = c.get('supabase');
    const { data, error } = await scopeToCompanyId(sb.from('event_commission_closes').select(col).eq('month', `${month}-01`), companyId).maybeSingle();
    if (error || !data) return { response: fail(c, 'closed month', error?.message ?? 'not found') };
    return { report: (data as Record<string, unknown>)[col] as EventCommissionReport };
  }
  return markedLive(c, companyId, `${month}-01`, monthEnd(`${month}-01`), basis, ctx, depth);
}

/** The closed months' outstanding adjustments by one basis, each month recalculated now. */
async function adjustmentsFor(c: any, companyId: number, basis: CommissionBasis, ctx: Ctx): Promise<{ rows: MonthAdjustmentRow[] } | { response: Response }> {
  const { closes } = ctx;
  const live = new Map<string, EventCommissionReport>();
  const recent = closes.slice(-ADJUST_MONTHS_BACK);
  /* Recalculated WITH the marks: an order marked "not counted" after its month
     closed drops out here, and the adjustment takes back what was paid. */
  const reads = await Promise.all(recent.map((k) => markedLive(c, companyId, `${k.month}-01`, monthEnd(`${k.month}-01`), basis, ctx)));
  for (let i = 0; i < recent.length; i += 1) {
    const r = reads[i]!;
    if ('response' in r) return r;
    live.set(recent[i]!.month, r.report);
  }
  const paid: ClosedMonthPaid[] = closes.map((k) => ({ month: k.month, paid: k.read?.paid?.[basis] ?? {}, carried: k.read?.carried?.[basis] ?? [] }));
  return { rows: monthAdjustmentsOf(paid, live) };
}

export const eventCommissionHandler = async (c: any): Promise<Response> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const today = todayMyt();
  const from = dateOrNull(c.req.query('from')) ?? monthStart(today);
  const to = dateOrNull(c.req.query('to')) ?? monthEnd(today);
  if (from > to) return c.json({ error: 'bad_range', message: 'The From date is after the To date.' }, 400);
  if ((Date.parse(to) - Date.parse(from)) / 86400e3 > MAX_RANGE_DAYS) {
    return c.json({ error: 'bad_range', message: 'Pick a range of a year or less.' }, 400);
  }
  const sb = c.get('supabase');
  const companyId = co.companyId;
  /* By fair (the fair's start) or by SO date (the order's own) — owner 2026-10-20. */
  const basis: CommissionBasis = c.req.query('basis') === 'so_date' ? 'so_date' : 'fair';

  const [read, markRead, lineRead] = await Promise.all([readCloses(sb, companyId), readMarks(sb, companyId), readLines(sb, companyId)]);
  if ('error' in read) return fail(c, 'closed months', read.error);
  if ('error' in markRead) return fail(c, 'marked orders', markRead.error);
  if ('error' in lineRead) return fail(c, 'lines added by Finance', lineRead.error);
  const closes = read.closes;
  const meta = closesMeta(closes);
  const ctx: Ctx = { closes, marks: markRead.marks, lines: lineRead.lines };

  /* A closed month, asked for whole: as it was closed. */
  const exact = closes.find((k) => from === `${k.month}-01` && to === monthEnd(`${k.month}-01`));
  if (exact) {
    const col = basis === 'so_date' ? 'report_so_date' : 'report_fair';
    const { data, error } = await scopeToCompanyId(sb.from('event_commission_closes').select(col).eq('month', `${exact.month}-01`), companyId).maybeSingle();
    if (error || !data) return fail(c, 'closed month', error?.message ?? 'not found');
    const frozen = (data as Record<string, unknown>)[col] as Record<string, unknown>;
    return c.json({ ...frozen, closed: { month: exact.month, closedAt: exact.closedAt, closedBy: exact.closedBy }, closes: meta });
  }

  /* The first open month pays what changed for the closed months' orders — read
     beside the range itself rather than after it. */
  const openDay = meta.openFrom ? `${meta.openFrom}-01` : null;
  const carries = openDay != null && from <= openDay && openDay <= to;
  const [live, adj] = await Promise.all([
    markedLive(c, companyId, from, to, basis, ctx),
    carries ? adjustmentsFor(c, companyId, basis, ctx) : Promise.resolve(null),
  ]);
  if ('response' in live) return live.response;
  if (adj && 'response' in adj) return adj.response;
  const report = adj ? withMonthAdjustments(live.report, adj.rows) : live.report;
  return c.json({ ...report, closes: meta });
};

const actorOf = (c: any): { id?: number | null; name?: string | null; email?: string | null } | null => c.get('houzsUser') ?? null;
const rmOf = (sen: number) => (sen / 100).toFixed(2);

/* ── POST /commission/close { month: 'YYYY-MM' } ─────────────────────────────
   Months close in order, each once it has ended (Malaysia). Both bases freeze
   together, each with the adjustments it carries for the months closed before
   it — what the next month's adjustments are measured against. */
export const closeCommissionMonthHandler = async (c: any): Promise<Response> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const body = await c.req.json().catch(() => ({}));
  const month = String((body as { month?: unknown })?.month ?? '').trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return c.json({ error: 'bad_month', message: 'Pick a month to close.' }, 400);
  const sb = c.get('supabase');
  const companyId = co.companyId;
  const [known, markRead, lineRead] = await Promise.all([readCloses(sb, companyId), readMarks(sb, companyId), readLines(sb, companyId)]);
  if ('error' in known) return fail(c, 'closed months', known.error);
  if ('error' in markRead) return fail(c, 'marked orders', markRead.error);
  if ('error' in lineRead) return fail(c, 'lines added by Finance', lineRead.error);
  const closes = known.closes;
  const ctx: Ctx = { closes, marks: markRead.marks, lines: lineRead.lines };
  if (closes.some((k) => k.month === month)) return c.json({ error: 'already_closed', message: `${monthLabel(month)} is already closed.` }, 409);
  const latest = closes.length > 0 ? closes[closes.length - 1]!.month : null;
  if (latest && month !== nextMonth(latest)) {
    return c.json({ error: 'out_of_order', message: `Months close in order — close ${monthLabel(nextMonth(latest))} first.` }, 409);
  }
  if (monthEnd(`${month}-01`) >= todayMyt()) return c.json({ error: 'not_ended', message: `${monthLabel(month)} has not ended yet.` }, 409);

  const reports = {} as Record<CommissionBasis, EventCommissionReport>;
  const bases = ['fair', 'so_date'] as const;
  const read = await Promise.all(bases.map((basis) => Promise.all([
    markedLive(c, companyId, `${month}-01`, monthEnd(`${month}-01`), basis, ctx),
    closes.length > 0 ? adjustmentsFor(c, companyId, basis, ctx) : Promise.resolve(null),
  ])));
  for (let i = 0; i < bases.length; i += 1) {
    const [live, adj] = read[i]!;
    if ('response' in live) return live.response;
    if (adj && 'response' in adj) return adj.response;
    reports[bases[i]!] = adj ? withMonthAdjustments(live.report, adj.rows) : live.report;
  }
  const carriedOf = (r: EventCommissionReport) => r.monthAdjustments.map((a) => ({ month: a.month, docNo: a.docNo, sen: a.adjustmentSen }));
  const actor = actorOf(c);
  const pf = await assertAuditWritable(sb, { entityType: 'COMMISSION_MONTH', entityId: `${companyId}:${month}`, action: 'POST', companyId });
  if (!pf.ok) return c.json(auditUnavailableBody(), 409);
  const { error } = await sb.from('event_commission_closes').insert({
    company_id: companyId,
    month: `${month}-01`,
    closed_by: actor?.name ?? actor?.email ?? null,
    paid: { fair: paidByOrder(reports.fair), so_date: paidByOrder(reports.so_date) },
    carried: { fair: carriedOf(reports.fair), so_date: carriedOf(reports.so_date) },
    report_fair: reports.fair,
    report_so_date: reports.so_date,
  });
  if (error) {
    if (String(error.code) === '23505') return c.json({ error: 'already_closed', message: `${monthLabel(month)} is already closed.` }, 409);
    return c.json({ error: 'close_failed', message: `${monthLabel(month)} could not be closed — try again.`, reason: error.message }, 500);
  }
  await recordEntityAudit(sb, {
    entityType: 'COMMISSION_MONTH', entityId: `${companyId}:${month}`, entityDocNo: month, companyId, action: 'POST', actor,
    note: `Event Commission ${monthLabel(month)} closed: by fair RM ${rmOf(reports.fair.totals.totalSen)}, by SO date RM ${rmOf(reports.so_date.totals.totalSen)}`,
  });
  const after = [...closes, { month, closedAt: new Date().toISOString(), closedBy: actor?.name ?? null, read: null }];
  return c.json({ ok: true, month, totals: { fair: reports.fair.totals, so_date: reports.so_date.totals }, closes: closesMeta(after) });
};

/* ── POST /commission/reopen { month } — the latest closed month only. ─────── */
export const reopenCommissionMonthHandler = async (c: any): Promise<Response> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const body = await c.req.json().catch(() => ({}));
  const month = String((body as { month?: unknown })?.month ?? '').trim();
  const sb = c.get('supabase');
  const companyId = co.companyId;
  const read = await readCloses(sb, companyId);
  if ('error' in read) return fail(c, 'closed months', read.error);
  const closes = read.closes;
  const latest = closes.length > 0 ? closes[closes.length - 1]!.month : null;
  if (!latest) return c.json({ error: 'nothing_closed', message: 'No month is closed.' }, 409);
  if (month !== latest) return c.json({ error: 'not_latest', message: `Only the latest closed month can be reopened — ${monthLabel(latest)}.` }, 409);
  const pf = await assertAuditWritable(sb, { entityType: 'COMMISSION_MONTH', entityId: `${companyId}:${month}`, action: 'REVERSE', companyId });
  if (!pf.ok) return c.json(auditUnavailableBody(), 409);
  /* One row per company and month (the unique key): DELETE … RETURNING it. */
  const { data, error } = await scopeToCompanyId(sb.from('event_commission_closes').delete().eq('month', `${month}-01`), companyId).select('month').maybeSingle();
  if (error) return c.json({ error: 'reopen_failed', message: `${monthLabel(month)} could not be reopened — try again.`, reason: error.message }, 500);
  if (!data) return c.json({ error: 'nothing_closed', message: `${monthLabel(month)} is not closed.` }, 409);
  await recordEntityAudit(sb, {
    entityType: 'COMMISSION_MONTH', entityId: `${companyId}:${month}`, entityDocNo: month, companyId, action: 'REVERSE', actor: actorOf(c),
    note: `Event Commission ${monthLabel(month)} reopened`,
  });
  return c.json({ ok: true, month, closes: closesMeta(closes.slice(0, -1)) });
};

/* ── Finance's two buttons (owner 2026-11-12) ─────────────────────────────── */

const DOC_NO = /^[A-Z0-9][A-Z0-9-]{3,39}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How the mark reads in the order's History. */
const markWords = (m: Pick<CommissionMark, 'kind' | 'month'>): string => {
  if (m.kind === 'exclude') return 'Not counted';
  if (m.kind === 'exclude_change') return `Price change of ${monthLabel(m.month ?? '')} not counted`;
  return `Counted in ${monthLabel(nextMonth(m.month ?? ''))}, not ${monthLabel(m.month ?? '')}`;
};
const historyActor = (c: any) => {
  const user = c.get('user');
  return {
    actorId: (user?.id as string | undefined) ?? null,
    actorName: (user?.user_metadata as { name?: string } | undefined)?.name ?? actorOf(c)?.name ?? null,
  };
};

/* POST /commission/marks { docNo, kind: 'exclude' | 'defer' | 'exclude_change', month?: 'YYYY-MM', reason? }
   「这张单不要算」 marks the order not counted, in any month; 「这个算下个月」 moves
   what it earns in `month` — an open month — to the month after; 「这次改价不算」
   leaves its upsales / drop sales of `month` — an open month — out of the
   commission, the order itself still counted. */
export const markCommissionOrderHandler = async (c: any): Promise<Response> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const body = (await c.req.json().catch(() => ({}))) as { docNo?: unknown; kind?: unknown; month?: unknown; reason?: unknown };
  const docNo = String(body.docNo ?? '').trim().toUpperCase();
  if (!DOC_NO.test(docNo)) return c.json({ error: 'bad_doc_no', message: 'Pick an order.' }, 400);
  const kind = body.kind === 'exclude' || body.kind === 'defer' || body.kind === 'exclude_change' ? body.kind : null;
  if (!kind) return c.json({ error: 'bad_kind', message: 'Choose "don\'t count", "next month" or "don\'t count the price change".' }, 400);
  const month = kind === 'exclude' ? null : String(body.month ?? '').trim();
  if (month != null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return c.json({ error: 'bad_month', message: kind === 'defer' ? 'Pick the month its commission leaves.' : 'Pick the month of the price change.' }, 400);
  }
  const reason = String(body.reason ?? '').trim().slice(0, 500) || null;
  const sb = c.get('supabase');
  const companyId = co.companyId;

  const { data: so, error: soErr } = await scopeToCompanyId(sb.from('mfg_sales_orders').select('doc_no').eq('doc_no', docNo), companyId).maybeSingle();
  if (soErr) return fail(c, 'order', soErr.message);
  if (!so) return c.json({ error: 'not_found', message: `${docNo} is not an order of this company.` }, 404);
  if (month != null) {
    const read = await readCloses(sb, companyId);
    if ('error' in read) return fail(c, 'closed months', read.error);
    if (read.closes.some((k) => k.month === month)) {
      const open = kind === 'defer' ? "only an open month's commission can move to the next month" : "only an open month's price change can be left out";
      return c.json({ error: 'month_closed', message: `${monthLabel(month)} is closed — ${open}.` }, 409);
    }
  }
  const actor = actorOf(c);
  const { data, error } = await sb.from('event_commission_marks').insert({
    company_id: companyId, so_doc_no: docNo, kind, month: month ? `${month}-01` : null, reason,
    marked_by: actor?.name ?? actor?.email ?? null,
  }).select(MARK_COLS).single();
  if (error) {
    if (String(error.code) === '23505') return c.json({ error: 'already_marked', message: `${docNo} is already marked.` }, 409);
    return c.json({ error: 'mark_failed', message: `${docNo} could not be marked — try again.`, reason: error.message }, 500);
  }
  const mark = markOf(data as MarkRead);
  await recordSoAudit(sb, {
    docNo, action: 'COMMISSION_MARK', ...historyActor(c),
    fieldChanges: [{ field: 'eventCommission', from: 'Counted', to: markWords(mark) }],
    source: 'event-commission', ...(reason ? { note: reason } : {}),
  });
  return c.json({ ok: true, mark });
};

/* POST /commission/marks/undo { id } — the mark taken away; the order counts again. */
export const unmarkCommissionOrderHandler = async (c: any): Promise<Response> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const body = (await c.req.json().catch(() => ({}))) as { id?: unknown };
  const id = String(body.id ?? '').trim();
  if (!UUID.test(id)) return c.json({ error: 'bad_id', message: 'Pick a marked order.' }, 400);
  const sb = c.get('supabase');
  const { data, error } = await scopeToCompanyId(sb.from('event_commission_marks').delete().eq('id', id), co.companyId).select(MARK_COLS).maybeSingle();
  if (error) return c.json({ error: 'undo_failed', message: 'The mark could not be taken away — try again.', reason: error.message }, 500);
  if (!data) return c.json({ error: 'not_found', message: 'That mark is already gone.' }, 404);
  const mark = markOf(data as MarkRead);
  await recordSoAudit(sb, {
    docNo: mark.docNo, action: 'COMMISSION_UNMARK', ...historyActor(c),
    fieldChanges: [{ field: 'eventCommission', from: markWords(mark), to: 'Counted' }],
    source: 'event-commission',
  });
  return c.json({ ok: true, mark });
};

/* ── Finance's own lines (owner 2026-11-13, 「做」) ──────────────────────────── */

/** A typing slip, not a line: RM 10 million of goods on one order. */
const MAX_LINE_SEN = 10_000_000_00;
/** How the line reads in the order's History. */
const lineWords = (l: Pick<CommissionManualLine, 'month' | 'goodsSen'>): string =>
  `Finance line for ${monthLabel(l.month)}: goods ${l.goodsSen > 0 ? '+' : '-'}${rmOf(Math.abs(l.goodsSen))}`;

/* POST /commission/lines { docNo, month: 'YYYY-MM', goodsSen, reason }
   An amount of goods on an order for an open month that has begun: more than 0
   adds commission, less than 0 takes it back, at the order's own rate. The
   reason is asked for — it is money typed by hand. */
export const addCommissionLineHandler = async (c: any): Promise<Response> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const body = (await c.req.json().catch(() => ({}))) as { docNo?: unknown; month?: unknown; goodsSen?: unknown; reason?: unknown };
  const docNo = String(body.docNo ?? '').trim().toUpperCase();
  if (!DOC_NO.test(docNo)) return c.json({ error: 'bad_doc_no', message: 'Type the order number.' }, 400);
  const month = String(body.month ?? '').trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return c.json({ error: 'bad_month', message: 'Pick the month the line is paid in.' }, 400);
  if (month > todayMyt().slice(0, 7)) return c.json({ error: 'bad_month', message: `${monthLabel(month)} has not begun yet.` }, 400);
  const goodsSen = Number(body.goodsSen);
  if (!Number.isInteger(goodsSen) || goodsSen === 0 || Math.abs(goodsSen) > MAX_LINE_SEN) {
    return c.json({ error: 'bad_amount', message: 'Type the goods amount: more than 0 to add, less than 0 to take back.' }, 400);
  }
  const reason = String(body.reason ?? '').trim().slice(0, 500);
  if (!reason) return c.json({ error: 'reason_required', message: 'Say why the line is added.' }, 400);
  const sb = c.get('supabase');
  const companyId = co.companyId;

  const { data: so, error: soErr } = await scopeToCompanyId(sb.from('mfg_sales_orders').select('doc_no').eq('doc_no', docNo), companyId).maybeSingle();
  if (soErr) return fail(c, 'order', soErr.message);
  /* Its own code, not `not_found`: the screen swaps that one for "refresh", and a
     refresh does not help an order number typed wrong. */
  if (!so) return c.json({ error: 'order_not_found', message: `${docNo} is not an order of this company.` }, 404);
  const read = await readCloses(sb, companyId);
  if ('error' in read) return fail(c, 'closed months', read.error);
  if (read.closes.some((k) => k.month === month)) {
    return c.json({ error: 'month_closed', message: `${monthLabel(month)} is closed — add the line to an open month.` }, 409);
  }
  const actor = actorOf(c);
  const { data, error } = await sb.from('event_commission_lines').insert({
    company_id: companyId, so_doc_no: docNo, month: `${month}-01`, goods_sen: goodsSen, reason,
    added_by: actor?.name ?? actor?.email ?? null,
  }).select(LINE_COLS).single();
  if (error) return c.json({ error: 'add_failed', message: `The line on ${docNo} could not be added — try again.`, reason: error.message }, 500);
  const line = lineOf(data as LineRead);
  await recordSoAudit(sb, {
    docNo, action: 'COMMISSION_LINE_ADD', ...historyActor(c),
    fieldChanges: [{ field: 'eventCommission', from: null, to: lineWords(line) }],
    source: 'event-commission', note: reason,
  });
  return c.json({ ok: true, line });
};

/* POST /commission/lines/remove { id } — the line taken away, while its month is open. */
export const removeCommissionLineHandler = async (c: any): Promise<Response> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const body = (await c.req.json().catch(() => ({}))) as { id?: unknown };
  const id = String(body.id ?? '').trim();
  if (!UUID.test(id)) return c.json({ error: 'bad_id', message: 'Pick a line.' }, 400);
  const sb = c.get('supabase');
  const companyId = co.companyId;
  const { data: found, error: readErr } = await scopeToCompanyId(sb.from('event_commission_lines').select(LINE_COLS).eq('id', id), companyId).maybeSingle();
  if (readErr) return fail(c, 'line', readErr.message);
  if (!found) return c.json({ error: 'not_found', message: 'That line is already gone.' }, 404);
  const line = lineOf(found as LineRead);
  const read = await readCloses(sb, companyId);
  if ('error' in read) return fail(c, 'closed months', read.error);
  if (read.closes.some((k) => k.month === line.month)) {
    return c.json({ error: 'month_closed', message: `${monthLabel(line.month)} is closed — its lines stay as they were paid.` }, 409);
  }
  const { data, error } = await scopeToCompanyId(sb.from('event_commission_lines').delete().eq('id', id), companyId).select(LINE_COLS).maybeSingle();
  if (error) return c.json({ error: 'remove_failed', message: 'The line could not be taken away — try again.', reason: error.message }, 500);
  if (!data) return c.json({ error: 'not_found', message: 'That line is already gone.' }, 404);
  await recordSoAudit(sb, {
    docNo: line.docNo, action: 'COMMISSION_LINE_REMOVE', ...historyActor(c),
    fieldChanges: [{ field: 'eventCommission', from: lineWords(line), to: null }],
    source: 'event-commission', ...(line.reason ? { note: line.reason } : {}),
  });
  return c.json({ ok: true, line });
};
