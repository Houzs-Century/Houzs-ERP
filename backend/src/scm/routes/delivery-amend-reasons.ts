
import { Hono } from 'hono';
import { z } from 'zod';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { paginateAll } from '../lib/paginate-all';
import {
  scopeToCompany,
  scopeToCompanyId,
  requireActiveCompanyId,
  NOT_THIS_COMPANY,
} from '../lib/companyScope';

// Owner-managed amend / postpone reason list (owner 2026-11-27). The board's
// "Amend Reason" column and the Set-job-date drawer read this for their dropdown;
// the reason a Sales Order carries becomes the Postpone WhatsApp's "due to ..."
// line (amend_date_reason_2). Company-scoped exactly like delivery-residence-rules.
export const deliveryAmendReasons = new Hono<{ Bindings: Env; Variables: Variables }>();
deliveryAmendReasons.use('*', supabaseAuth);

const REASON_COLS = 'id, label, sort_order, is_active, created_at, updated_at';

type ReasonRow = {
  id: string;
  label?: string | null;
  sort_order?: number | null;  sortOrder?: number | null;
  is_active?: boolean | null;  isActive?: boolean | null;
  created_at?: string | null;  createdAt?: string | null;
  updated_at?: string | null;  updatedAt?: string | null;
};

function reasonOut(r: ReasonRow) {
  return {
    id:        r.id,
    label:     r.label ?? '',
    sortOrder: Number(r.sortOrder ?? r.sort_order ?? 0),
    isActive:  (r.isActive ?? r.is_active ?? true) !== false,
    createdAt: r.createdAt ?? r.created_at ?? null,
    updatedAt: r.updatedAt ?? r.updated_at ?? null,
  };
}

// ── GET / — the ACTIVE company's reason list (active and inactive; the board
//    dropdown filters to active, the admin editor shows all). openRead at the
//    mount, so any board user can read the options regardless of config rights.
deliveryAmendReasons.get('/', async (c) => {
  const sb = c.get('supabase');
  const { data, error } = await paginateAll<ReasonRow>((from, to) =>
    scopeToCompany(
      sb.from('delivery_amend_reasons').select(REASON_COLS),
      c,
    ).order('sort_order', { ascending: true }).order('label', { ascending: true }).range(from, to),
  );
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);
  return c.json({ reasons: (data ?? []).map(reasonOut) });
});

const reasonCreateSchema = z.object({
  label:     z.string().trim().min(1).max(200),
  sortOrder: z.number().int().optional(),
  isActive:  z.boolean().optional(),
});

deliveryAmendReasons.post('/', async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = reasonCreateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const p = parsed.data;
  const user = c.get('user') as { id?: string } | null;

  const sb = c.get('supabase');
  const { data, error } = await sb.from('delivery_amend_reasons').insert({
    company_id: co.companyId,
    label:      p.label,
    sort_order: p.sortOrder ?? 0,
    is_active:  p.isActive ?? true,
    created_by: user?.id ?? null,
    updated_by: user?.id ?? null,
  }).select(REASON_COLS).single();
  if (error) {
    if (error.code === '23505') return c.json({ error: 'duplicate_label', reason: 'That reason already exists.' }, 409);
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    return c.json({ error: 'insert_failed', reason: error.message }, 500);
  }
  return c.json({ reason: reasonOut(data as ReasonRow) }, 201);
});

const reasonPatchSchema = z.object({
  label:     z.string().trim().min(1).max(200).optional(),
  sortOrder: z.number().int().optional(),
  isActive:  z.boolean().optional(),
});

deliveryAmendReasons.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = reasonPatchSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const p = parsed.data;
  const user = c.get('user') as { id?: string } | null;

  const updates: Record<string, unknown> = {};
  if (p.label !== undefined)     updates.label = p.label;
  if (p.sortOrder !== undefined) updates.sort_order = p.sortOrder;
  if (p.isActive !== undefined)  updates.is_active = p.isActive;
  if (Object.keys(updates).length === 0) return c.json({ error: 'no_changes' }, 400);
  updates.updated_by = user?.id ?? null;
  updates.updated_at = new Date().toISOString();

  const sb = c.get('supabase');
  const { data, error } = await scopeToCompanyId(
    sb.from('delivery_amend_reasons').update(updates).eq('id', id),
    co.companyId,
  ).select(REASON_COLS).maybeSingle();
  if (error) {
    if (error.code === '23505') return c.json({ error: 'duplicate_label', reason: 'That reason already exists.' }, 409);
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    return c.json({ error: 'update_failed', reason: error.message }, 500);
  }
  if (!data) return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ reason: reasonOut(data as ReasonRow) });
});

// ── DELETE /:id — remove a reason option. A reason already stored on an SO or a
//    service-case leg is plain text and keeps working; this only drops it from
//    the pick list. Prefer deactivating (isActive=false) to keep the history
//    tidy, but a hard delete is allowed. STRICT company scope.
deliveryAmendReasons.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');

  const { data: deleted, error } = await scopeToCompanyId(
    sb.from('delivery_amend_reasons').delete().eq('id', id),
    co.companyId,
  ).select('id').maybeSingle();
  if (error) {
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    return c.json({ error: 'delete_failed', reason: error.message }, 500);
  }
  if (!deleted) return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ ok: true });
});
