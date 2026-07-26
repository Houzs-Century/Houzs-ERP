// ----------------------------------------------------------------------------
// /threepl-companies — WS4a: the 3PL carrier COMPANY master (migration 0210).
// Owner-maintained: a 3PL is a company that owns several lorries; register the
// company here, then attach its lorries (scm.lorries.threepl_company_id) and,
// in WS4b, price by company instead of per-lorry. A solo operator is a one-lorry
// company.
//
// Per-company (tenant) scoped exactly like /delivery-residence-rules:
// scopeToCompany on reads, scopeToCompanyId on writes, stamp the active company
// on INSERT. The natural key is (company_id, name) (migration 0210).
//
// Endpoints:
//   GET    /      — list this tenant's 3PL companies (+ lorry counts), sorted
//   POST   /      — create a 3PL company
//   PATCH  /:id   — patch a company (name, contact, active, notes)
//   DELETE /:id   — delete a company (its lorries are DETACHED, not deleted)
//
// Mounted at '/threepl-companies' in scm/index.ts, gated by
// scmAreaGuard('scm.transportation.drivers') — same area as the rest of TMS.
// ----------------------------------------------------------------------------

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

export const threeplCompanies = new Hono<{ Bindings: Env; Variables: Variables }>();
threeplCompanies.use('*', supabaseAuth);

const COLS = 'id, name, contact_name, contact_phone, is_active, notes, created_at, updated_at';

type Row = {
  id: string;
  name?: string | null;
  contact_name?: string | null;   contactName?: string | null;
  contact_phone?: string | null;  contactPhone?: string | null;
  is_active?: boolean | null;     isActive?: boolean | null;
  notes?: string | null;
  created_at?: string | null;     createdAt?: string | null;
  updated_at?: string | null;     updatedAt?: string | null;
  lorry_count?: number | null;
};

function rowOut(r: Row, lorryCount = 0) {
  return {
    id:           r.id,
    name:         r.name ?? '',
    contactName:  r.contactName ?? r.contact_name ?? null,
    contactPhone: r.contactPhone ?? r.contact_phone ?? null,
    isActive:     (r.isActive ?? r.is_active ?? true) !== false,
    notes:        r.notes ?? null,
    lorryCount,
    createdAt:    r.createdAt ?? r.created_at ?? null,
    updatedAt:    r.updatedAt ?? r.updated_at ?? null,
  };
}

// ── GET / — list this tenant's 3PL companies, with a per-company lorry count.
threeplCompanies.get('/', async (c) => {
  const sb = c.get('supabase');
  const { data, error } = await paginateAll<Row>((from, to) =>
    scopeToCompany(sb.from('threepl_companies').select(COLS), c)
      .order('name', { ascending: true }).range(from, to),
  );
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);
  const companies = data ?? [];

  // Lorry counts per company — one grouped read, tolerant of an empty set.
  const counts = new Map<string, number>();
  if (companies.length > 0) {
    const { data: lorryRows } = await scopeToCompany(
      sb.from('lorries').select('threepl_company_id'), c,
    ).not('threepl_company_id', 'is', null);
    for (const l of (lorryRows ?? []) as Array<Record<string, unknown>>) {
      const id = String((l.threeplCompanyId ?? l.threepl_company_id) ?? '');
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return c.json({ companies: companies.map((r) => rowOut(r, counts.get(r.id) ?? 0)) });
});

const createSchema = z.object({
  name:         z.string().trim().min(1).max(120),
  contactName:  z.string().trim().max(120).nullable().optional(),
  contactPhone: z.string().trim().max(40).nullable().optional(),
  notes:        z.string().trim().max(2000).nullable().optional(),
  isActive:     z.boolean().optional(),
});

// ── POST / — create a 3PL company. (company_id, name) is UNIQUE -> 409 on dup.
threeplCompanies.post('/', async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const p = parsed.data;
  const user = c.get('user') as { id?: string } | null;

  const sb = c.get('supabase');
  const { data, error } = await sb.from('threepl_companies').insert({
    company_id:    co.companyId,
    name:          p.name,
    contact_name:  p.contactName ?? null,
    contact_phone: p.contactPhone ?? null,
    notes:         p.notes ?? null,
    is_active:     p.isActive ?? true,
    created_by:    user?.id ?? null,
    updated_by:    user?.id ?? null,
  }).select(COLS).single();
  if (error) {
    if (error.code === '23505') return c.json({ error: 'duplicate_name', reason: 'A 3PL company with that name already exists.' }, 409);
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    return c.json({ error: 'insert_failed', reason: error.message }, 500);
  }
  return c.json({ company: rowOut(data as Row) }, 201);
});

const patchSchema = z.object({
  name:         z.string().trim().min(1).max(120).optional(),
  contactName:  z.string().trim().max(120).nullable().optional(),
  contactPhone: z.string().trim().max(40).nullable().optional(),
  notes:        z.string().trim().max(2000).nullable().optional(),
  isActive:     z.boolean().optional(),
});

// ── PATCH /:id — STRICT company scope (a blind-id WHERE would let tenant A edit
//    tenant B's company by knowing its UUID).
threeplCompanies.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const p = parsed.data;
  const user = c.get('user') as { id?: string } | null;

  const updates: Record<string, unknown> = {};
  if (p.name !== undefined)         updates.name = p.name;
  if (p.contactName !== undefined)  updates.contact_name = p.contactName;
  if (p.contactPhone !== undefined) updates.contact_phone = p.contactPhone;
  if (p.notes !== undefined)        updates.notes = p.notes;
  if (p.isActive !== undefined)     updates.is_active = p.isActive;
  if (Object.keys(updates).length === 0) return c.json({ error: 'no_changes' }, 400);
  updates.updated_by = user?.id ?? null;
  updates.updated_at = new Date().toISOString();

  const sb = c.get('supabase');
  const { data, error } = await scopeToCompanyId(
    sb.from('threepl_companies').update(updates).eq('id', id),
    co.companyId,
  ).select(COLS).maybeSingle();
  if (error) {
    if (error.code === '23505') return c.json({ error: 'duplicate_name', reason: 'A 3PL company with that name already exists.' }, 409);
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    return c.json({ error: 'update_failed', reason: error.message }, 500);
  }
  if (!data) return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ company: rowOut(data as Row) });
});

// ── DELETE /:id — STRICT company scope. Its lorries are DETACHED (the FK is ON
//    DELETE SET NULL), never deleted — a carrier leaving should not erase lorry
//    history.
threeplCompanies.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');

  const { data: deleted, error } = await scopeToCompanyId(
    sb.from('threepl_companies').delete().eq('id', id),
    co.companyId,
  ).select('id').maybeSingle();
  if (error) {
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    return c.json({ error: 'delete_failed', reason: error.message }, 500);
  }
  if (!deleted) return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ ok: true });
});

export default threeplCompanies;
