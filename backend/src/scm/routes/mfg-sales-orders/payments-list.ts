import type { Hono } from 'hono';
import type { Env, Variables } from '../../env';
import { scopeToCompany } from '../../lib/companyScope';
import { PAYMENT_COLS } from '../../lib/so-payment-row';

/* GET /:docNo/payments — moved out of mfg-sales-orders.ts, which calls this where the block
   stood, so registration order is unchanged. The body is moved verbatim and left
   unindented on purpose: source tests anchor on `\nmfgSalesOrders.<verb>(`. */
export function registerPaymentsListRoutes(mfgSalesOrders: Hono<{ Bindings: Env; Variables: Variables }>): void {
// ── Payments — PR #163 (migration 0073) ───────────────────────────────
//
// HOOKKA-style transaction ledger per SO. Each row is one receipt /
// auth slip. UI lists them, sums into a "Deposit Paid" total, and the
// balance computes from header.local_total_sen − sum(amount_sen).
//
// Legacy single-row payment fields on mfg_sales_orders (payment_method,
mfgSalesOrders.get('/:docNo/payments', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo');
  const { data, error } = await scopeToCompany(sb
    .from('mfg_sales_order_payments')
    .select(`${PAYMENT_COLS}, staff:collected_by ( name )`)
    .eq('so_doc_no', docNo), c)
    .order('paid_at', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  // Flatten the joined `staff.name` onto `collected_by_name` so the UI
  // doesn't need to drill into a nested object.
  const payments = (data ?? []).map((r: unknown) => {
    const row = r as Record<string, unknown> & { staff: { name: string } | null };
    const { staff, ...rest } = row;
    return { ...rest, collected_by_name: staff?.name ?? null };
  });
  return c.json({ payments });
});
}
