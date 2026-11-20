/*
 * Look up sales orders by the CUSTOMER'S reference (owner 2026-10-03, for Houzs
 * Connect): `GET /api/scm/mfg-sales-orders/by-ref/:ref`.
 *
 * Connect only knows the number on the customer's slip (e.g. "znt5961"), never
 * our doc_no. That number lives in `ref` or `customer_so_no` (the docket, see
 * so-to-do-fields.ts), and several orders can carry the same one, so this
 * answers a LIST, newest first. It is the lean counterpart of `GET /:docNo`:
 * no MRP, no lines — status, total, paid and balance only, computed with the
 * same `so-outstanding.ts` rule the detail page and the AutoCount write-back
 * use, so Connect can never show a different balance from the ERP.
 *
 * Read-only. Company-scoped (`scopeToCompany`) and salesperson-scoped
 * (`applySoScope`) exactly like the list; Connect's service token holds `*`
 * and passes both. Orders that exist only in the AutoCount copy
 * (`public.sales_orders`) carry no status or payments and are not returned.
 */
import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import { scopeToCompany } from '../lib/companyScope';
import { canViewAllSales } from '../lib/houzs-perms';
import { applySoScope, resolveSalesScopeIds } from '../lib/salesScope';
import { soBalanceSen, soDisplayTotalSen, soPaidInputsOf, soPaidSen } from '../shared/so-outstanding';
import type { Env, Variables } from '../env';

export const mfgSoByRef = new Hono<{ Bindings: Env; Variables: Variables }>();

mfgSoByRef.use('*', supabaseAuth);

/** A docket is letters, digits and a few separators. Anything else is refused
 *  rather than escaped: it is spliced into a PostgREST `or()` filter, and `%` /
 *  `_` would be ILIKE wildcards. */
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9 ./-]{1,39}$/;
const MAX_ORDERS = 20;

mfgSoByRef.get('/by-ref/:ref', async (c) => {
  const sb = c.get('supabase');
  const ref = decodeURIComponent(c.req.param('ref')).trim();
  if (!REF_RE.test(ref)) return c.json({ error: 'invalid_ref' }, 400);

  const scopeIds = await resolveSalesScopeIds(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c));
  // ilike with no wildcard = case-insensitive exact match ("ZNT5961" = "znt5961").
  const quoted = `"${ref}"`;
  let q = sb
    .from('mfg_sales_orders')
    .select('doc_no, status, on_hold, so_date, debtor_name, phone, ref, customer_so_no, total_revenue_sen, local_total_sen, deposit_sen')
    .or(`ref.ilike.${quoted},customer_so_no.ilike.${quoted}`)
    .order('so_date', { ascending: false })
    .limit(MAX_ORDERS);
  q = applySoScope(q, scopeIds);
  q = scopeToCompany(q, c);
  const { data: headers, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const rows = (headers ?? []) as Array<Record<string, unknown> & { doc_no: string }>;
  if (rows.length === 0) return c.json({ orders: [] });

  // One read for every order's payments, then the shared rule per order.
  const { data: pays, error: payErr } = await sb
    .from('mfg_sales_order_payments')
    .select('so_doc_no, amount_sen, is_deposit')
    .in('so_doc_no', rows.map((r) => r.doc_no));
  if (payErr) return c.json({ error: 'payments_load_failed', reason: payErr.message }, 500);
  const ledger = new Map<string, { sen: number; deposit: boolean }>();
  for (const p of (pays ?? []) as Array<{ so_doc_no: string; amount_sen: number | null; is_deposit: boolean | null }>) {
    const cur = ledger.get(p.so_doc_no) ?? { sen: 0, deposit: false };
    cur.sen += p.amount_sen ?? 0;
    if (p.is_deposit) cur.deposit = true;
    ledger.set(p.so_doc_no, cur);
  }

  return c.json({
    orders: rows.map((h) => {
      const l = ledger.get(h.doc_no) ?? { sen: 0, deposit: false };
      const inputs = soPaidInputsOf(h, l.sen, l.deposit);
      return {
        docNo: h.doc_no,
        status: h.status ?? null,
        onHold: h.on_hold === true,
        soDate: h.so_date ?? null,
        debtorName: h.debtor_name ?? null,
        phone: h.phone ?? null,
        ref: h.ref ?? null,
        customerSoNo: h.customer_so_no ?? null,
        totalSen: soDisplayTotalSen(inputs),
        paidSen: soPaidSen(inputs),
        /* SIGNED, like the detail page: negative = over-collected. */
        balanceSen: soBalanceSen(inputs),
      };
    }),
  });
});
