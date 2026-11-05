// ----------------------------------------------------------------------------
// /saved-locations — the "common locations" address book (migration 20261102T1700,
// owner 2026-11-02 方案2). Owner-maintained points a transfer is driven between —
// customers, suppliers, outsourced warehouses, frequent drops — so the DP order's
// origin and destination can be PICKED from a kept list instead of re-typed.
//
// Per-company (tenant) scoped exactly like /threepl-companies: scopeToCompany on
// reads, scopeToCompanyId on writes, stamp the active company on INSERT. Natural
// key (company_id, name).
//
//   GET    /      — list this tenant's saved locations, sorted by name
//   POST   /      — create a location
//   PATCH  /:id   — patch a location
//   DELETE /:id   — delete a location (DP orders keep their snapshot — soft link)
//
// Mounted at '/saved-locations' in scm/index.ts, gated by
// scmAreaGuard('scm.transportation.drivers') — same area as the rest of TMS.
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { z } from 'zod';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { paginateAll } from '../lib/paginate-all';
import { normalizePhone } from '../shared/phone';
import {
  scopeToCompany,
  scopeToCompanyId,
  requireActiveCompanyId,
  NOT_THIS_COMPANY,
} from '../lib/companyScope';

export const savedLocations = new Hono<{ Bindings: Env; Variables: Variables }>();
savedLocations.use('*', supabaseAuth);

const COLS = 'id, name, contact_name, contact_phone, address1, address2, city, postcode, state, is_active, notes, created_at, updated_at';

type Row = {
  id: string;
  name?: string | null;
  contact_name?: string | null;  contactName?: string | null;
  contact_phone?: string | null; contactPhone?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  postcode?: string | null;
  state?: string | null;
  is_active?: boolean | null;    isActive?: boolean | null;
  notes?: string | null;
  created_at?: string | null;    createdAt?: string | null;
  updated_at?: string | null;    updatedAt?: string | null;
};

function rowOut(r: Row) {
  return {
    id:           r.id,
    name:         r.name ?? '',
    contactName:  r.contactName ?? r.contact_name ?? null,
    contactPhone: r.contactPhone ?? r.contact_phone ?? null,
    address1:     r.address1 ?? null,
    address2:     r.address2 ?? null,
    city:         r.city ?? null,
    postcode:     r.postcode ?? null,
    state:        r.state ?? null,
    isActive:     (r.isActive ?? r.is_active ?? true) !== false,
    notes:        r.notes ?? null,
    createdAt:    r.createdAt ?? r.created_at ?? null,
    updatedAt:    r.updatedAt ?? r.updated_at ?? null,
  };
}

// ── GET / — list this tenant's saved locations.
savedLocations.get('/', async (c) => {
  const sb = c.get('supabase');
  const { data, error } = await paginateAll<Row>((from, to) =>
    scopeToCompany(sb.from('saved_locations').select(COLS), c)
      .order('name', { ascending: true }).range(from, to),
  );
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);
  return c.json({ locations: (data ?? []).map(rowOut) });
});

/* Phones are NORMALISED to E.164, not merely checked (same rule as
   threepl-companies.ts): a location contact may be a landline, so normalizePhone
   reshapes both and returns null only for something that is not a number at all. */
const optionalPhone = z.string().trim().max(40).nullable().optional().superRefine((v, ctx) => {
  if (v == null || v === '') return;
  if (!normalizePhone(v)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Contact phone is not a usable phone number.' });
});

const locationFields = {
  name:         z.string().trim().min(1).max(160),
  contactName:  z.string().trim().max(120).nullable().optional(),
  contactPhone: optionalPhone,
  address1:     z.string().trim().max(200).nullable().optional(),
  address2:     z.string().trim().max(200).nullable().optional(),
  city:         z.string().trim().max(120).nullable().optional(),
  postcode:     z.string().trim().max(20).nullable().optional(),
  state:        z.string().trim().max(120).nullable().optional(),
  notes:        z.string().trim().max(2000).nullable().optional(),
  isActive:     z.boolean().optional(),
};

const createSchema = z.object(locationFields);
const patchSchema = z.object({ ...locationFields, name: locationFields.name.optional() });

const asPhone = (v: string | null | undefined): string | null => (v ? normalizePhone(v) : null);

/* Owner 方案2: a saved location with no address line is useless — the whole point
   is to keep an address to reuse. Hold it to the same "needs a street line" rule
   the DP order itself enforces. */
const ADDRESS_REQUIRED = {
  error: 'address_required',
  reason: 'A saved location needs an address. Fill in address line 1 or 2 before saving.',
};
const hasAddress = (a1: string | null | undefined, a2: string | null | undefined): boolean =>
  (a1 ?? '').trim() !== '' || (a2 ?? '').trim() !== '';

// ── POST / — create. (company_id, name) is UNIQUE -> 409 on duplicate.
savedLocations.post('/', async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const p = parsed.data;
  if (!hasAddress(p.address1, p.address2)) return c.json(ADDRESS_REQUIRED, 400);
  const user = c.get('user') as { id?: string } | null;

  const sb = c.get('supabase');
  const { data, error } = await sb.from('saved_locations').insert({
    company_id:    co.companyId,
    name:          p.name,
    contact_name:  p.contactName ?? null,
    contact_phone: asPhone(p.contactPhone),
    address1:      p.address1 ?? null,
    address2:      p.address2 ?? null,
    city:          p.city ?? null,
    postcode:      p.postcode ?? null,
    state:         p.state ?? null,
    notes:         p.notes ?? null,
    is_active:     p.isActive ?? true,
    created_by:    user?.id ?? null,
    updated_by:    user?.id ?? null,
  }).select(COLS).single();
  if (error) {
    if (error.code === '23505') return c.json({ error: 'duplicate_name', reason: 'A saved location with that name already exists.' }, 409);
    return c.json({ error: 'insert_failed', reason: error.message }, 500);
  }
  return c.json({ location: rowOut(data as Row) }, 201);
});

// ── PATCH /:id — STRICT company scope (a blind-id WHERE would let tenant A edit
//    tenant B's location by knowing its UUID).
savedLocations.patch('/:id', async (c) => {
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
  if (p.contactPhone !== undefined) updates.contact_phone = asPhone(p.contactPhone);
  if (p.address1 !== undefined)     updates.address1 = p.address1;
  if (p.address2 !== undefined)     updates.address2 = p.address2;
  if (p.city !== undefined)         updates.city = p.city;
  if (p.postcode !== undefined)     updates.postcode = p.postcode;
  if (p.state !== undefined)        updates.state = p.state;
  if (p.notes !== undefined)        updates.notes = p.notes;
  if (p.isActive !== undefined)     updates.is_active = p.isActive;
  if (Object.keys(updates).length === 0) return c.json({ error: 'no_changes' }, 400);

  const sb = c.get('supabase');
  /* An edit that touches the address must not blank it out — read the current row
     (company-scoped) and check the merged result still has a street line. */
  if (updates.address1 !== undefined || updates.address2 !== undefined) {
    const { data: cur, error: curErr } = await scopeToCompanyId(
      sb.from('saved_locations').select('address1, address2').eq('id', id),
      co.companyId,
    ).maybeSingle();
    if (curErr) return c.json({ error: 'load_failed', reason: curErr.message }, 500);
    if (cur) {
      const a1 = updates.address1 !== undefined ? (updates.address1 as string | null) : (cur as Row).address1;
      const a2 = updates.address2 !== undefined ? (updates.address2 as string | null) : (cur as Row).address2;
      if (!hasAddress(a1, a2)) return c.json(ADDRESS_REQUIRED, 400);
    }
  }

  updates.updated_by = user?.id ?? null;
  updates.updated_at = new Date().toISOString();

  const { data, error } = await scopeToCompanyId(
    sb.from('saved_locations').update(updates).eq('id', id),
    co.companyId,
  ).select(COLS).maybeSingle();
  if (error) {
    if (error.code === '23505') return c.json({ error: 'duplicate_name', reason: 'A saved location with that name already exists.' }, 409);
    return c.json({ error: 'update_failed', reason: error.message }, 500);
  }
  if (!data) return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ location: rowOut(data as Row) });
});

// ── DELETE /:id — STRICT company scope. A DP order that used this location keeps
//    its own snapshot (soft link), so removing a location never rewrites history.
savedLocations.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');

  const { data: deleted, error } = await scopeToCompanyId(
    sb.from('saved_locations').delete().eq('id', id),
    co.companyId,
  ).select('id').maybeSingle();
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  if (!deleted) return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ ok: true });
});

export default savedLocations;
