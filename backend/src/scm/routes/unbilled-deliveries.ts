
import { DO_NOT_DELIVERED_IN_LIST } from '../shared/do-shipped-states';
import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { paginateAll, chunkIn } from '../lib/paginate-all';
import { scopeToCompany } from '../lib/companyScope';
import { canViewAllSales } from '../lib/houzs-perms';
import { resolveSalesScopeIds } from '../lib/salesScope';
import { doLineRemaining } from '../lib/do-line-remaining';
import { todayMyt } from '../lib/my-time';
import { stampSoRefs } from '../lib/so-ref-lookup';

export const unbilledDeliveries = new Hono<{ Bindings: Env; Variables: Variables }>();
unbilledDeliveries.use('*', supabaseAuth);

const NOT_SHIPPED_STATES = DO_NOT_DELIVERED_IN_LIST;

const BUCKETS = [
  { key: '0-30',    label: '0–30 days (normal billing lag)', max: 30 },
  { key: '31-60',   label: '31–60 days',                     max: 60 },
  { key: '61-90',   label: '61–90 days',                     max: 90 },
  { key: '91-180',  label: '91–180 days',                    max: 180 },
  { key: '181-365', label: '181–365 days',                   max: 365 },
  { key: '365+',    label: 'Over 12 months',                 max: Infinity },
] as const;

const bucketOf = (ageDays: number): (typeof BUCKETS)[number] => {
  const b = BUCKETS.find((x) => ageDays <= x.max);
  return b ?? BUCKETS[BUCKETS.length - 1]!;
};

const ageDaysBetween = (fromYmd: string, toYmd: string): number => {
  const a = Date.parse(`${fromYmd}T00:00:00Z`);
  const b = Date.parse(`${toYmd}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000));
};

const valueOfUnits = (
  n: number,
  delivered: number,
  unitPriceSen: number,
  discountSen: number,
): number => {
  if (n <= 0 || delivered <= 0) return 0;
  const share = Math.round((discountSen * n) / delivered);
  return Math.max(0, n * unitPriceSen - share);
};

type Row = {
  delivery_order_id: string;
  do_number: string;
  do_date: string;
  age_days: number;
  bucket: string;
  bucket_label: string;
  status: string;
  so_doc_no: string | null;
  debtor_code: string | null;
  debtor_name: string | null;
  phone: string | null;
  salesperson: string | null;
  delivered_sen: number;
  invoiced_sen: number;
  returned_sen: number;
  unbilled_sen: number;
  lines_total: number;
  lines_pending: number;
  partly_invoiced: boolean;
  so_ref?: string | null;
  so_customer_so_no?: string | null;
};

unbilledDeliveries.get('/', async (c) => {
  const sb = c.get('supabase');

  const minAgeDays = Math.max(0, Number(c.req.query('minAgeDays') ?? 0) || 0);
  const bucketFilter = c.req.query('bucket');
  const debtorCode = c.req.query('debtorCode');
  const from = c.req.query('from');
  const to = c.req.query('to');

  const scopeIds = await resolveSalesScopeIds(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c));

  const { data: doHeaders, error } = await paginateAll<Record<string, unknown>>((pFrom, pTo) => {
    let q = sb
      .from('delivery_orders')
      .select('id, do_number, so_doc_no, debtor_code, debtor_name, phone, do_date, status, salesperson_id, agent')
      .not('status', 'in', NOT_SHIPPED_STATES);
    if (debtorCode) q = q.eq('debtor_code', debtorCode);
    if (from) q = q.gte('do_date', from);
    if (to) q = q.lte('do_date', to);
    if (minAgeDays > 0) q = q.lte('do_date', todayMyt(-minAgeDays));
    q = scopeToCompany(q, c);
    if (scopeIds) q = q.in('salesperson_id', scopeIds);
    return q.order('do_date', { ascending: true }).range(pFrom, pTo);
  });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  type Header = {
    id: string; do_number: string; so_doc_no: string | null;
    debtor_code: string | null; debtor_name: string | null; phone: string | null;
    do_date: string; status: string; salesperson_id: string | null; agent: string | null;
  };
  const headers = (doHeaders ?? []) as unknown as Header[];
  if (headers.length === 0) {
    return c.json({ as_of: todayMyt(), rows: [], buckets: emptyBuckets(), totals: emptyTotals() });
  }

  const ledger = await doLineRemaining(sb, headers.map((h) => h.id), 'delivered');
  if (!ledger.ok) return c.json({ error: 'load_failed', reason: ledger.reason }, 500);
  const remainingByItem = ledger.lines;

  type Agg = { delivered: number; invoiced: number; returned: number; unbilled: number; lines: number; pending: number };
  const aggByDo = new Map<string, Agg>();
  for (const line of remainingByItem.values()) {
    const a = aggByDo.get(line.deliveryOrderId)
      ?? { delivered: 0, invoiced: 0, returned: 0, unbilled: 0, lines: 0, pending: 0 };
    const val = (n: number) => valueOfUnits(n, line.delivered, line.unitPriceSen, line.discountSen);
    a.delivered += val(line.delivered);
    a.invoiced += val(line.invoiced);
    a.returned += val(line.returned);
    a.unbilled += val(line.remaining);
    a.lines += 1;
    if (line.remaining > 0) a.pending += 1;
    aggByDo.set(line.deliveryOrderId, a);
  }

  const asOf = todayMyt();
  const rows: Row[] = [];
  for (const h of headers) {
    const a = aggByDo.get(h.id);
    if (!a || a.unbilled <= 0) continue;

    const ageDays = ageDaysBetween(h.do_date, asOf);
    const b = bucketOf(ageDays);
    if (bucketFilter && b.key !== bucketFilter) continue;

    rows.push({
      delivery_order_id: h.id,
      do_number: h.do_number,
      do_date: h.do_date,
      age_days: ageDays,
      bucket: b.key,
      bucket_label: b.label,
      status: h.status,
      so_doc_no: h.so_doc_no,
      debtor_code: h.debtor_code,
      debtor_name: h.debtor_name,
      phone: h.phone,
      salesperson: h.agent,
      delivered_sen: a.delivered,
      invoiced_sen: a.invoiced,
      returned_sen: a.returned,
      unbilled_sen: a.unbilled,
      lines_total: a.lines,
      lines_pending: a.pending,
      partly_invoiced: a.invoiced > 0 && a.unbilled > 0,
    });
  }

  const staffIds = [...new Set(
    headers.filter((h) => h.salesperson_id).map((h) => h.salesperson_id as string),
  )];
  if (staffIds.length > 0) {
    const { data: staffRows, error: staffErr } = await chunkIn<{ id: string; name: string | null }>(
      staffIds,
      (batch, pFrom, pTo) => sb.from('staff').select('id, name').in('id', batch).range(pFrom, pTo),
    );
    if (staffErr) return c.json({ error: 'load_failed', reason: staffErr.message }, 500);
    const nameById = new Map<string, string>();
    for (const s of staffRows) if (s.id && s.name) nameById.set(s.id, s.name);
    const spByDo = new Map(headers.map((h) => [h.id, h.salesperson_id]));
    for (const r of rows) {
      const sid = spByDo.get(r.delivery_order_id);
      r.salesperson = (sid ? nameById.get(sid) : null) ?? r.salesperson ?? null;
    }
  }

  await stampSoRefs(sb, rows as unknown as Array<Record<string, unknown>>, 'so_doc_no', (q) => scopeToCompany(q, c), 'unbilled-deliveries');

  rows.sort((x, y) => y.age_days - x.age_days || y.unbilled_sen - x.unbilled_sen);

  const buckets = emptyBuckets();
  const byKey = new Map(buckets.map((b) => [b.key, b]));
  for (const r of rows) {
    const b = byKey.get(r.bucket);
    if (b) { b.rows += 1; b.unbilled_sen += r.unbilled_sen; }
  }
  const totals = {
    rows: rows.length,
    unbilled_sen: rows.reduce((s, r) => s + r.unbilled_sen, 0),
    over_365: {
      rows: rows.filter((r) => r.age_days > 365).length,
      unbilled_sen: rows.filter((r) => r.age_days > 365).reduce((s, r) => s + r.unbilled_sen, 0),
    },
    partly_invoiced: {
      rows: rows.filter((r) => r.partly_invoiced).length,
      unbilled_sen: rows.filter((r) => r.partly_invoiced).reduce((s, r) => s + r.unbilled_sen, 0),
    },
  };

  return c.json({ as_of: asOf, rows, buckets, totals });
});

function emptyBuckets(): Array<{ key: string; label: string; rows: number; unbilled_sen: number }> {
  return BUCKETS.map((b) => ({ key: b.key, label: b.label, rows: 0, unbilled_sen: 0 }));
}

function emptyTotals() {
  return {
    rows: 0,
    unbilled_sen: 0,
    over_365: { rows: 0, unbilled_sen: 0 },
    partly_invoiced: { rows: 0, unbilled_sen: 0 },
  };
}
