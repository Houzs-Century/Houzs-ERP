import { Hono } from 'hono';
import type { Env } from '../../types';
import { C2990, createMirrorMapper, mirrorAuthed, prefixDoc, upsert } from '../lib/mirror-map';

export const amendmentMirror = new Hono<{ Bindings: Env }>();

const CANON_AMENDMENT_STATUS = new Set([
  'REQUESTED', 'SUPPLIER_PENDING', 'SO_APPROVED', 'PO_APPROVED', 'SENT', 'REJECTED',
]);

const { tableMap, applyMap } = createMirrorMapper({
  so_amendments: {
    prefixCols: ['so_doc_no', 'amendment_no'],
    forceCols: { header_changes: null, old_header_snapshot: null },
    normalize: {
      status: (v: unknown) => {
        const s = v == null ? '' : String(v).trim().toUpperCase();
        if (!CANON_AMENDMENT_STATUS.has(s)) throw new Error(`unknown_amendment_status:${String(v)}`);
        return s;
      },
    },
  },
  so_amendment_lines: {},
});

amendmentMirror.post('/', async (c) => {
  if (!mirrorAuthed(c)) return c.json({ error: 'unauthorized' }, 401);
  let body: {
    amendmentId?: string;
    deleted?: boolean;
    header?: Record<string, unknown>;
    lines?: Record<string, unknown>[];
  };
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const id = String(body.amendmentId ?? body.header?.id ?? '').trim();
  if (!id) return c.json({ error: 'amendment_id_required' }, 400);
  const DB = c.env.DB;

  try {
    if (body.deleted) {
      await DB.prepare(`DELETE FROM scm."so_amendments" WHERE company_id=? AND id=?`).bind(C2990, id).run();
      return c.json({ ok: true, amendmentId: id, action: 'deleted' });
    }
    if (!body.header) return c.json({ error: 'header_required' }, 400);

    const hMap = await tableMap(DB, 'so_amendments');
    const lMap = await tableMap(DB, 'so_amendment_lines');

    await upsert(DB, 'so_amendments', applyMap(body.header, hMap), 'id');

    await DB.prepare(`DELETE FROM scm."so_amendment_lines" WHERE company_id=? AND amendment_id=?`).bind(C2990, id).run();
    for (const l of body.lines ?? []) await upsert(DB, 'so_amendment_lines', applyMap(l, lMap), 'id');

    return c.json({ ok: true, amendmentId: id, lines: (body.lines ?? []).length });
  } catch (e) {
    return c.json({ error: 'mirror_failed', reason: (e as Error).message }, 500);
  }
});
