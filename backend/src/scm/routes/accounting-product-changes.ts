// ----------------------------------------------------------------------------
// GET /accounting/product-changes?from=YYYY-MM&to=YYYY-MM — Finance's product
// change reports (owner 2026-11-23; the rules are acc/product-changes.ts and
// scm/lib/so-product-change.ts). Reads the active company's change events whose
// change day falls in the months, the orders they changed and who sold them.
// The detail report lists the rows; the summary adds them up.
// Registered in routes/accounting.ts so it keeps the accounting area guard; the
// cost is the financial statements' key, like the Product profit report.
// ----------------------------------------------------------------------------

import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { requireActiveCompanyId } from '../lib/companyScope';
import { chunkIn, paginateAll } from '../lib/paginate-all';
import { todayMyt } from '../lib/my-time';
import { profitMonths } from './accounting-product-profit';
import { buildProductChanges, type PcEventRow, type PcOrder } from '../../acc/product-changes';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;
type Db = Variables['supabase'];
const NO_PERM = { error: "You don't have permission to read the financial statements." };
const failed = (e: unknown): string => String((e as { message?: string } | null)?.message ?? e);

type Loaded = { ok: true; events: PcEventRow[]; orders: PcOrder[]; staffNames: Map<string, string> } | { ok: false; reason: string };

export async function loadProductChanges(sb: Db, companyId: number, range: { from: string; to: string }): Promise<Loaded> {
  const evs = await paginateAll<PcEventRow>((f, t) =>
    sb.from('so_product_changes')
      .select('id, so_doc_no, route, change_day, changed_at, changed_by, approved_by, amendment_nos, change_types, bucket, selling_before_sen, selling_after_sen, cost_before_sen, cost_after_sen, lines, rebuilt, cost_estimated')
      .eq('company_id', companyId).gte('change_day', range.from).lte('change_day', range.to)
      .not('bucket', 'is', null)
      .order('id').range(f, t));
  if (evs.error) return { ok: false, reason: failed(evs.error) };
  const events = (evs.data ?? []) as PcEventRow[];

  const docs = [...new Set(events.map((e) => e.so_doc_no))];
  const ords = await chunkIn<PcOrder>(docs, (batch, f, t) =>
    sb.from('mfg_sales_orders')
      .select('doc_no, so_date, status, debtor_name, salesperson_id, agent, linked_ac_docno')
      .eq('company_id', companyId).in('doc_no', batch)
      .order('doc_no').range(f, t));
  if (ords.error) return { ok: false, reason: failed(ords.error) };
  const orders = ords.data;

  const staffIds = [...new Set(orders.map((o) => o.salesperson_id).filter((x): x is string => typeof x === 'string' && x !== ''))];
  const staffNames = new Map<string, string>();
  const staff = await chunkIn<{ id: string; name: string | null }>(staffIds, (batch, f, t) =>
    sb.from('staff').select('id, name').in('id', batch).order('id').range(f, t));
  if (staff.error) return { ok: false, reason: failed(staff.error) };
  for (const s of staff.data) staffNames.set(String(s.id), String(s.name ?? s.id));

  return { ok: true, events, orders, staffNames };
}

export const productChangesHandler = async (c: Ctx): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.post')) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const months = profitMonths({ month: c.req.query('month'), from: c.req.query('from'), to: c.req.query('to') }, todayMyt());
  if (!months.ok) return c.json({ error: months.error, message: months.message }, 400);
  const range = { from: months.from, to: months.to };
  const loaded = await loadProductChanges(c.get('supabase'), co.companyId, range);
  if (!loaded.ok) return c.json({ error: 'load_failed', reason: loaded.reason }, 500);
  return c.json(buildProductChanges({ month: months.month, ...range, ...loaded }));
};
