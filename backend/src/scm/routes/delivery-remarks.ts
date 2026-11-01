// ----------------------------------------------------------------------------
// /delivery-remarks — the Last Mile order drawer's dispatch / customer-service
// REMARKS thread (owner 2026-11-01, phase 3). Shared notes per sales order, so a
// table (scm.delivery_remarks), not browser state. Keyed by so_doc_no, which is
// globally unique across companies (like delivery_planning_row_marks.row_key),
// so no company column — same precedent, same scope story.
//
//   GET  /?soDocNo=HC-SO-… — the thread for one order, oldest first.
//   GET  /flags            — every order that has >=1 remark, with its count
//                            (for the board's REMARK pill).
//   POST /                 — add a note { soDocNo, body }; author is snapshotted.
//
// Mounted at '/delivery-remarks' in scm/index.ts under the same transportation
// area guard as the board (GET open-read, POST needs edit).
// c.get('supabase') is the scm-scoped service client → scm.delivery_remarks.
// ----------------------------------------------------------------------------
import { Hono } from 'hono';
import { z } from 'zod';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';

export const deliveryRemarks = new Hono<{ Bindings: Env; Variables: Variables }>();
deliveryRemarks.use('*', supabaseAuth);

type RemarkRow = { id: number; so_doc_no: string; body: string; author_id: string | null; author_name: string | null; created_at: string };

const shape = (r: RemarkRow) => ({
  id: String(r.id),
  soDocNo: r.so_doc_no,
  body: r.body,
  authorName: r.author_name,
  createdAt: r.created_at,
});

/* Every order that carries at least one remark, with its count — the board uses
   it to show a REMARK pill without the heavy delivery-planning feed carrying it.
   Registered before '/' (distinct exact path); a day's board is a few hundred
   orders, so the whole small set is fine to return. */
deliveryRemarks.get('/flags', async (c) => {
  const sb = c.get('supabase');
  const { data, error } = await sb.from('delivery_remarks').select('so_doc_no');
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);
  const counts = new Map<string, number>();
  for (const r of data as Array<{ so_doc_no: string }>) counts.set(r.so_doc_no, (counts.get(r.so_doc_no) ?? 0) + 1);
  return c.json({ flags: [...counts].map(([soDocNo, count]) => ({ soDocNo, count })) });
});

deliveryRemarks.get('/', async (c) => {
  const soDocNo = c.req.query('soDocNo');
  if (!soDocNo) return c.json({ error: 'missing_so', reason: 'soDocNo is required' }, 400);
  const sb = c.get('supabase');
  const { data, error } = await sb.from('delivery_remarks')
    .select('id, so_doc_no, body, author_id, author_name, created_at')
    .eq('so_doc_no', soDocNo)
    .order('created_at', { ascending: true });
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);
  return c.json({ remarks: (data as RemarkRow[]).map(shape) });
});

const addSchema = z.object({
  soDocNo: z.string().trim().min(1).max(64),
  body: z.string().trim().min(1).max(2000),
});

deliveryRemarks.post('/', async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = addSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);

  const u = c.get('houzsUser');
  const sb = c.get('supabase');
  const { data, error } = await sb.from('delivery_remarks').insert({
    so_doc_no: parsed.data.soDocNo,
    body: parsed.data.body,
    author_id: u?.id != null ? String(u.id) : null,
    author_name: u?.name ?? u?.email ?? null,
  }).select('id, so_doc_no, body, author_id, author_name, created_at').maybeSingle();
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  return c.json({ remark: data ? shape(data as RemarkRow) : null });
});
