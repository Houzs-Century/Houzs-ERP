import { Hono } from 'hono';
import type { Env } from '../../types';
import { createMirrorMapper, mirrorAuthed, upsert } from '../lib/mirror-map';

export const staffMirror = new Hono<{ Bindings: Env }>();

const SYSTEM_STAFF_ID = '00000000-0000-4000-8000-000000000001';

const { tableMap, applyMap } = createMirrorMapper({
  staff: {
    forceCols: {
      showroom_id: null,
      venue_id: null,
      active: false,
    },
    preserveCols: ['user_id'],
  },
});

staffMirror.post('/', async (c) => {
  if (!mirrorAuthed(c)) return c.json({ error: 'unauthorized' }, 401);
  let body: { staffId?: string; deleted?: boolean; staff?: Record<string, unknown> };
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const id = String(body.staffId ?? body.staff?.id ?? '').trim();
  if (!id) return c.json({ error: 'staff_id_required' }, 400);
  if (id === SYSTEM_STAFF_ID) {
    return c.json({ ok: true, staffId: id, action: 'ignored', reason: 'system_staff_row_never_mirrors' });
  }
  const DB = c.env.DB;

  try {
    if (body.deleted) {
      return c.json({ ok: true, staffId: id, action: 'ignored', reason: 'staff_delete_never_mirrors' });
    }
    if (!body.staff) return c.json({ error: 'staff_required' }, 400);

    const map = await tableMap(DB, 'staff');
    await upsert(DB, 'staff', applyMap(body.staff, map), 'id', {
      where: `"staff".user_id IS NULL`,
    });

    return c.json({ ok: true, staffId: id });
  } catch (e) {
    return c.json({ error: 'mirror_failed', reason: (e as Error).message }, 500);
  }
});
