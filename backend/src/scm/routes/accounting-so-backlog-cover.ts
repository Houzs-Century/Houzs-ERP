// ----------------------------------------------------------------------------
// GET /accounting/so-backlog-cover?month=YYYY-MM[&avgFrom=YYYY-MM] — Finance's
// SO conversion & backlog report (owner 2026-11-24; the rules are
// acc/so-backlog-cover.ts). Reads the active company's live orders (not Draft,
// not Cancelled) raised up to the month's end, and the first shipped DO of each
// one that has no Processing Date, both on the company predicate. Registered in
// routes/accounting.ts so it keeps the accounting area guard; the key is the
// Product changes report's.
// ----------------------------------------------------------------------------

import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { requireActiveCompanyId, scopeToCompanyId } from '../lib/companyScope';
import { chunkIn, paginateAll } from '../lib/paginate-all';
import { todayMyt } from '../lib/my-time';
import { DO_NOT_DELIVERED_IN_LIST } from '../shared/do-shipped-states';
import { profitMonths } from './accounting-product-profit';
import { MONTH_RE, monthsBetween } from '../../acc/dashboard';
import { buildSoBacklogCover, type ScOrder } from '../../acc/so-backlog-cover';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;
type Db = Variables['supabase'];
const NO_PERM = { error: "You don't have permission to read the financial statements." };
const failed = (e: unknown): string => String((e as { message?: string } | null)?.message ?? e);

/** The longest average one read takes, in months. */
export const MAX_AVERAGE_MONTHS = 120;

type AvgFrom = { ok: true; from: string | null } | { ok: false; error: string; message: string };

/** ?avgFrom — the average's first month; absent means the company's default. */
export function averageFrom(v: string | undefined, month: string): AvgFrom {
  const s = String(v ?? '').trim();
  if (!s) return { ok: true, from: null };
  if (!MONTH_RE.test(s)) return { ok: false, error: 'bad_average_from', message: 'Average from: a month as YYYY-MM.' };
  if (s > month) return { ok: false, error: 'bad_average_from', message: 'Average from comes after the month.' };
  if (monthsBetween(s, month) > MAX_AVERAGE_MONTHS) return { ok: false, error: 'too_long', message: `An average of at most ${MAX_AVERAGE_MONTHS} months.` };
  return { ok: true, from: s };
}

type Loaded = { ok: true; orders: ScOrder[]; firstDo: Map<string, string> } | { ok: false; reason: string };

export async function loadSoBacklogCover(sb: Db, companyId: number, to: string): Promise<Loaded> {
  const read = await paginateAll<ScOrder>((f, t) =>
    scopeToCompanyId(sb.from('mfg_sales_orders').select('doc_no, so_date, processing_date, local_total_sen, debtor_name, linked_ac_docno'), companyId)
      .lte('so_date', to)
      .not('status', 'in', '(DRAFT,CANCELLED)')
      .order('doc_no').range(f, t));
  if (read.error) return { ok: false, reason: failed(read.error) };
  if (read.truncated) return { ok: false, reason: 'More orders than one read takes.' };
  const orders = (read.data ?? []) as ScOrder[];

  const undated = [...new Set(orders.filter((o) => !o.processing_date).map((o) => o.doc_no))];
  const dos = await chunkIn<{ so_doc_no: string; do_date: string | null }>(undated, (batch, f, t) =>
    scopeToCompanyId(sb.from('delivery_orders').select('id, so_doc_no, do_date'), companyId)
      .in('so_doc_no', batch)
      .not('status', 'in', DO_NOT_DELIVERED_IN_LIST)
      .order('id').range(f, t));
  if (dos.error) return { ok: false, reason: failed(dos.error) };
  const firstDo = new Map<string, string>();
  for (const d of dos.data) {
    const date = d.do_date ? String(d.do_date).slice(0, 10) : null;
    const seen = firstDo.get(d.so_doc_no);
    if (date && (seen === undefined || date < seen)) firstDo.set(d.so_doc_no, date);
  }
  return { ok: true, orders, firstDo };
}

export const soBacklogCoverHandler = async (c: Ctx): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.post')) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const months = profitMonths({ month: c.req.query('month') }, todayMyt());
  if (!months.ok) return c.json({ error: months.error, message: months.message }, 400);
  const avg = averageFrom(c.req.query('avgFrom'), months.month);
  if (!avg.ok) return c.json({ error: avg.error, message: avg.message }, 400);
  const loaded = await loadSoBacklogCover(c.get('supabase'), co.companyId, months.to);
  if (!loaded.ok) return c.json({ error: 'load_failed', reason: loaded.reason }, 500);
  return c.json(buildSoBacklogCover({ month: months.month, avgFrom: avg.from, orders: loaded.orders, firstDo: loaded.firstDo }));
};
