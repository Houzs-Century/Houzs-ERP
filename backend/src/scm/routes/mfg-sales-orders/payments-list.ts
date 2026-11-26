import type { Hono } from 'hono';
import type { Env, Variables } from '../../env';
import { scopeToCompany } from '../../lib/companyScope';
import { PAYMENT_COLS } from '../../lib/so-payment-row';

export function registerPaymentsListRoutes(mfgSalesOrders: Hono<{ Bindings: Env; Variables: Variables }>): void {
mfgSalesOrders.get('/:docNo/payments', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo');
  const { data, error } = await scopeToCompany(sb
    .from('mfg_sales_order_payments')
    .select(`${PAYMENT_COLS}, staff:collected_by ( name )`)
    .eq('so_doc_no', docNo), c)
    .order('paid_at', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const payments = (data ?? []).map((r: unknown) => {
    const row = r as Record<string, unknown> & { staff: { name: string } | null };
    const { staff, ...rest } = row;
    return { ...rest, collected_by_name: staff?.name ?? null };
  });
  return c.json({ payments });
});
}
