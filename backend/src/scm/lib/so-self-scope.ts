import { scopeToCompany } from './companyScope';
import { canViewAllSales } from './houzs-perms';
import { soDocOutOfScope } from './salesScope';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SCM routers share one loosely-typed Hono context
export async function selfScopedSalesBlocked(c: any, docNo: string): Promise<boolean> {
  const sb = c.get('supabase');

  const { data: owned, error: ownedErr } = await scopeToCompany(
    sb.from('mfg_sales_orders').select('doc_no').eq('doc_no', docNo),
    c,
  ).maybeSingle();
  if (ownedErr || !owned) return true;

  if (canViewAllSales(c)) return false;
  const { data, error } = await sb
    .from('mfg_sales_orders')
    .select('salesperson_id, access_staff_ids, open_to_all')
    .eq('doc_no', docNo)
    .maybeSingle();
  if (error || !data) return true;
  const r = data as { salesperson_id?: number | string | null; access_staff_ids?: string[] | null; open_to_all?: boolean | null };
  return soDocOutOfScope(sb, c.env, c.get('houzsUser')?.id, false, { salespersonId: r.salesperson_id, accessStaffIds: r.access_staff_ids, openToAll: r.open_to_all });
}
