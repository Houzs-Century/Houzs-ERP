import type { Hono } from 'hono';
import type { Env, Variables } from '../../env';
import { activeCompanyId } from '../../lib/companyScope';
import { getCustomerCreditBalance } from '../../lib/customer-credits';

export function registerCustomerCreditRoutes(mfgSalesOrders: Hono<{ Bindings: Env; Variables: Variables }>): void {
mfgSalesOrders.get('/customer-credit/:debtorCode', async (c) => {
  const sb = c.get('supabase');
  const debtorCode = c.req.param('debtorCode');
  const balance = await getCustomerCreditBalance(sb, debtorCode, activeCompanyId(c) ?? null);
  return c.json({ debtorCode, balanceSen: balance });
});
}
