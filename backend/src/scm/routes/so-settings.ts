// ----------------------------------------------------------------------------
// so-settings — SO Maintenance feature toggles (migration 0158, spec D5).
//   GET   /        — all rows: { settings: [{ key, enabled, label }] }
//   PATCH /:key    — { enabled: boolean } — config editors only; a KNOWN key
//                    (below) by its own rule, and created on its first write.
// The SO create path reads the same rows server-side (extra-amount gate;
// mfg-sales-orders.ts reads so_settings.pos_remark_extra_auto_sku).
// ----------------------------------------------------------------------------
import { Hono } from 'hono';
import { z } from 'zod';
import { supabaseAuth } from '../middleware/auth';
import { canWriteScmConfig, hasHouzsPerm } from '../lib/houzs-perms';
import { activeCompanyId, scopeToCompany } from '../lib/companyScope';
import { VENUE_DIFFERS_BLOCKS_KEY } from '../lib/fair-binding';
import { writeAudit } from '../../services/audit';
import type { Env, Variables } from '../env';

export const soSettings = new Hono<{ Bindings: Env; Variables: Variables }>();

soSettings.use('*', supabaseAuth);

// Houzs-flavoured: gate via canWriteScmConfig (flat `scm.config.write` OR the position policy canWriteConfig flag, see houzs-perms.ts) against
// the REAL caller (the 2990 staff_role lookup is dead in Houzs — the SCM
// bridge pins every caller to one super_admin row). Owner + IT Admin pass via
// `*`; grant the flat key to a ROLE, or set the Title's canWriteConfig flag,
// under Team > Roles & Permissions (the Roles and Titles tabs).

/** Settings this code knows that are not seeded: written by their own rule and
 *  created on their first write, so a company never needs a row before the
 *  switch can be flipped. Absent = off, which every reader takes as the default.
 *
 *  `fair_venue_differs_blocks` (owner 2026-10-19): "Venue differs" on a scanned
 *  order — the slip's place is not where the order was placed — is a FLAG until
 *  this is on, then a refusal at Confirm (fair-binding.ts::fairConfirmProblems).
 *  Owner or Finance only (`scm.finance.accounting`; `*` holds it), and every
 *  change goes to the audit ledger. */
export const KNOWN_SO_SETTINGS: Record<string, { label: string; perm: string }> = {
  [VENUE_DIFFERS_BLOCKS_KEY]: {
    label: 'Fair rules: "Venue differs" stops a scanned order being confirmed',
    perm: 'scm.finance.accounting',
  },
};

soSettings.get('/', async (c) => {
  const sb = c.get('supabase');
  const { data, error } = await scopeToCompany(
    sb
      .from('so_settings')
      .select('key, enabled, label, updated_at'),
    c,
  )
    .order('key');
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ settings: data ?? [] });
});

const patchSchema = z.object({ enabled: z.boolean() });

soSettings.patch('/:key', async (c) => {
  const key = c.req.param('key');
  const known = KNOWN_SO_SETTINGS[key];
  if (known ? !hasHouzsPerm(c, known.perm) : !canWriteScmConfig(c)) {
    return c.json({ error: 'forbidden', reason: known ? 'missing_finance_accounting' : 'missing_scm_config_write' }, 403);
  }
  const sb = c.get('supabase');

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);

  const companyId = activeCompanyId(c);
  /* A known key is created on its first write — and only for a resolved
     company, never as a company-less row every company would read. */
  if (known && companyId == null) return c.json({ error: 'company_unresolved' }, 409);
  const before = known
    ? await sb.from('so_settings').select('enabled').eq('key', key).eq('company_id', companyId).maybeSingle()
    : null;
  if (before?.error) return c.json({ error: 'load_failed', reason: before.error.message }, 500);
  /* Read NOW: the value before the write, for the ledger. */
  const was = (before?.data as { enabled?: boolean } | null)?.enabled === true;

  const { data, error } = known && !before?.data
    ? await sb
      .from('so_settings')
      .insert({ company_id: companyId, key, enabled: parsed.data.enabled, label: known.label, updated_at: new Date().toISOString() })
      .select('key, enabled, label, updated_at')
      .maybeSingle()
    : await sb
      .from('so_settings')
      .update({ enabled: parsed.data.enabled, updated_at: new Date().toISOString() })
      .eq('key', key)
      .eq('company_id', companyId)
      .select('key, enabled, label, updated_at')
      .maybeSingle();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  if (!data) return c.json({ error: 'not_found' }, 404);

  /* Who flipped a switch that decides whether a sale can be confirmed. The
     actor is the REAL person (houzsUser): inside /api/scm/* `user` is the
     pinned bridge identity every caller shares. Best-effort by contract. */
  if (known) {
    await writeAudit(c.env, {
      action: 'so_settings.update',
      entityType: 'so_settings',
      entityId: key,
      summary: `${known.label}: ${was ? 'on' : 'off'} → ${parsed.data.enabled ? 'on' : 'off'}`,
      meta: { companyId, before: was, after: parsed.data.enabled },
      actorId: c.get('houzsUser')?.id ?? null,
      actorEmail: c.get('houzsUser')?.email ?? null,
    });
  }
  return c.json({ setting: data });
});
