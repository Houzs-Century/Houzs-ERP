// ----------------------------------------------------------------------------
// GET /accounting/product-profit?month=YYYY-MM — the monthly product profit
// ranking (owner 2026-10-05; the rules are acc/product-profit.ts). Reads the
// active company's sales orders dated in the month, their lines, and the
// products and models the lines name; answers every product the month sold
// with its sales, own cost, share of the gifts and of the free bedframes.
// The screen sorts, filters by category and switches the gifts in or out.
// Registered in routes/accounting.ts so it keeps the accounting area guard;
// the cost is the financial statements' key, like the Performance P&L.
//
// Several months (the redesign's c8; owner 2026-11-03 「要」, question g2):
// ?from= / ?to= beside ?month=, each a month (YYYY-MM) or a day in one, read
// in WHOLE months — a part month widens to its first and last days. An order
// counts in the month of its SO date (按开单月), so the months together are
// one read over their orders: every figure is a sum of the orders' own, and
// each order's gifts are shared within that order, so the range is exactly
// the months added up. One month either way is the same report as ?month=.
// ----------------------------------------------------------------------------

import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { requireActiveCompanyId } from '../lib/companyScope';
import { chunkIn, paginateAll } from '../lib/paginate-all';
import { todayMyt } from '../lib/my-time';
import { SO_NOT_AN_ORDER } from '../shared/so-deliverable-states';
import { monthRange } from './accounting-receipts-check';
import { buildProductProfit, type PpLine, type PpModel, type PpOrder, type PpProduct } from '../../acc/product-profit';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;
type Db = Variables['supabase'];
const NO_PERM = { error: "You don't have permission to read the financial statements." };
const failed = (e: unknown): string => String((e as { message?: string } | null)?.message ?? e);

type Loaded = { ok: true; orders: PpOrder[]; lines: PpLine[]; products: PpProduct[]; models: PpModel[] } | { ok: false; reason: string };

export async function loadProductProfit(sb: Db, companyId: number, range: { from: string; to: string }): Promise<Loaded> {
  /* The months' orders by SO date. Status is an enum the fake client cannot be
     trusted to compare; the DRAFT/CANCELLED rule is applied in code. */
  const sos = await paginateAll<PpOrder>((f, t) =>
    sb.from('mfg_sales_orders')
      .select('doc_no, status')
      .eq('company_id', companyId).gte('so_date', range.from).lte('so_date', range.to)
      .order('doc_no').range(f, t));
  if (sos.error) return { ok: false, reason: failed(sos.error) };
  const orders = (sos.data ?? []) as PpOrder[];
  const liveDocs = orders.filter((o) => !SO_NOT_AN_ORDER.has(String(o.status))).map((o) => o.doc_no);

  const its = await chunkIn<PpLine>(liveDocs, (batch, f, t) =>
    sb.from('mfg_sales_order_items')
      .select('doc_no, item_group, item_code, description, qty, total_sen, unit_cost_sen, line_cost_sen, cancelled')
      .eq('company_id', companyId).in('doc_no', batch)
      .order('id').range(f, t));
  if (its.error) return { ok: false, reason: failed(its.error) };
  const lines = its.data;

  /* The company's product list and models, read whole (a few thousand short
     rows), never by an `in` list of item codes: a code can carry a double
     quote (DUNLOPILLO GENERASI 5" MATT) that PostgREST's in-list cannot hold,
     and a model id is a uuid. The builder looks up only the codes it meets. */
  const prods = await paginateAll<PpProduct>((f, t) =>
    sb.from('mfg_products')
      .select('code, model_id, base_model, size_label')
      .eq('company_id', companyId)
      .order('code').range(f, t));
  if (prods.error) return { ok: false, reason: failed(prods.error) };

  const mods = await paginateAll<PpModel>((f, t) =>
    sb.from('product_models')
      .select('id, name, branding')
      .eq('company_id', companyId)
      .order('id').range(f, t));
  if (mods.error) return { ok: false, reason: failed(mods.error) };

  return { ok: true, orders, lines, products: (prods.data ?? []) as PpProduct[], models: (mods.data ?? []) as PpModel[] };
}

/** The longest range one read takes, in months. */
export const MAX_PROFIT_MONTHS = 24;

type Months = { ok: true; month: string; from: string; to: string } | { ok: false; error: string; message: string };

/** The month a ?from / ?to value names: "2026-09" or any day in it ("2026-09-14"). */
const monthOf = (v: string): string | null => {
  const m = /^(\d{4}-\d{2})(-\d{2})?$/.exec(v);
  return m && monthRange(m[1]!) ? m[1]! : null;
};

/** The whole months a request reads, `month` being the first of them. */
export function profitMonths(q: { month?: string; from?: string; to?: string }, today: string): Months {
  const from = String(q.from ?? '').trim();
  const to = String(q.to ?? '').trim();
  if (!from && !to) {
    const month = String(q.month ?? '').trim() || today.slice(0, 7);
    const range = monthRange(month);
    return range ? { ok: true, month, ...range } : { ok: false, error: 'bad_month', message: 'Which month? YYYY-MM.' };
  }
  const first = monthOf(from || to);
  const last = monthOf(to || from);
  if (!first || !last) return { ok: false, error: 'bad_month', message: 'Which months? From and To as YYYY-MM.' };
  if (first > last) return { ok: false, error: 'bad_range', message: 'From comes after To.' };
  const span = (Number(last.slice(0, 4)) - Number(first.slice(0, 4))) * 12 + Number(last.slice(5, 7)) - Number(first.slice(5, 7)) + 1;
  if (span > MAX_PROFIT_MONTHS) return { ok: false, error: 'too_long', message: `At most ${MAX_PROFIT_MONTHS} months at a time.` };
  return { ok: true, month: first, from: monthRange(first)!.from, to: monthRange(last)!.to };
}

export const productProfitHandler = async (c: Ctx): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.post')) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const months = profitMonths({ month: c.req.query('month'), from: c.req.query('from'), to: c.req.query('to') }, todayMyt());
  if (!months.ok) return c.json({ error: months.error, message: months.message }, 400);
  const range = { from: months.from, to: months.to };
  const loaded = await loadProductProfit(c.get('supabase'), co.companyId, range);
  if (!loaded.ok) return c.json({ error: 'load_failed', reason: loaded.reason }, 500);
  return c.json(buildProductProfit({ month: months.month, ...range, ...loaded }));
};
