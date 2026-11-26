import { Hono } from 'hono';
import type { Env } from '../../types';
import { C2990, createMirrorMapper, mirrorAuthed, upsert } from '../lib/mirror-map';

export const customerMirror = new Hono<{ Bindings: Env }>();

const { tableMap, applyMap } = createMirrorMapper({ customers: {} });

customerMirror.post('/', async (c) => {
  if (!mirrorAuthed(c)) return c.json({ error: 'unauthorized' }, 401);
  let body: { customerId?: string; deleted?: boolean; customer?: Record<string, unknown> };
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const id = String(body.customerId ?? body.customer?.id ?? '').trim();
  if (!id) return c.json({ error: 'customer_id_required' }, 400);
  const DB = c.env.DB;

  try {
    if (body.deleted) {
      await DB.prepare(`DELETE FROM scm."customers" WHERE company_id=? AND id=?`).bind(C2990, id).run();
      return c.json({ ok: true, customerId: id, action: 'deleted' });
    }
    if (!body.customer) return c.json({ error: 'customer_required' }, 400);

    const map = await tableMap(DB, 'customers');
    await upsert(DB, 'customers', applyMap(body.customer, map), 'id');

    return c.json({ ok: true, customerId: id });
  } catch (e) {
    return c.json({ error: 'mirror_failed', reason: (e as Error).message }, 500);
  }
});
