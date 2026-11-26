// ----------------------------------------------------------------------------
// mrp-supplier-lead-times — the owner's MANUAL per-(supplier, category) lead
// time (owner 2026-09-11). Backs the "Lead times" section on the supplier page.
//
// A row here REPLACES the (warehouse, category) base when the PO convert and the
// MRP order-by hint resolve a line's lead days for THIS supplier + category —
// highest priority (scm/lib/lead-time.ts). Same categories as the base table
// (every product category + Others), one non-negative integer each (days to order BEFORE the customer delivery
// date), scoped per supplier and per company.
//
// A row's PRESENCE is the override; its ABSENCE means "use the base". So an
// explicit 0 is a real override (order same-day) and DELETE — not "save 0" — is
// how you clear one. Never write a 0 row for a category the owner did not set:
// that would silently zero the base for that supplier.
//
// Endpoints (all mounted under scm.procurement.mrp; the two WRITES are ALSO
// config-write gated — see the PUT note below, same as the base /mrp-lead-times):
//   GET    /?supplierId=<uuid> — { leadTimes: { [category]: n } } for one
//                                supplier; a category absent = not overridden
//   PUT    /  — body { supplierId, category, leadDays } → upsert (config-write)
//   DELETE /  — body { supplierId, category } → clear the override (config-write)
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { z } from 'zod';
import { supabaseAuth } from '../middleware/auth';
import { canWriteScmConfig } from '../lib/houzs-perms';
import { activeCompanyId, scopeToCompany } from '../lib/companyScope';
import { LEAD_CATEGORY_RE, isSettableLeadCategory, loadLeadCategoryOptions } from '../lib/lead-time';
import type { Env, Variables } from '../env';

export const mrpSupplierLeadTimes = new Hono<{ Bindings: Env; Variables: Variables }>();
mrpSupplierLeadTimes.use('*', supabaseAuth);

const putSchema = z.object({
  supplierId: z.string().uuid(),
  category: z.string().regex(LEAD_CATEGORY_RE),
  leadDays: z.number().int().min(0),
});
const deleteSchema = z.object({
  supplierId: z.string().uuid(),
  category: z.string().regex(LEAD_CATEGORY_RE),
});

type DbRow = { supplier_id: string; category: string; lead_days: number };

mrpSupplierLeadTimes.get('/', async (c) => {
  const supplierId = c.req.query('supplierId');
  if (!supplierId) return c.json({ error: 'supplier_id_required' }, 400);

  const sb = c.get('supabase');
  const { data, error } = await scopeToCompany(
    sb
      .from('mrp_supplier_category_lead_times')
      .select('supplier_id, category, lead_days')
      .eq('supplier_id', supplierId),
    c,
  );
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);

  const leadTimes: Record<string, number> = {};
  for (const r of (data ?? []) as DbRow[]) leadTimes[r.category] = r.lead_days ?? 0;
  return c.json({ leadTimes });
});

mrpSupplierLeadTimes.put('/', async (c) => {
  if (!canWriteScmConfig(c)) {
    return c.json({ error: 'forbidden', reason: 'missing_scm_config_write' }, 403);
  }
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = putSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  try {
    const options = await loadLeadCategoryOptions(c.get('supabase').from('acc_item_groups').select('code, name, is_active'));
    if (!isSettableLeadCategory(options, parsed.data.category)) {
      return c.json({ error: 'unknown_category', category: parsed.data.category }, 400);
    }
  } catch (e) { return c.json({ error: 'fetch_failed', reason: (e as Error).message }, 500); }

  const sb = c.get('supabase');
  const { error } = await sb
    .from('mrp_supplier_category_lead_times')
    .upsert(
      {
        company_id: activeCompanyId(c),
        supplier_id: parsed.data.supplierId,
        category: parsed.data.category,
        lead_days: parsed.data.leadDays,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'company_id,supplier_id,category' },
    );
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  return c.json({ ok: true, ...parsed.data });
});

mrpSupplierLeadTimes.delete('/', async (c) => {
  if (!canWriteScmConfig(c)) {
    return c.json({ error: 'forbidden', reason: 'missing_scm_config_write' }, 403);
  }
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = deleteSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);

  const sb = c.get('supabase');
  const { error } = await sb
    .from('mrp_supplier_category_lead_times')
    .delete()
    .eq('company_id', activeCompanyId(c))
    .eq('supplier_id', parsed.data.supplierId)
    .eq('category', parsed.data.category);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  return c.json({ ok: true, ...parsed.data });
});
