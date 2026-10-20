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
// Mounted under /acc-events, behind scmAreaGuard("scm.finance.accounting").

import { requireActiveCompanyId, scopeToCompanyId } from '../lib/companyScope';
import { chunkIn, paginateAll } from '../lib/paginate-all';
import { todayMyt } from '../lib/my-time';
import { dateOrNull } from '../lib/date-coerce';
import {
  buildEventCommission,
  type CommissionBasis, type CommissionCancel, type CommissionChange, type CommissionFair, type CommissionPayment, type CommissionSo,
} from '../lib/event-commission';
import { pnlForProjects } from '../../services/eventPnlBatch';
import { loadCostRates } from '../../services/eventPnlInputs';
import { LEDGER_COST_CATEGORIES } from '../../services/projects';

const MAX_RANGE_DAYS = 400;
const n = (v: unknown): number => { const x = Number(v ?? 0); return Number.isFinite(x) ? x : 0; };
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
  total_revenue_sen: number | null; created_at: string; so_date: string | null;
};
const SO_COLS = 'doc_no, project_id, salesperson_id, debtor_name, status, on_hold, mattress_sofa_sen, bedframe_sen, accessories_sen, others_sen, local_total_sen, total_revenue_sen, created_at, so_date';

type FairRead = { id: number | string; name: string | null; brand: string | null; start_date: string | null; end_date: string | null; archived_at: string | null; status: string | null; total_sales: number | string | null };
const FAIR_SQL = `SELECT p.id, p.name, p.brand, p.start_date, p.end_date, p.archived_at, p.status, pf.total_sales
                    FROM projects p LEFT JOIN project_finance pf ON pf.project_id = p.id`;

const fail = (c: any, what: string, reason: string) =>
  c.json({ error: 'load_failed', message: `The ${what} could not be read — try again.`, reason }, 500);

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
  const env = c.env;
  const sb = c.get('supabase');
  const companyId = co.companyId;
  const fromTs = `${from}T00:00:00+08:00`;
  const toTs = `${to}T23:59:59.999+08:00`;
  /* By fair (the fair's start) or by SO date (the order's own) — owner 2026-10-20. */
  const basis: CommissionBasis = c.req.query('basis') === 'so_date' ? 'so_date' : 'fair';

  /* 1–2. Part 1's orders. By fair: the fairs starting in the range and all their
     orders. By SO date: the orders opened in the range that have a fair. */
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
      scopeToCompanyId(sb.from('mfg_sales_orders').select(SO_COLS).gte('so_date', from).lte('so_date', to).not('project_id', 'is', null), companyId)
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
  const partTwoRead = await chunkIn<SoRead, string>(touched, (batch, lo, hi) =>
    scopeToCompanyId(sb.from('mfg_sales_orders').select(SO_COLS).in('doc_no', batch).not('project_id', 'is', null), companyId).order('doc_no').range(lo, hi));
  if (partTwoRead.error) return fail(c, 'orders', partTwoRead.error.message);

  /* The fairs the rest needs: by fair, the earlier fairs of those orders (started
     before the range); by SO date, every fair any of the orders is on. */
  const readFairs = async (ids: number[], startedBefore: string | null): Promise<FairRead[]> => {
    if (ids.length === 0) return [];
    const res = await env.DB.prepare(`${FAIR_SQL}
       WHERE p.company_id = ? AND p.id IN (${ids.map(() => '?').join(', ')})${startedBefore ? ' AND p.start_date < ?' : ''}`)
      .bind(companyId, ...ids, ...(startedBefore ? [startedBefore] : [])).all();
    return (res.results ?? []) as FairRead[];
  };
  const fairIdsOf = (rows: SoRead[]) => [...new Set(rows.map((s) => Number(s.project_id)).filter((id) => Number.isInteger(id)))];
  let earlierFairs: FairRead[];
  let partTwo: SoRead[];
  try {
    if (basis === 'fair') {
      earlierFairs = await readFairs(fairIdsOf(partTwoRead.data).filter((id) => !rangeIds.includes(id)), from);
      const earlierSet = new Set(earlierFairs.map((f) => Number(f.id)));
      partTwo = partTwoRead.data.filter((s) => earlierSet.has(Number(s.project_id)));
    } else {
      partTwo = partTwoRead.data.filter((s) => s.so_date != null && String(s.so_date).slice(0, 10) < from);
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
    rates = await loadCostRates(env, fairsRead.map((f) => f.brand));
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
        id: Number(f.id), name: String(f.name ?? `#${f.id}`), brand: f.brand, startDate: String(f.start_date ?? '').slice(0, 10),
        endDate: f.end_date ? String(f.end_date).slice(0, 10) : null,
        totalSalesRm: p ? p.sales : (f.total_sales == null ? null : n(f.total_sales)),
        estimateRm: p ? p.commission.amount : null,
      };
    });
  const report = buildEventCommission({
    basis, from, to, fairs,
    ratePctByBrand: new Map([...rates].map(([brand, r]) => [brand, r.commission_normal_pct ?? null])),
    sos: sos.map((s): CommissionSo => ({
      docNo: s.doc_no, projectId: Number(s.project_id), salesperson: s.salesperson_id ? staffName.get(s.salesperson_id) ?? null : null,
      customer: s.debtor_name, status: String(s.status ?? '').toUpperCase(), onHold: s.on_hold === true,
      goodsSen: n(s.mattress_sofa_sen) + n(s.bedframe_sen) + n(s.accessories_sen) + n(s.others_sen),
      totalSen: n(s.total_revenue_sen) > 0 ? n(s.total_revenue_sen) : n(s.local_total_sen),
      createdAt: s.created_at,
      soDate: s.so_date ? String(s.so_date).slice(0, 10) : null,
    })),
    payments: pays.data.map((p): CommissionPayment => ({ docNo: p.so_doc_no, paidAt: String(p.paid_at), amountSen: n(p.amount_sen) })),
    changes: chs.data.map((r): CommissionChange => ({
      docNo: String(r.so_doc_no), changedAt: String(r.changed_at),
      beforeGoodsSen: n(r.before_goods_sen), afterGoodsSen: n(r.after_goods_sen),
      beforeTotalSen: n(r.before_total_sen), afterTotalSen: n(r.after_total_sen),
      source: String(r.source ?? 'edit'), changedBy: (r.changed_by as string | null) ?? null,
    })),
    cancels: cancels.data.map((r): CommissionCancel => ({ docNo: r.doc_no, at: r.created_at })),
  });
  return c.json(report);
};
