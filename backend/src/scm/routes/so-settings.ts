// ----------------------------------------------------------------------------
// so-settings — SO Maintenance feature toggles (migration 0158, spec D5).
//   GET   /        — all rows: { settings: [{ key, enabled, label }] }
//   PATCH /:key    — { enabled: boolean } — config editors only.
// The SO create path reads the same rows server-side (extra-amount gate;
// mfg-sales-orders.ts reads so_settings.pos_remark_extra_auto_sku).
// ----------------------------------------------------------------------------
import { Hono } from 'hono';
import { z } from 'zod';
import { supabaseAuth } from '../middleware/auth';
import { canWriteScmConfig } from '../lib/houzs-perms';
import { activeCompanyId, scopeToCompany } from '../lib/companyScope';
import type { Env, Variables } from '../env';

export const soSettings = new Hono<{ Bindings: Env; Variables: Variables }>();

soSettings.use('*', supabaseAuth);

// Houzs-flavoured: gate via canWriteScmConfig (flat `scm.config.write` OR the position policy canWriteConfig flag, see houzs-perms.ts) against
// the REAL caller (the 2990 staff_role lookup is dead in Houzs — the SCM
// bridge pins every caller to one super_admin row). Owner + IT Admin pass via
// `*`; grant the flat key to a ROLE, or set the Title's canWriteConfig flag,
// under Team > Roles & Permissions (the Roles and Titles tabs).

soSettings.get('/', async (c) => {
  const sb = c.get('supabase');
  const { data, error } = await scopeToCompany(
    sb
      .from('so_settings')
      .select('key, enabled, label'),
    c,
  )
    .order('key');
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ settings: data ?? [] });
});

const patchSchema = z.object({ enabled: z.boolean() });

soSettings.patch('/:key', async (c) => {
  if (!canWriteScmConfig(c)) {
    return c.json({ error: 'forbidden', reason: 'missing_scm_config_write' }, 403);
  }
  const sb = c.get('supabase');
  const key = c.req.param('key');

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);

  const { data, error } = await sb
    .from('so_settings')
    .update({ enabled: parsed.data.enabled, updated_at: new Date().toISOString() })
    .eq('key', key)
    .eq('company_id', activeCompanyId(c))
    .select('key, enabled, label')
    .maybeSingle();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  if (!data) return c.json({ error: 'not_found' }, 404);
  return c.json({ setting: data });
});
