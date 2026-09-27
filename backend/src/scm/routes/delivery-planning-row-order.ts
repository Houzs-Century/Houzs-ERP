// ----------------------------------------------------------------------------
// /delivery-planning-row-order — the Delivery Planning board's manual drag order
// (owner 2026-09-26: 拖动行手动排).
//
// ONE row (scope = 'board') holds the whole order as a jsonb array of board row
// ids (`rowIdOf`). Shared across viewers and both companies; it only decides the
// board's DEFAULT sort, so a column sort overrides it and clearing the sort
// brings it back. A drag replaces the array; rows the array omits fall after the
// listed ones in natural order, and a stale id the array still lists is skipped.
//
//   GET /   — { orderedKeys: string[] }
//   PUT /   — { orderedKeys: string[] }  (replaces the order)
//
// Mounted at '/delivery-planning-row-order' in scm/index.ts under the same
// transportation-area guard as the board (GET open-read, PUT needs edit).
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { z } from 'zod';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';

export const deliveryPlanningRowOrder = new Hono<{ Bindings: Env; Variables: Variables }>();
deliveryPlanningRowOrder.use('*', supabaseAuth);

const SCOPE = 'board';

deliveryPlanningRowOrder.get('/', async (c) => {
  const sb = c.get('supabase');
  const { data, error } = await sb.from('delivery_planning_row_order')
    .select('ordered_keys').eq('scope', SCOPE).maybeSingle();
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);
  const raw = (data as { ordered_keys?: unknown } | null)?.ordered_keys;
  const orderedKeys = Array.isArray(raw) ? (raw.filter((k): k is string => typeof k === 'string')) : [];
  return c.json({ orderedKeys });
});

const setSchema = z.object({
  orderedKeys: z.array(z.string().trim().min(1).max(120)).max(5000),
});

deliveryPlanningRowOrder.put('/', async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = setSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);

  const user = c.get('user');
  const sb = c.get('supabase');
  const { error } = await sb.from('delivery_planning_row_order').upsert({
    scope: SCOPE,
    ordered_keys: parsed.data.orderedKeys,
    updated_by: user.id,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'scope' });
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  return c.json({ ok: true });
});
