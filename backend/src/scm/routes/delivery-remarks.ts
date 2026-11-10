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
import { paginateAll } from '../lib/paginate-all';

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
   Registered before '/' (distinct exact path). The table holds every remark ever
   written, so it is paged: one plain select stopped at 1,000 rows and every order
   past them silently lost its pill. */
export async function loadRemarkFlags(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- scm-scoped supabase-js client
  sb: any,
): Promise<{ ok: true; flags: Array<{ soDocNo: string; count: number }> } | { ok: false; reason: string }> {
  const { data, error, truncated } = await paginateAll<{ so_doc_no: string }>((from, to) =>
    sb.from('delivery_remarks').select('so_doc_no').order('id').range(from, to));
  if (error) return { ok: false, reason: error.message };
  if (truncated) return { ok: false, reason: 'More remarks than one read can count; the REMARK pills would be incomplete.' };
  const counts = new Map<string, number>();
  for (const r of data ?? []) counts.set(r.so_doc_no, (counts.get(r.so_doc_no) ?? 0) + 1);
  return { ok: true, flags: [...counts].map(([soDocNo, count]) => ({ soDocNo, count })) };
}

deliveryRemarks.get('/flags', async (c) => {
  const r = await loadRemarkFlags(c.get('supabase'));
  if (!r.ok) return c.json({ error: 'fetch_failed', reason: r.reason }, 500);
  return c.json({ flags: r.flags });
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
