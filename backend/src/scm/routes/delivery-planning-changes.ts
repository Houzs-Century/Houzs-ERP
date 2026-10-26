/* GET /delivery-planning/changes?after=<id> - which orders changed since the
   board last looked (owner 2026-10-27, option B). Reads scm.delivery_board_changes,
   written by a trigger on every table the board reads (migration
   20261027T1000), and paged by its serial id: no clock is compared anywhere.

   No `after`: answers the current cursor only (the board's first look).
   With `after`: the SO doc numbers changed since, `others` when a service case /
   DP job / project leg changed, and `full` when too much changed to list (the
   board then re-reads wholesale). */
import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { allowedCompanyIds } from '../lib/companyScope';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;
const LIMIT = 2000;

export function summariseChanges(
  rows: Array<{ id: number; doc_no: string; company_id: number | null }>,
  after: number,
  allowed: number[] | undefined,
): { cursor: number; docs: string[]; others: boolean; full: boolean } {
  if (rows.length > LIMIT) return { cursor: rows[LIMIT - 1]!.id, docs: [], others: false, full: true };
  const docs = new Set<string>();
  let others = false;
  for (const r of rows) {
    if (r.doc_no === '*OTHER*') { others = true; continue; }
    if (allowed && !(r.company_id != null && allowed.includes(Number(r.company_id)))) continue;
    docs.add(r.doc_no);
  }
  return { cursor: rows.length ? rows[rows.length - 1]!.id : after, docs: [...docs], others, full: false };
}

export async function boardChangesHandler(c: Ctx) {
  const sb = c.get('supabase');
  const afterRaw = c.req.query('after');
  if (afterRaw == null) {
    const { data, error } = await sb.from('delivery_board_changes').select('id').order('id', { ascending: false }).limit(1);
    if (error) return c.json({ error: 'read_failed', reason: error.message }, 500);
    return c.json({ cursor: Number((data as Array<{ id: number }> | null)?.[0]?.id ?? 0), docs: [], others: false, full: false });
  }
  const after = Number(afterRaw);
  if (!Number.isFinite(after) || after < 0) return c.json({ error: 'bad_after' }, 400);
  // company-scope: rows are filtered by the caller's granted companies in summariseChanges (company_id on every SO row); '*OTHER*' markers carry no order.
  const { data, error } = await sb.from('delivery_board_changes').select('id, doc_no, company_id').gt('id', after).order('id').limit(LIMIT + 1);
  if (error) return c.json({ error: 'read_failed', reason: error.message }, 500);
  return c.json(summariseChanges((data ?? []) as Array<{ id: number; doc_no: string; company_id: number | null }>, after, allowedCompanyIds(c)));
}
