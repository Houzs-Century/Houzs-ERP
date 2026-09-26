// ----------------------------------------------------------------------------
// /delivery-planning-row-marks — manual colour tags on Delivery Planning board
// rows (owner 2026-09-26: 色板标记).
//
// A mark is SHARED (everyone on the board sees it), so it is a table, not browser
// state. One row per board row, keyed by the board's own row id (`rowIdOf`:
// so:<doc_no> / assr:<id> / dp:<id> / project:<id>), which is already unique
// across the two companies, so the mark needs no company column. Cosmetic: a
// mark gates nothing. Clearing deletes the row, so an unmarked board is empty.
//
//   GET    /            — every mark { rowKey, colour } (only painted rows).
//   PUT    /            — paint a row: { rowKey, colour } (upsert on row_key).
//   DELETE /:rowKey     — clear a row's mark.
//
// Mounted at '/delivery-planning-row-marks' in scm/index.ts, under the same
// transportation area guard as the board (GET open-read, writes need edit).
// c.get('supabase') is the scm-scoped service client → scm.delivery_planning_row_marks.
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { z } from 'zod';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { isRowMarkColour } from '../lib/row-mark-colours';

export const deliveryPlanningRowMarks = new Hono<{ Bindings: Env; Variables: Variables }>();
deliveryPlanningRowMarks.use('*', supabaseAuth);

type MarkRow = { row_key: string; colour: string };

deliveryPlanningRowMarks.get('/', async (c) => {
  const sb = c.get('supabase');
  const { data, error } = await sb.from('delivery_planning_row_marks').select('row_key, colour');
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);
  return c.json({ marks: ((data ?? []) as MarkRow[]).map((m) => ({ rowKey: m.row_key, colour: m.colour })) });
});

const setSchema = z.object({
  rowKey: z.string().trim().min(1).max(120),
  colour: z.string().trim(),
});

deliveryPlanningRowMarks.put('/', async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = setSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  if (!isRowMarkColour(parsed.data.colour)) return c.json({ error: 'invalid_colour' }, 400);

  const user = c.get('user');
  const sb = c.get('supabase');
  const { error } = await sb.from('delivery_planning_row_marks').upsert({
    row_key: parsed.data.rowKey,
    colour: parsed.data.colour,
    marked_by: user.id,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'row_key' });
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  return c.json({ ok: true });
});

deliveryPlanningRowMarks.delete('/:rowKey', async (c) => {
  const rowKey = c.req.param('rowKey');
  const sb = c.get('supabase');
  const { error } = await sb.from('delivery_planning_row_marks').delete().eq('row_key', rowKey);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  return c.json({ ok: true });
});
