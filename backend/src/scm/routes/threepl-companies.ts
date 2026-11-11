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
//   GET    /      — list this tenant's 3PL companies (+ lorry counts and the
//                   linked supplier), sorted
//   POST   /      — create a 3PL company
//   PATCH  /:id   — patch a company (name, contact, active, notes, supplier)
//   DELETE /:id   — delete a company (its lorries are DETACHED, not deleted)
//
// A carrier is linked to the supplier it bills as in this company's supplier
// master (supplier_id, mig 20261024T1000; owner 2026-11-11: 「这里的 3pl
// supplier 其实是要 link with 我的 other supplier 的」). One supplier, at most one
// carrier: the AP-invoice reader (lib/threepl-bill-import.ts carrierFor) picks
// the carrier a supplier's bill belongs to by this link.
//
// Mounted at '/threepl-companies' in scm/index.ts, gated by
// scmAreaGuard('scm.transportation.drivers') — same area as the rest of TMS.
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { z } from 'zod';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { chunkIn, paginateAll } from '../lib/paginate-all';
import { normalizePhone } from '../shared/phone';
import { nextCode, CODE_PREFIX } from '../lib/fleet-code-mint';
import {
  scopeToCompany,
  scopeToCompanyId,
  requireActiveCompanyId,
  NOT_THIS_COMPANY,
} from '../lib/companyScope';

export const threeplCompanies = new Hono<{ Bindings: Env; Variables: Variables }>();
threeplCompanies.use('*', supabaseAuth);

const COLS = 'id, code, name, registration_no, contact_name, contact_phone, office_phone, email, address, is_active, notes, supplier_id, created_at, updated_at';

type Row = {
  id: string;
  code?: string | null;
  name?: string | null;
  registration_no?: string | null; registrationNo?: string | null;
  contact_name?: string | null;   contactName?: string | null;
  contact_phone?: string | null;  contactPhone?: string | null;
  office_phone?: string | null;   officePhone?: string | null;
  email?: string | null;
  address?: string | null;
  is_active?: boolean | null;     isActive?: boolean | null;
  notes?: string | null;
  supplier_id?: string | null;    supplierId?: string | null;
  created_at?: string | null;     createdAt?: string | null;
  updated_at?: string | null;     updatedAt?: string | null;
  lorry_count?: number | null;
};

type FleetCounts = { lorryCount: number; driverCount: number; helperCount: number };
const NO_FLEET: FleetCounts = { lorryCount: 0, driverCount: 0, helperCount: 0 };

/** The supplier-master entry a carrier bills as, as the drawer shows it. */
type SupplierRef = { id: string; code: string; name: string };
const SUPPLIER_COLS = 'id, code, name';

const supplierIdOf = (r: Row): string | null => {
  const v = r.supplierId ?? r.supplier_id;
  return v ? String(v) : null;
};

const supplierRefOf = (s: Record<string, unknown>): SupplierRef => ({
  id: String(s.id), code: String(s.code ?? ''), name: String(s.name ?? ''),
});

function rowOut(r: Row, counts: FleetCounts, supplier: SupplierRef | null) {
  return {
    id:             r.id,
    code:           r.code ?? null,
    name:           r.name ?? '',
    registrationNo: r.registrationNo ?? r.registration_no ?? null,
    contactName:    r.contactName ?? r.contact_name ?? null,
    contactPhone:   r.contactPhone ?? r.contact_phone ?? null,
    officePhone:    r.officePhone ?? r.office_phone ?? null,
    email:          r.email ?? null,
    address:        r.address ?? null,
    isActive:       (r.isActive ?? r.is_active ?? true) !== false,
    notes:          r.notes ?? null,
    supplier,
    ...counts,
    createdAt:      r.createdAt ?? r.created_at ?? null,
    updatedAt:      r.updatedAt ?? r.updated_at ?? null,
  };
}

/* The carrier-link column, whichever casing the pg driver hands back. */
const carrierIdOf = (r: Record<string, unknown>): string =>
  String((r.threeplCompanyId ?? r.threepl_company_id) ?? '');

type Sb = Variables['supabase'];
type LinkRefusal = { ok: false; status: 400 | 409 | 500; body: { error: string; reason: string } };

/** The supplier a carrier may be linked to: one in THIS company's supplier
 *  master that no other 3PL company of this company already bills as — two
 *  carriers on one supplier leave carrierFor() picking whichever it meets first.
 *  `carrierId` is the carrier being edited, null for one being created. */
async function supplierToLink(
  sb: Sb, companyId: number, supplierId: string, carrierId: string | null,
): Promise<{ ok: true; supplier: SupplierRef } | LinkRefusal> {
  const { data: sup, error: supErr } = await scopeToCompanyId(sb.from('suppliers').select(SUPPLIER_COLS), companyId)
    .eq('id', supplierId).maybeSingle();
  if (supErr) return { ok: false, status: 500, body: { error: 'load_failed', reason: supErr.message } };
  if (!sup) {
    return { ok: false, status: 400, body: { error: 'supplier_not_found', reason: 'That supplier is not in the supplier list of the company you are working in.' } };
  }
  let holders = scopeToCompanyId(sb.from('threepl_companies').select('id, name'), companyId).eq('supplier_id', supplierId);
  if (carrierId) holders = holders.neq('id', carrierId);
  const { data: held, error: heldErr } = await holders.limit(1);
  if (heldErr) return { ok: false, status: 500, body: { error: 'load_failed', reason: heldErr.message } };
  const holder = (held as Array<{ name?: string | null }>).at(0);
  if (holder) {
    const name = String(holder.name || 'another 3PL company').slice(0, 120);
    return { ok: false, status: 409, body: { error: 'supplier_linked_elsewhere', reason: `This supplier is already linked to ${name}. Unlink it there first.` } };
  }
  return { ok: true, supplier: supplierRefOf(sup as Record<string, unknown>) };
}

/** The supplier this carrier is linked to now, or null — read before a patch
 *  that leaves the link alone, so the reply can carry it without a read after
 *  the write (a failure there would report a saved change as not saved). */
async function currentSupplier(
  sb: Sb, companyId: number, carrierId: string,
): Promise<{ ok: true; supplier: SupplierRef | null } | { ok: false; reason: string }> {
  const { data: carrier, error: carrierErr } = await scopeToCompanyId(sb.from('threepl_companies').select('id, supplier_id'), companyId)
    .eq('id', carrierId).maybeSingle();
  if (carrierErr) return { ok: false, reason: carrierErr.message };
  const supplierId = carrier ? supplierIdOf(carrier as Row) : null;
  if (!supplierId) return { ok: true, supplier: null };
  const { data: sup, error: supErr } = await scopeToCompanyId(sb.from('suppliers').select(SUPPLIER_COLS), companyId)
    .eq('id', supplierId).maybeSingle();
  if (supErr) return { ok: false, reason: supErr.message };
  return { ok: true, supplier: sup ? supplierRefOf(sup as Record<string, unknown>) : null };
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

  // The supplier each carrier bills as, from this company's supplier master.
  const supplierIds = [...new Set(companies.map(supplierIdOf).filter((v): v is string => v !== null))];
  const suppliers = new Map<string, SupplierRef>();
  if (supplierIds.length > 0) {
    const sups = await chunkIn<Record<string, unknown>>(supplierIds, (batch, from, to) =>
      scopeToCompany(sb.from('suppliers').select(SUPPLIER_COLS), c).in('id', batch).order('id').range(from, to));
    if (sups.error) return c.json({ error: 'fetch_failed', reason: sups.error.message }, 500);
    for (const s of sups.data) suppliers.set(String(s.id), supplierRefOf(s));
  }
  return c.json({
    companies: companies.map((r) => rowOut(r, counts.get(r.id) ?? NO_FLEET, suppliers.get(supplierIdOf(r) ?? '') ?? null)),
  });
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

/* Owner, 2026-08-02: "我们填入的资料...应该都是 formatted 的". These were bare
   length caps, so `email` accepted "not an email" and both phones were stored
   byte-for-byte as typed — while the DRIVER phone in the same drawer was being
   reshaped to E.164. One form, two behaviours.

   PHONES ARE NORMALISED HERE, NOT MERELY CHECKED. A company office phone is a
   LANDLINE (03-xxxx xxxx), so the mobile-only isValidMalaysianPhone would have
   refused every legitimate one; normalizePhone reshapes both landline and
   mobile and returns null only for something that is not a number at all. */
const optionalPhone = (label: string) =>
  z.string().trim().max(40).nullable().optional().superRefine((v, ctx) => {
    if (v == null || v === '') return;
    if (!normalizePhone(v)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} is not a usable phone number.` });
  });

const companyFields = {
  name:         z.string().trim().min(1).max(120),
  contactName:  z.string().trim().max(120).nullable().optional(),
  contactPhone: optionalPhone('Contact phone'),
  registrationNo: z.string().trim().max(60).nullable().optional(),
  officePhone:  optionalPhone('Office phone'),
  /* Was max(160) and nothing else, so "ops at carrier dot com" saved happily. */
  email:        z.string().trim().max(160).email('That is not a valid email address.').nullable().optional()
                 .or(z.literal('').transform(() => null)),
  address:      z.string().trim().max(500).nullable().optional(),
  notes:        z.string().trim().max(2000).nullable().optional(),
  isActive:     z.boolean().optional(),
  /* The supplier this carrier bills as; null unlinks. */
  supplierId:   z.string().uuid().nullable().optional(),
};

const createSchema = z.object(companyFields);

/** Store the E.164 form, not what was typed — see the note above. */
const asPhone = (v: string | null | undefined): string | null => (v ? normalizePhone(v) : null);

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
  let supplier: SupplierRef | null = null;
  if (p.supplierId) {
    const link = await supplierToLink(sb, co.companyId, p.supplierId, null);
    if (!link.ok) return c.json(link.body, link.status);
    supplier = link.supplier;
  }
  const row = {
    company_id:    co.companyId,
    name:          p.name,
    registration_no: p.registrationNo ?? null,
    contact_name:  p.contactName ?? null,
    contact_phone: asPhone(p.contactPhone),
    office_phone:  asPhone(p.officePhone),
    email:         p.email ?? null,
    address:       p.address ?? null,
    notes:         p.notes ?? null,
    is_active:     p.isActive ?? true,
    supplier_id:   supplier?.id ?? null,
    created_by:    user?.id ?? null,
    updated_by:    user?.id ?? null,
  };

  /* Codes are minted per COMPANY here — unlike drivers/helpers, this table is
     company-scoped (UNIQUE (company_id, name), and 0242's index is on
     (company_id, code)). Retry the mint only; a duplicate NAME or SSM is the
     caller's problem and retrying would spin forever. */
  let data: unknown = null;
  let error: { code?: string; message?: string } | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const { data: existing } = await sb.from('threepl_companies').select('code').eq('company_id', co.companyId);
    const code = nextCode(CODE_PREFIX.THREEPL, ((existing ?? []) as Array<{ code?: string | null }>).map((r) => r.code));
    const res = await sb.from('threepl_companies').insert({ ...row, code }).select(COLS).single();
    data = res.data; error = res.error;
    if (!error) break;
    if (error.code !== '23505') break;
    if (!/threepl_companies_code/i.test(error.message ?? '')) break; // name / SSM clash — real, do not retry
  }
  if (error) {
    if (error.code === '23505') {
      const dupReg = /registration/i.test(error.message ?? '');
      return c.json(dupReg
        ? { error: 'duplicate_registration', reason: 'A 3PL company with that SSM registration number already exists.' }
        : { error: 'duplicate_name', reason: 'A 3PL company with that name already exists.' }, 409);
    }
    /* DEAD BRANCH -- here and at EVERY other 42501 site in this file. 42501 is
       Postgres permission-denied, i.e. RLS, and RLS cannot fire on this path: mig
       0061 enabled RLS on every scm table with NO policies, and the SCM client is
       the SERVICE-ROLE client (scm/middleware/auth.ts:93 -> db/supabase.ts
       getSupabaseService), which bypasses RLS by design. No scm function RAISEs
       42501 either -- the live tree's only ERRCODE is 22023. Do NOT read this as a
       permission check and do NOT treat it as scoping: the only boundary is this
       route's own predicate. (docs/audit-2026-08-13-ledger.md K1) */
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    return c.json({ error: 'insert_failed', reason: error.message }, 500);
  }
  return c.json({ company: rowOut(data as Row, NO_FLEET, supplier) }, 201);
});

/* The SAME rules as create, with the name optional. Sharing the field map is
   the point: a format enforced on create and not on edit is enforced nowhere,
   which is exactly how the driver phone ended up normalised on one path and
   stored raw on the other. `code` is deliberately absent — it is minted. */
const patchSchema = z.object({ ...companyFields, name: companyFields.name.optional() });

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
  if (p.contactPhone !== undefined) updates.contact_phone = asPhone(p.contactPhone);
  if (p.officePhone !== undefined)  updates.office_phone = asPhone(p.officePhone);
  if (p.email !== undefined)        updates.email = p.email;
  if (p.address !== undefined)      updates.address = p.address;
  if (p.notes !== undefined)        updates.notes = p.notes;
  if (p.isActive !== undefined)     updates.is_active = p.isActive;
  if (Object.keys(updates).length === 0 && p.supplierId === undefined) return c.json({ error: 'no_changes' }, 400);

  const sb = c.get('supabase');
  let supplier: SupplierRef | null = null;
  if (p.supplierId === undefined) {
    const now = await currentSupplier(sb, co.companyId, id);
    if (!now.ok) return c.json({ error: 'fetch_failed', reason: now.reason }, 500);
    supplier = now.supplier;
  } else if (p.supplierId !== null) {
    const link = await supplierToLink(sb, co.companyId, p.supplierId, id);
    if (!link.ok) return c.json(link.body, link.status);
    supplier = link.supplier;
  }
  if (p.supplierId !== undefined) updates.supplier_id = supplier?.id ?? null;
  updates.updated_by = user?.id ?? null;
  updates.updated_at = new Date().toISOString();

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
  return c.json({ company: rowOut(data as Row, NO_FLEET, supplier) });
});

// ── DELETE /:id — STRICT company scope. Its lorries are DETACHED (the FK is ON
//    DELETE SET NULL), never deleted — a carrier leaving should not erase lorry
//    history.
threeplCompanies.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');

  /* A company with a rate card is not deleted: the FK would null the card's
     carrier and leave a price list that belongs to nobody, shown as own fleet. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: cards, error: cardErr } = await scopeToCompanyId((sb as any).from('delivery_rate_cards').select('id'), co.companyId)
    .eq('carrier_company_id', id).limit(1);
  if (cardErr) return c.json({ error: 'load_failed', reason: cardErr.message }, 500);
  if ((cards ?? []).length > 0) {
    return c.json({ error: 'has_rate_card', message: 'This 3PL company has a rate card. Delete its rate card on Carriers & Rates first, or set the company inactive.' }, 409);
  }

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
