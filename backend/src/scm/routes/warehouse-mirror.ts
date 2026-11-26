import { Hono } from 'hono';
import type { Env } from '../../types';
import { C2990, createMirrorMapper, mirrorAuthed, upsert } from '../lib/mirror-map';

export const warehouseMirror = new Hono<{ Bindings: Env }>();

const { tableMap, applyMap } = createMirrorMapper({
  warehouses: { forceCols: { is_default: false } },
});

warehouseMirror.post('/', async (c) => {
  if (!mirrorAuthed(c)) return c.json({ error: 'unauthorized' }, 401);
  let body: { warehouseId?: string; deleted?: boolean; warehouse?: Record<string, unknown> };
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const id = String(body.warehouseId ?? body.warehouse?.id ?? '').trim();
  if (!id) return c.json({ error: 'warehouse_id_required' }, 400);
  const DB = c.env.DB;

  try {
    if (body.deleted) {
      await DB.prepare(`UPDATE scm."warehouses" SET is_active=false WHERE company_id=? AND id=?`)
        .bind(C2990, id).run();
      return c.json({ ok: true, warehouseId: id, action: 'deactivated' });
    }
    if (!body.warehouse) return c.json({ error: 'warehouse_required' }, 400);

    const map = await tableMap(DB, 'warehouses');
    await upsert(DB, 'warehouses', applyMap(body.warehouse, map), 'id');

    return c.json({ ok: true, warehouseId: id });
  } catch (e) {
    return c.json({ error: 'mirror_failed', reason: (e as Error).message }, 500);
  }
});
