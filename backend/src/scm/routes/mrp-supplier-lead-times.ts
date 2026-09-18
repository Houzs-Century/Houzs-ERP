// ----------------------------------------------------------------------------
// mrp-supplier-lead-times — the owner's MANUAL per-(supplier, category) lead
// time (owner 2026-09-11). Backs the "Lead times" section on the supplier page.
//
// A row here REPLACES the (warehouse, category) base when the PO convert and the
// MRP order-by hint resolve a line's lead days for THIS supplier + category —
// highest priority (scm/lib/lead-time.ts). It is the same five fixed categories,
// one non-negative integer each (days to order BEFORE the customer delivery
// date), scoped per supplier and per company.
//
// A row's PRESENCE is the override; its ABSENCE means "use the base". So an
// explicit 0 is a real override (order same-day) and DELETE — not "save 0" — is
// how you clear one. Never write a 0 row for a category the owner did not set:
// that would silently zero the base for that supplier.
//
// Endpoints (all gated scm.procurement.mrp, same as the base /mrp-lead-times):
//   GET    /?supplierId=<uuid> — { leadTimes: { sofa: n|null, … } } for one
//                                supplier; null = not overridden (base applies)
//   PUT    /  — body { supplierId, category, leadDays } → upsert the override
//   DELETE /  — body { supplierId, category } → clear the override (base applies)
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { z } from 'zod';
import { supabaseAuth } from '../middleware/auth';
import { activeCompanyId, scopeToCompany } from '../lib/companyScope';
import { LEAD_CATEGORIES, type LeadCategory } from '../lib/lead-time';
import type { Env, Variables } from '../env';

export const mrpSupplierLeadTimes = new Hono<{ Bindings: Env; Variables: Variables }>();
mrpSupplierLeadTimes.use('*', supabaseAuth);

/* The five categories have ONE home — LEAD_CATEGORIES in lib/lead-time.ts, the
   same list the resolver and the base table use. Imported, not re-declared, so
   this route cannot drift from them (duplicatedDecisionGate). */
const CATEGORIES = LEAD_CATEGORIES;
type Category = LeadCategory;

const putSchema = z.object({
  supplierId: z.string().uuid(),
  category: z.enum(CATEGORIES),
  leadDays: z.number().int().min(0),
});
const deleteSchema = z.object({
  supplierId: z.string().uuid(),
  category: z.enum(CATEGORIES),
});

type DbRow = { supplier_id: string; category: string; lead_days: number };

// GET /?supplierId= — one supplier's 5-category bucket. A category the owner has
// NOT overridden is null (the base applies), NOT 0 — the two are different facts.
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

  const leadTimes: Record<Category, number | null> = {
    sofa: null, bedframe: null, mattress: null, accessory: null, service: null,
  };
  for (const r of (data ?? []) as DbRow[]) {
    if ((CATEGORIES as readonly string[]).includes(r.category)) {
      leadTimes[r.category as Category] = r.lead_days ?? 0;
    }
  }
  return c.json({ leadTimes });
});

// PUT / — upsert one (supplier, category) override. Uniqueness is
// (company_id, supplier_id, category).
mrpSupplierLeadTimes.put('/', async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = putSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);

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

// DELETE / — clear one override so the base applies again. The company_id +
// supplier_id + category predicate is the whole tenant boundary on this write
// (the SCM client is service-role and bypasses RLS).
mrpSupplierLeadTimes.delete('/', async (c) => {
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
