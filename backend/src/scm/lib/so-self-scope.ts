import { scopeToCompany } from './companyScope';
import { canViewAllSales } from './houzs-perms';
import { soDocOutOfScope } from './salesScope';

/* Row-scope guard for the 18 /:docNo handlers that hang off a sales order.

   TWO dimensions. The salesperson one answers "is this MY order" and returns
   false immediately for a view-all tier - correct for its own question, and
   useless for tenancy, since a view-all caller holding the other company's
   doc_no passed every caller of this guard, four money-writing payment verbs
   included. So COMPANY is checked FIRST and for everyone. It belongs here
   rather than in each handler: 18 callers share it, and the 19th gets it free. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SCM routers share one loosely-typed Hono context
export async function selfScopedSalesBlocked(c: any, docNo: string): Promise<boolean> {
  const sb = c.get('supabase');

  /* 1. Tenancy - every tier, view-all included. scopeToCompany DEGRADES when the
     company is UNRESOLVED and must NOT fail closed: unresolved means the
     companies master could not be read (pre-migration, D1 test mirror,
     Hyperdrive cold start), and refusing there locks every user out of all 18
     handlers. See "THE ALLOW-LIST SENTINEL" in companyScope.ts. */
  const { data: owned, error: ownedErr } = await scopeToCompany(
    sb.from('mfg_sales_orders').select('doc_no').eq('doc_no', docNo),
    c,
  ).maybeSingle();
  if (ownedErr || !owned) return true;

  // 2. Salesperson - only for the self-scoped tier.
  if (canViewAllSales(c)) return false; // view-all tier (director / office / *)
  const { data, error } = await sb
    .from('mfg_sales_orders')
    .select('salesperson_id, access_staff_ids, open_to_all')
    .eq('doc_no', docNo)
    .maybeSingle();
  if (error || !data) return true; // fail closed - unknown/unreadable doc is out of scope
  const r = data as { salesperson_id?: number | string | null; access_staff_ids?: string[] | null; open_to_all?: boolean | null };
  return soDocOutOfScope(sb, c.env, c.get('houzsUser')?.id, false, { salespersonId: r.salesperson_id, accessStaffIds: r.access_staff_ids, openToAll: r.open_to_all });
}
