import type { Hono } from 'hono';
import type { Env, Variables } from '../../env';
import { activeCompanyId } from '../../lib/companyScope';
import { getCustomerCreditBalance } from '../../lib/customer-credits';

/* GET /customer-credit/:debtorCode — moved out of mfg-sales-orders.ts, which calls this where the block
   stood, so registration order is unchanged. The body is moved verbatim and left
   unindented on purpose: source tests anchor on `\nmfgSalesOrders.<verb>(`. */
export function registerCustomerCreditRoutes(mfgSalesOrders: Hono<{ Bindings: Env; Variables: Variables }>): void {
/* Customer credit balance lookup — used by the New Sales Order form to flash
   "Customer has RM X credit available" once the operator picks the customer.
   Returns 0 (not 404) when there's no history yet. */
mfgSalesOrders.get('/customer-credit/:debtorCode', async (c) => {
  const sb = c.get('supabase');
  const debtorCode = c.req.param('debtorCode');
  const balance = await getCustomerCreditBalance(sb, debtorCode, activeCompanyId(c) ?? null);
  return c.json({ debtorCode, balanceSen: balance });
});
}
