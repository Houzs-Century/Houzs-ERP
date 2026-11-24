// ----------------------------------------------------------------------------
// GET /accounting/so-do-conversion?month=YYYY-MM — Finance's SO to DO
// conversion report (owner 2026-11-24; the rules are acc/so-do-conversion.ts).
// Reads the active company's delivery orders dated in the month that have
// shipped (not Draft, not Cancelled) and the orders they were raised from,
// both on the company predicate. Registered in routes/accounting.ts so it keeps
// the accounting area guard; the key is the Product changes report's.
// ----------------------------------------------------------------------------

import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { requireActiveCompanyId, scopeToCompanyId } from '../lib/companyScope';
import { chunkIn, paginateAll } from '../lib/paginate-all';
import { todayMyt } from '../lib/my-time';
import { DO_NOT_DELIVERED_IN_LIST } from '../shared/do-shipped-states';
import { profitMonths } from './accounting-product-profit';
import { buildSoDoConversion, type ScDoRow, type ScOrder } from '../../acc/so-do-conversion';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;
type Db = Variables['supabase'];
const NO_PERM = { error: "You don't have permission to read the financial statements." };
const failed = (e: unknown): string => String((e as { message?: string } | null)?.message ?? e);

type Loaded = { ok: true; dos: ScDoRow[]; orders: ScOrder[] } | { ok: false; reason: string };

export async function loadSoDoConversion(sb: Db, companyId: number, range: { from: string; to: string }): Promise<Loaded> {
  const read = await paginateAll<ScDoRow>((f, t) =>
    scopeToCompanyId(sb.from('delivery_orders').select('id, do_number, do_date, so_doc_no, status, local_total_sen, debtor_name'), companyId)
      .gte('do_date', range.from).lte('do_date', range.to)
      .not('status', 'in', DO_NOT_DELIVERED_IN_LIST)
      .order('id').range(f, t));
  if (read.error) return { ok: false, reason: failed(read.error) };
  const dos = (read.data ?? []) as ScDoRow[];

  const docs = [...new Set(dos.map((d) => d.so_doc_no?.trim() ?? '').filter((x) => x !== ''))];
  const ords = await chunkIn<ScOrder>(docs, (batch, f, t) =>
    scopeToCompanyId(sb.from('mfg_sales_orders').select('doc_no, so_date, debtor_name, linked_ac_docno'), companyId)
      .in('doc_no', batch)
      .order('doc_no').range(f, t));
  if (ords.error) return { ok: false, reason: failed(ords.error) };
  return { ok: true, dos, orders: ords.data };
}

export const soDoConversionHandler = async (c: Ctx): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.post')) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const months = profitMonths({ month: c.req.query('month') }, todayMyt());
  if (!months.ok) return c.json({ error: months.error, message: months.message }, 400);
  const range = { from: months.from, to: months.to };
  const loaded = await loadSoDoConversion(c.get('supabase'), co.companyId, range);
  if (!loaded.ok) return c.json({ error: 'load_failed', reason: loaded.reason }, 500);
  return c.json(buildSoDoConversion({ month: months.month, ...range, ...loaded }));
};
