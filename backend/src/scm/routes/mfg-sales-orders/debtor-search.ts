import type { Hono } from 'hono';
import type { Env, Variables } from '../../env';
import { scopeToCompany } from '../../lib/companyScope';
import { escapeForOr } from '../../lib/postgrest-search';

export function registerDebtorSearchRoutes(mfgSalesOrders: Hono<{ Bindings: Env; Variables: Variables }>): void {
mfgSalesOrders.get('/debtors/search', async (c) => {
  const sb = c.get('supabase'); const q = c.req.query('q') ?? '';
  let query = scopeToCompany(sb.from('mfg_sales_orders').select('debtor_code, debtor_name, phone, address1, address2, address3, address4'), c).order('updated_at', { ascending: false }).limit(200);
  { const s = escapeForOr(q); if (s) query = query.or(`debtor_name.ilike.%${s}%,debtor_code.ilike.%${s}%`); }
  const { data, error } = await query;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  const seen = new Set<string>();
  const out = [];
  for (const r of (data ?? []) as Array<Record<string, string | null>>) {
    const key = (r.debtor_code || r.debtor_name || '').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(r);
    if (out.length >= 25) break;
  }
  return c.json({ debtors: out });
});
}
