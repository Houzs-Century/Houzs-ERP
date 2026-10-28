// ----------------------------------------------------------------------------
// state-warehouse-mappings — PR #158.
//
// Commander 2026-05-27: "什么 State 对应哪个 Warehouse 也需要设置清楚".
// CRUD for the state_warehouse_mappings table (migration 0071).
//
// Endpoints:
//   GET    /          — list all mappings (joined with warehouse name/code)
//   PUT    /:state    — upsert mapping for a state. Body: { warehouseId, notes }
//   DELETE /:state    — clear mapping for a state
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { z } from 'zod';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { activeCompanyId, scopeToCompany } from '../lib/companyScope';
import { canWriteScmConfig } from '../lib/houzs-perms';

export const stateWarehouseMappings = new Hono<{ Bindings: Env; Variables: Variables }>();

stateWarehouseMappings.use('*', supabaseAuth);

const upsertSchema = z.object({
  warehouseId: z.string().uuid().nullable().optional(),
  notes:       z.string().nullable().optional(),
});

// GET — every authenticated staff can read.
stateWarehouseMappings.get('/', async (c) => {
  const sb = c.get('supabase');
  const { data, error } = await scopeToCompany(
    sb
      .from('state_warehouse_mappings')
      .select('id, state, warehouse_id, notes, updated_at, warehouses(id, code, name)'),
    c,
  ).order('state', { ascending: true });
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);
  return c.json({
    mappings: (data ?? []).map((r: unknown) => {
      const row = r as { id: string; state: string; warehouse_id: string | null; notes: string | null; updated_at: string; warehouses: { id: string; code: string; name: string } | null };
      return {
        id:          row.id,
        state:       row.state,
        warehouseId: row.warehouse_id,
        notes:       row.notes,
        warehouse:   row.warehouses ? { id: row.warehouses.id, code: row.warehouses.code, name: row.warehouses.name } : null,
        updatedAt:   row.updated_at,
      };
    }),
  });
});

// PUT /:state — upsert. Body: { warehouseId, notes }.
stateWarehouseMappings.put('/:state', async (c) => {
  /* GATED. Both writes had NO permission check - only supabaseAuth - and the
     router is mounted bare, so no area guard runs. Any caller who passes
     requireScmAccess could repoint which warehouse an ENTIRE STATE ships from,
     or clear the mapping. Same class as the localities writes fixed alongside
     this; every other config writer in the SCM tree gates on canWriteScmConfig. */
  if (!canWriteScmConfig(c)) {
    return c.json({ error: "You don't have permission to change state routing." }, 403);
  }
  const state = c.req.param('state');
  if (!state) return c.json({ error: 'state_required' }, 400);

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = upsertSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);

  const sb = c.get('supabase');
  const { data, error } = await sb
    .from('state_warehouse_mappings')
    .upsert(
      {
        state,
        warehouse_id: parsed.data.warehouseId ?? null,
        notes:        parsed.data.notes ?? null,
        updated_at:   new Date().toISOString(),
        // 0092: state is unique PER COMPANY now
        company_id:   activeCompanyId(c),
      },
      { onConflict: 'company_id,state' },
    )
    .select('id, state, warehouse_id, notes')
    .single();
  if (error) return c.json({ error: 'upsert_failed', reason: error.message }, 500);
  return c.json({ mapping: data });
});

// DELETE /:state — clear mapping.
stateWarehouseMappings.delete('/:state', async (c) => {
  if (!canWriteScmConfig(c)) {
    return c.json({ error: "You don't have permission to change state routing." }, 403);
  }
  const state = c.req.param('state');
  if (!state) return c.json({ error: 'state_required' }, 400);
  const sb = c.get('supabase');
  const { error } = await scopeToCompany(
    sb.from('state_warehouse_mappings').delete().eq('state', state),
    c,
  );
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  return c.json({ ok: true });
});
