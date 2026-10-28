// ----------------------------------------------------------------------------
// /delivery-residence-rules — CONFIG for the TMS scheduler's per-residence
// delivery rules (migration 0196). Owner-maintained: each residence / building
// type (Condo / Landed / Apartment / Office / Shop / Other — the SO's
// building_type UDF values) carries a service duration (minutes to unload +
// carry up) and optional delivery-access rules (no-delivery time windows,
// service-lift booking, gated-community registration).
//
// The Phase 3 scheduler will READ this table (service duration + access windows
// per residence type). This router is the config + CRUD only; nothing here wires
// a scheduler.
//
// Per-company scoped exactly like /delivery-planning-regions: scopeToCompany on
// reads, scopeToCompanyId on writes, stamp the active company on INSERT. The
// natural key is (company_id, building_type) (migration 0196).
//
// Endpoints:
//   GET    /            — list this company's rules (active + inactive, sorted)
//   POST   /            — create a rule for a custom building_type
//   PATCH  /:id         — patch a rule (duration, windows, flags, notes, active)
//   DELETE /:id         — delete a rule (for a custom type the owner added)
//
// Mounted at '/delivery-residence-rules' in scm/index.ts, gated by
// scmAreaGuard('scm.transportation.drivers') — same area as the rest of TMS.
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { z } from 'zod';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { paginateAll } from '../lib/paginate-all';
import {
  activeCompanyId,
  scopeToCompany,
  scopeToCompanyId,
  requireActiveCompanyId,
  NOT_THIS_COMPANY,
} from '../lib/companyScope';

export const deliveryResidenceRules = new Hono<{ Bindings: Env; Variables: Variables }>();
deliveryResidenceRules.use('*', supabaseAuth);

const RULE_COLS = 'id, building_type, service_duration_minutes, earliest_delivery_time, latest_delivery_time, requires_lift_booking, requires_registration, notes, is_active, created_at, updated_at';

/* Shape a rule row out (dual-read camelCase — the pg/PostgREST layer may surface
   either snake_case or camelCase depending on the path). */
type RuleRow = {
  id: string;
  building_type?: string | null;               buildingType?: string | null;
  service_duration_minutes?: number | null;    serviceDurationMinutes?: number | null;
  earliest_delivery_time?: string | null;       earliestDeliveryTime?: string | null;
  latest_delivery_time?: string | null;         latestDeliveryTime?: string | null;
  requires_lift_booking?: boolean | null;       requiresLiftBooking?: boolean | null;
  requires_registration?: boolean | null;       requiresRegistration?: boolean | null;
  notes?: string | null;
  is_active?: boolean | null;                   isActive?: boolean | null;
  created_at?: string | null;                   createdAt?: string | null;
  updated_at?: string | null;                   updatedAt?: string | null;
};

/** Normalise a TIME value to HH:MM (Postgres returns HH:MM:SS). null stays null. */
function timeOut(v: string | null | undefined): string | null {
  if (v == null || v === '') return null;
  const m = /^(\d{2}):(\d{2})/.exec(String(v));
  return m ? `${m[1]}:${m[2]}` : String(v);
}

function ruleOut(r: RuleRow) {
  return {
    id:                     r.id,
    buildingType:           r.buildingType ?? r.building_type ?? '',
    serviceDurationMinutes: Number(r.serviceDurationMinutes ?? r.service_duration_minutes ?? 0),
    earliestDeliveryTime:   timeOut(r.earliestDeliveryTime ?? r.earliest_delivery_time),
    latestDeliveryTime:     timeOut(r.latestDeliveryTime ?? r.latest_delivery_time),
    requiresLiftBooking:    (r.requiresLiftBooking ?? r.requires_lift_booking ?? false) === true,
    requiresRegistration:   (r.requiresRegistration ?? r.requires_registration ?? false) === true,
    notes:                  r.notes ?? null,
    isActive:               (r.isActive ?? r.is_active ?? true) !== false,
    createdAt:              r.createdAt ?? r.created_at ?? null,
    updatedAt:              r.updatedAt ?? r.updated_at ?? null,
  };
}

// A HH:MM (24h) time string, or null to clear. Accepts HH:MM or HH:MM:SS.
const timeField = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Time must be HH:MM (24-hour)')
  .nullable();

// ── GET / — list this company's residence rules, sorted by building_type.
deliveryResidenceRules.get('/', async (c) => {
  const sb = c.get('supabase');
  const { data, error } = await paginateAll<RuleRow>((from, to) =>
    scopeToCompany(
      sb.from('delivery_residence_rules').select(RULE_COLS),
      c,
    ).order('building_type', { ascending: true }).range(from, to),
  );
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);
  return c.json({ rules: (data ?? []).map(ruleOut) });
});

const ruleCreateSchema = z.object({
  buildingType:           z.string().trim().min(1).max(60),
  serviceDurationMinutes: z.number().int().min(0).max(24 * 60).optional(),
  earliestDeliveryTime:   timeField.optional(),
  latestDeliveryTime:     timeField.optional(),
  requiresLiftBooking:    z.boolean().optional(),
  requiresRegistration:   z.boolean().optional(),
  notes:                  z.string().trim().max(2000).nullable().optional(),
  isActive:               z.boolean().optional(),
});

// ── POST / — create a rule for a custom building_type. (company_id, building_type)
//    is UNIQUE per company (migration 0196), so a duplicate type is a 409.
deliveryResidenceRules.post('/', async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = ruleCreateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const p = parsed.data;
  const user = c.get('user') as { id?: string } | null;

  const sb = c.get('supabase');
  const { data, error } = await sb.from('delivery_residence_rules').insert({
    company_id:               co.companyId,
    building_type:            p.buildingType,
    service_duration_minutes: p.serviceDurationMinutes ?? 90,
    earliest_delivery_time:   p.earliestDeliveryTime ?? null,
    latest_delivery_time:     p.latestDeliveryTime ?? null,
    requires_lift_booking:    p.requiresLiftBooking ?? false,
    requires_registration:    p.requiresRegistration ?? false,
    notes:                    p.notes ?? null,
    is_active:                p.isActive ?? true,
    created_by:               user?.id ?? null,
    updated_by:               user?.id ?? null,
  }).select(RULE_COLS).single();
  if (error) {
    if (error.code === '23505') return c.json({ error: 'duplicate_type', reason: 'A rule for that residence type already exists.' }, 409);
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
  return c.json({ rule: ruleOut(data as RuleRow) }, 201);
});

const rulePatchSchema = z.object({
  buildingType:           z.string().trim().min(1).max(60).optional(),
  serviceDurationMinutes: z.number().int().min(0).max(24 * 60).optional(),
  earliestDeliveryTime:   timeField.optional(),
  latestDeliveryTime:     timeField.optional(),
  requiresLiftBooking:    z.boolean().optional(),
  requiresRegistration:   z.boolean().optional(),
  notes:                  z.string().trim().max(2000).nullable().optional(),
  isActive:               z.boolean().optional(),
});

// ── PATCH /:id — patch a rule. STRICT company scope (a blind-id WHERE would let
//    a caller in company A edit company B's rule by knowing its UUID).
deliveryResidenceRules.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = rulePatchSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const p = parsed.data;
  const user = c.get('user') as { id?: string } | null;

  const updates: Record<string, unknown> = {};
  if (p.buildingType !== undefined)           updates.building_type = p.buildingType;
  if (p.serviceDurationMinutes !== undefined) updates.service_duration_minutes = p.serviceDurationMinutes;
  if (p.earliestDeliveryTime !== undefined)   updates.earliest_delivery_time = p.earliestDeliveryTime;
  if (p.latestDeliveryTime !== undefined)     updates.latest_delivery_time = p.latestDeliveryTime;
  if (p.requiresLiftBooking !== undefined)    updates.requires_lift_booking = p.requiresLiftBooking;
  if (p.requiresRegistration !== undefined)   updates.requires_registration = p.requiresRegistration;
  if (p.notes !== undefined)                  updates.notes = p.notes;
  if (p.isActive !== undefined)               updates.is_active = p.isActive;
  if (Object.keys(updates).length === 0) return c.json({ error: 'no_changes' }, 400);
  updates.updated_by = user?.id ?? null;
  updates.updated_at = new Date().toISOString();

  const sb = c.get('supabase');
  const { data, error } = await scopeToCompanyId(
    sb.from('delivery_residence_rules').update(updates).eq('id', id),
    co.companyId,
  ).select(RULE_COLS).maybeSingle();
  if (error) {
    if (error.code === '23505') return c.json({ error: 'duplicate_type', reason: 'A rule for that residence type already exists.' }, 409);
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    return c.json({ error: 'update_failed', reason: error.message }, 500);
  }
  if (!data) return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ rule: ruleOut(data as RuleRow) });
});

// ── DELETE /:id — delete a rule (a custom residence type the owner added).
//    STRICT company scope. No in-use guard: nothing references this table by FK
//    yet (the scheduler will READ it, not link to it), so a delete is safe.
deliveryResidenceRules.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');

  const { data: deleted, error } = await scopeToCompanyId(
    sb.from('delivery_residence_rules').delete().eq('id', id),
    co.companyId,
  ).select('id').maybeSingle();
  if (error) {
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    return c.json({ error: 'delete_failed', reason: error.message }, 500);
  }
  if (!deleted) return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ ok: true });
});
