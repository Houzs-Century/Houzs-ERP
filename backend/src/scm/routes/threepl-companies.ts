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

const COLS = 'id, name, registration_no, contact_name, contact_phone, office_phone, email, address, is_active, notes, created_at, updated_at';

type Row = {
  id: string;
  name?: string | null;
  registration_no?: string | null; registrationNo?: string | null;
  contact_name?: string | null;   contactName?: string | null;
  contact_phone?: string | null;  contactPhone?: string | null;
  office_phone?: string | null;   officePhone?: string | null;
  email?: string | null;
  address?: string | null;
  is_active?: boolean | null;     isActive?: boolean | null;
  notes?: string | null;
  created_at?: string | null;     createdAt?: string | null;
  updated_at?: string | null;     updatedAt?: string | null;
  lorry_count?: number | null;
};

type FleetCounts = { lorryCount: number; driverCount: number; helperCount: number };
const NO_FLEET: FleetCounts = { lorryCount: 0, driverCount: 0, helperCount: 0 };

function rowOut(r: Row, counts: FleetCounts = NO_FLEET) {
  return {
    id:             r.id,
    name:           r.name ?? '',
    registrationNo: r.registrationNo ?? r.registration_no ?? null,
    contactName:    r.contactName ?? r.contact_name ?? null,
    contactPhone:   r.contactPhone ?? r.contact_phone ?? null,
    officePhone:    r.officePhone ?? r.office_phone ?? null,
    email:          r.email ?? null,
    address:        r.address ?? null,
    isActive:       (r.isActive ?? r.is_active ?? true) !== false,
    notes:          r.notes ?? null,
    ...counts,
    createdAt:      r.createdAt ?? r.created_at ?? null,
    updatedAt:      r.updatedAt ?? r.updated_at ?? null,
  };
}

/* The carrier-link column, whichever casing the pg driver hands back. */
const carrierIdOf = (r: Record<string, unknown>): string =>
  String((r.threeplCompanyId ?? r.threepl_company_id) ?? '');

// ── GET / — list this tenant's 3PL companies, with a per-company lorry count.
threeplCompanies.get('/', async (c) => {
  const sb = c.get('supabase');
  const { data, error } = await paginateAll<Row>((from, to) =>
    scopeToCompany(sb.from('threepl_companies').select(COLS), c)
      .order('name', { ascending: true }).range(from, to),
  );
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);
  const companies = data ?? [];

  // Fleet counts per company — lorries AND crew (mig 0237 linked drivers and
  // helpers the same way 0210 linked lorries). Three tolerant reads; a failing
  // one leaves that count at 0 rather than sinking the list.
  const counts = new Map<string, FleetCounts>();
  const bump = (id: string, key: keyof FleetCounts) => {
    if (!id) return;
    const cur = counts.get(id) ?? { ...NO_FLEET };
    cur[key] += 1;
    counts.set(id, cur);
  };
  if (companies.length > 0) {
    /* The fleet masters are UNIFIED (not company-scoped) but the carrier rows
       they point at are — so scoping the count read here keeps a tenant from
       counting another tenant's crew through a shared roster. */
    const [lorryRows, driverRows, helperRows] = await Promise.all([
      scopeToCompany(sb.from('lorries').select('threepl_company_id'), c).not('threepl_company_id', 'is', null),
      scopeToCompany(sb.from('drivers').select('threepl_company_id'), c).not('threepl_company_id', 'is', null),
      scopeToCompany(sb.from('helpers').select('threepl_company_id'), c).not('threepl_company_id', 'is', null),
    ]);
    for (const l of (lorryRows.data ?? []) as Array<Record<string, unknown>>) bump(carrierIdOf(l), 'lorryCount');
    for (const d of (driverRows.data ?? []) as Array<Record<string, unknown>>) bump(carrierIdOf(d), 'driverCount');
    for (const h of (helperRows.data ?? []) as Array<Record<string, unknown>>) bump(carrierIdOf(h), 'helperCount');
  }
  return c.json({ companies: companies.map((r) => rowOut(r, counts.get(r.id) ?? NO_FLEET)) });
});

// ── GET /:id/fleet — the carrier's own crew and lorries, for the company drawer.
//    Read-only: the rows are created and edited through /drivers, /helpers and
//    /lorries, which own the outsource rule (scm/lib/threepl-link.ts).
threeplCompanies.get('/:id/fleet', async (c) => {
  const id = c.req.param('id');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');

  const { data: company } = await scopeToCompanyId(
    sb.from('threepl_companies').select('id'), co.companyId,
  ).eq('id', id).maybeSingle();
  if (!company) return c.json(NOT_THIS_COMPANY, 404);

  const [drivers, helpers, lorries] = await Promise.all([
    sb.from('drivers').select('id, driver_code, name, phone, ic_number, active')
      .eq('threepl_company_id', id).order('driver_code'),
    sb.from('helpers').select('id, helper_code, name, contact, ic_number, active')
      .eq('threepl_company_id', id).order('helper_code'),
    sb.from('lorries').select('id, plate, type, capacity_m3, length_ft, width_ft, height_ft, active')
      .eq('threepl_company_id', id).order('plate'),
  ]);
  return c.json({
    drivers: drivers.data ?? [],
    helpers: helpers.data ?? [],
    lorries: lorries.data ?? [],
  });
});

const createSchema = z.object({
  name:         z.string().trim().min(1).max(120),
  contactName:  z.string().trim().max(120).nullable().optional(),
  contactPhone: z.string().trim().max(40).nullable().optional(),
  registrationNo: z.string().trim().max(60).nullable().optional(),
  officePhone:  z.string().trim().max(40).nullable().optional(),
  email:        z.string().trim().max(160).nullable().optional(),
  address:      z.string().trim().max(500).nullable().optional(),

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
    registration_no: p.registrationNo ?? null,
    contact_name:  p.contactName ?? null,
    contact_phone: p.contactPhone ?? null,
    office_phone:  p.officePhone ?? null,
    email:         p.email ?? null,
    address:       p.address ?? null,
    notes:         p.notes ?? null,
    is_active:     p.isActive ?? true,
    created_by:    user?.id ?? null,
    updated_by:    user?.id ?? null,
  }).select(COLS).single();
  if (error) {
    if (error.code === '23505') {
      const dupReg = /registration/i.test(error.message ?? '');
      return c.json(dupReg
        ? { error: 'duplicate_registration', reason: 'A 3PL company with that SSM registration number already exists.' }
        : { error: 'duplicate_name', reason: 'A 3PL company with that name already exists.' }, 409);
    }
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    return c.json({ error: 'insert_failed', reason: error.message }, 500);
  }
  return c.json({ company: rowOut(data as Row) }, 201);
});

const patchSchema = z.object({
  name:         z.string().trim().min(1).max(120).optional(),
  contactName:  z.string().trim().max(120).nullable().optional(),
  contactPhone: z.string().trim().max(40).nullable().optional(),
  registrationNo: z.string().trim().max(60).nullable().optional(),
  officePhone:  z.string().trim().max(40).nullable().optional(),
  email:        z.string().trim().max(160).nullable().optional(),
  address:      z.string().trim().max(500).nullable().optional(),

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
  if (p.registrationNo !== undefined) updates.registration_no = p.registrationNo;
  if (p.contactName !== undefined)  updates.contact_name = p.contactName;
  if (p.contactPhone !== undefined) updates.contact_phone = p.contactPhone;
  if (p.officePhone !== undefined)  updates.office_phone = p.officePhone;
  if (p.email !== undefined)        updates.email = p.email;
  if (p.address !== undefined)      updates.address = p.address;
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
    if (error.code === '23505') {
      const dupReg = /registration/i.test(error.message ?? '');
      return c.json(dupReg
        ? { error: 'duplicate_registration', reason: 'A 3PL company with that SSM registration number already exists.' }
        : { error: 'duplicate_name', reason: 'A 3PL company with that name already exists.' }, 409);
    }
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
