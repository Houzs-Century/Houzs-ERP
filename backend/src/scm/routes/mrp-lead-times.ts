// ----------------------------------------------------------------------------
// mrp-lead-times — per-category MRP lead time (Commander 2026-05-29), now also
// per-WAREHOUSE (Commander 2026-06-22, migration 0184 / SCM mig 0036).
//
// Backs the "Lead Times" dialog on the MRP page + feeds the MRP server's
// order-by-date calc and the PO-from-SO delivery-date calc. Five fixed
// categories, one integer each (days to order BEFORE the SO delivery date),
// scoped by warehouse. `warehouse_id = NULL` = the GLOBAL DEFAULT; a warehouse
// row overrides the global for that (warehouse, category). Lookup cascade
// everywhere: (warehouse, category) → (NULL, category) → 0. See migrations
// 0099 + 0184 (SCM mig 0036).
//
// Endpoints:
//   GET /     — { leadTimes: { "null": {sofa,…}, "<wh-uuid>": {sofa,…} } }
//               ("null" = the global-defaults bucket; one bucket per warehouse)
//   PUT /     — body { warehouseId: string|null, category, leadDays } → upsert
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { z } from 'zod';
import { supabaseAuth } from '../middleware/auth';
import { canWriteScmConfig } from '../lib/houzs-perms';
import { activeCompanyId, scopeToCompany } from '../lib/companyScope';
import type { Env, Variables } from '../env';

export const mrpLeadTimes = new Hono<{ Bindings: Env; Variables: Variables }>();
mrpLeadTimes.use('*', supabaseAuth);

const CATEGORIES = ['sofa', 'bedframe', 'mattress', 'accessory', 'service'] as const;
type Category = (typeof CATEGORIES)[number];
const putSchema = z.object({
  // null = the GLOBAL DEFAULT bucket; a uuid = that warehouse's override.
  warehouseId: z.string().uuid().nullable(),
  category: z.enum(CATEGORIES),
  leadDays: z.number().int().min(0),
});

type DbRow = { warehouse_id: string | null; category: string; lead_days: number };

// The global-defaults bucket lives under the string key "null"; each warehouse
// under its uuid. Every bucket defaults its 5 categories to 0.
const GLOBAL_KEY = 'null';
const emptyBucket = (): Record<Category, number> => ({
  sofa: 0, bedframe: 0, mattress: 0, accessory: 0, service: 0,
});

// GET / — per-warehouse map { [warehouseKey]: { sofa, bedframe, … } }. The
// global-defaults bucket is under "null"; missing categories default to 0.
mrpLeadTimes.get('/', async (c) => {
  const sb = c.get('supabase');
  const { data, error } = await scopeToCompany(
    sb
      .from('mrp_category_lead_times')
      .select('warehouse_id, category, lead_days'),
    c,
  );
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);
  const leadTimes: Record<string, Record<Category, number>> = { [GLOBAL_KEY]: emptyBucket() };
  for (const r of (data ?? []) as DbRow[]) {
    if (!(CATEGORIES as readonly string[]).includes(r.category)) continue;
    const key = r.warehouse_id ?? GLOBAL_KEY;
    const bucket = (leadTimes[key] ??= emptyBucket());
    bucket[r.category as Category] = r.lead_days ?? 0;
  }
  return c.json({ leadTimes });
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
  return c.json({
    ok: true,
    warehouseId: parsed.data.warehouseId,
    category: parsed.data.category,
    leadDays: parsed.data.leadDays,
  });
});
