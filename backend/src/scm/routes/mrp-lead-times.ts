
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
  warehouseId: z.string().uuid().nullable(),
  category: z.string().regex(LEAD_CATEGORY_RE),
  leadDays: z.number().int().min(0),
});

type DbRow = { warehouse_id: string | null; category: string; lead_days: number };

const GLOBAL_KEY = 'null';

const categoryRegistry = (c: Context<{ Bindings: Env; Variables: Variables }>) =>
  c.get('supabase').from('acc_item_groups').select('code, name, is_active');

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

// global default. Uniqueness is (warehouse_id, category) (migration 0184).
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
