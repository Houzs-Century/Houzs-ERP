// ----------------------------------------------------------------------------
// mrp-lead-times — per-category MRP lead time (Commander 2026-05-29), now also
// per-WAREHOUSE (Commander 2026-06-22, migration 0184 / SCM mig 0036).
//
// Backs the "Lead Times" dialog on the MRP page + feeds the MRP server's
// order-by-date calc and the PO-from-SO delivery-date calc. One integer per
// product category (days to order BEFORE the SO delivery date), plus Others,
// scoped by warehouse. `warehouse_id = NULL` = the GLOBAL DEFAULT; a warehouse
// row overrides the global for that (warehouse, category). The lookup cascade
// lives in lib/lead-time.ts. See migrations 0099 + 0184 (SCM mig 0036).
//
// Endpoints:
//   GET /     — { categories, leadTimes: { "null": {sofa,…}, "<wh-uuid>": {…} } }
//               ("null" = the global-defaults bucket; one bucket per warehouse)
//   PUT /     — body { warehouseId: string|null, category, leadDays } → upsert
// ----------------------------------------------------------------------------

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { supabaseAuth } from '../middleware/auth';
import { canWriteScmConfig } from '../lib/houzs-perms';
import { activeCompanyId, scopeToCompany } from '../lib/companyScope';
import { bustProcurementOverview } from './procurement-overview';
import { LEAD_CATEGORY_RE, isSettableLeadCategory, loadLeadCategoryOptions } from '../lib/lead-time';
import type { Env, Variables } from '../env';

export const mrpLeadTimes = new Hono<{ Bindings: Env; Variables: Variables }>();
mrpLeadTimes.use('*', supabaseAuth);

const putSchema = z.object({
  // null = the GLOBAL DEFAULT bucket; a uuid = that warehouse's override.
  warehouseId: z.string().uuid().nullable(),
  category: z.string().regex(LEAD_CATEGORY_RE),
  leadDays: z.number().int().min(0),
});

type DbRow = { warehouse_id: string | null; category: string; lead_days: number };

// The global-defaults bucket lives under the string key "null"; each warehouse
// under its uuid.
const GLOBAL_KEY = 'null';

const categoryRegistry = (c: Context<{ Bindings: Env; Variables: Variables }>) =>
  c.get('supabase').from('acc_item_groups').select('code, name, is_active');

// GET / — { categories, leadTimes }. categories: every product category a lead
// time can be set for, new ones included (2990-0063). leadTimes: per-warehouse
// map { [warehouseKey]: { [category]: days } } holding only what is SET; a
// missing category falls back (own -> sofa for a Sofa Accessory -> others -> 0,
// see lib/lead-time.ts). The global-defaults bucket is under "null".
mrpLeadTimes.get('/', async (c) => {
  const sb = c.get('supabase');
  const [rows, categories] = await Promise.all([
    scopeToCompany(sb.from('mrp_category_lead_times').select('warehouse_id, category, lead_days'), c),
    loadLeadCategoryOptions(categoryRegistry(c)).catch((e: Error) => e),
  ]);
  if (rows.error) return c.json({ error: 'fetch_failed', reason: rows.error.message }, 500);
  if (categories instanceof Error) return c.json({ error: 'fetch_failed', reason: categories.message }, 500);
  const leadTimes: Record<string, Record<string, number>> = { [GLOBAL_KEY]: {} };
  for (const r of (rows.data ?? []) as DbRow[]) {
    const key = r.warehouse_id ?? GLOBAL_KEY;
    (leadTimes[key] ??= {})[r.category] = r.lead_days ?? 0;
  }
  return c.json({ categories, leadTimes });
});

// PUT / — upsert one (warehouse, category)'s lead days. warehouseId null = the
// global default. Uniqueness is (warehouse_id, category) (migration 0184).
//
// Config-write gated (canWriteScmConfig — flat `scm.config.write` OR the position
// policy canWriteConfig flag, see houzs-perms.ts), mirroring the FE "Lead Times"
// button. The /mrp-lead-times/* area guard is scm.procurement.mrp, which falls
// through for a non-L2-configured caller (a flat scm.access holder), so the coarse
// umbrella alone would let any SCM user rewrite lead times without this gate. GET
// stays open — the MRP page reads lead times for its order-by-date calc.
mrpLeadTimes.put('/', async (c) => {
  if (!canWriteScmConfig(c)) {
    return c.json({ error: 'forbidden', reason: 'missing_scm_config_write' }, 403);
  }
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = putSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  let options;
  try { options = await loadLeadCategoryOptions(categoryRegistry(c)); }
  catch (e) { return c.json({ error: 'fetch_failed', reason: (e as Error).message }, 500); }
  if (!isSettableLeadCategory(options, parsed.data.category)) {
    return c.json({ error: 'unknown_category', category: parsed.data.category }, 400);
  }

  const sb = c.get('supabase');
  const { error } = await sb
    .from('mrp_category_lead_times')
    .upsert(
      {
        company_id: activeCompanyId(c),
        warehouse_id: parsed.data.warehouseId,
        category: parsed.data.category,
        lead_days: parsed.data.leadDays,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'company_id,warehouse_id,category' },
    );
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  // HC-0145: the Procurement Overview is cached (swr:procov) with these settings inside it.
  const companyId = activeCompanyId(c);
  if (companyId != null) {
    try { await bustProcurementOverview(c.env?.SESSION_CACHE, companyId); } catch (e) { console.warn('[mrp-lead-times] procov cache bust failed:', (e as Error)?.message ?? e); }
  }
  return c.json({
    ok: true,
    warehouseId: parsed.data.warehouseId,
    category: parsed.data.category,
    leadDays: parsed.data.leadDays,
  });
});
