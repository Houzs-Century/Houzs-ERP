// ----------------------------------------------------------------------------
// /driver-leave — Fleet Module A3 admin for scm.driver_leave (mig 0206). The
// small master the dispatcher uses to record a driver's date-ranged absence so
// the A2 auto-assigner (delivery-zones sequence-assign) stops crewing them on
// those days. There is no structured HR leave source in this ERP, so this is it.
//
// Same Transportation area gate as the rest of the TMS fleet masters
// (scm.transportation.drivers) — mounted in scm/index.ts. Company-scoped writes;
// the read is scoped to the active company like the other per-company masters.
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { z } from 'zod';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { activeCompanyId } from '../lib/companyScope';

export const driverLeave = new Hono<{ Bindings: Env; Variables: Variables }>();
driverLeave.use('*', supabaseAuth);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const COLS = 'id, driver_id, start_date, end_date, reason, created_at';

// Leave is an INTERNAL-driver concept only: you do not track a 3PL's drivers'
// absences (scm.drivers.in_house = false). PURE guard over a driver lookup row —
// only a driver KNOWN to be external (in_house === false) is rejected; a missing
// flag defaults to in-house, matching the column's NOT NULL DEFAULT true.
export function isInHouseDriver(row: { in_house?: unknown } | null | undefined): boolean {
  if (!row) return false;
  return row.in_house !== false;
}

function rowOut(r: Record<string, unknown>) {
  return {
    id: String(r.id),
    driverId: String((r.driverId ?? r.driver_id) ?? ''),
    startDate: String((r.startDate ?? r.start_date) ?? '').slice(0, 10),
    endDate: String((r.endDate ?? r.end_date) ?? '').slice(0, 10),
    reason: (r.reason ?? null) as string | null,
    createdAt: (r.createdAt ?? r.created_at ?? null) as string | null,
  };
}

// GET /driver-leave?driverId=&from=&to= — the leave rows, optionally filtered to
// a driver and/or overlapping a [from, to] window.
driverLeave.get('/', async (c) => {
  const sb = c.get('supabase');
  const driverId = c.req.query('driverId');
  const from = c.req.query('from');
  const to = c.req.query('to');
  let q = sb.from('driver_leave').select(COLS)
    .eq('company_id', activeCompanyId(c))
    .order('start_date', { ascending: false });
  if (driverId) q = q.eq('driver_id', driverId);
  // Overlap: start_date <= to AND end_date >= from.
  if (to && ISO_DATE.test(to)) q = q.lte('start_date', to);
  if (from && ISO_DATE.test(from)) q = q.gte('end_date', from);
  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ leave: ((data ?? []) as Array<Record<string, unknown>>).map(rowOut) });
});

const createSchema = z.object({
  driverId: z.string().uuid(),
  startDate: z.string().regex(ISO_DATE),
  endDate: z.string().regex(ISO_DATE),
  reason: z.string().trim().max(500).nullable().optional(),
}).refine((v) => v.startDate <= v.endDate, { message: 'startDate must be on or before endDate', path: ['endDate'] });

// POST /driver-leave — record an absence.
driverLeave.post('/', async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const p = parsed.data;
  const user = c.get('user') as { id?: string } | null;

  const sb = c.get('supabase');

  // INTERNAL-only guard: leave records only make sense for own-fleet drivers.
  // Look the driver up (roster is company-unified like the /drivers read) and
  // reject an external/3PL driver with a clear 422 before writing.
  const { data: drv, error: drvErr } = await sb.from('drivers')
    .select('id, in_house').eq('id', p.driverId).maybeSingle();
  if (drvErr) return c.json({ error: 'driver_lookup_failed', reason: drvErr.message }, 500);
  if (!drv) return c.json({ error: 'driver_not_found' }, 404);
  if (!isInHouseDriver(drv as Record<string, unknown>)) {
    return c.json({
      error: 'external_driver',
      message: 'Leave is tracked for internal (in-house) drivers only. This driver is external / 3rd-party.',
    }, 422);
  }

  const { data, error } = await sb.from('driver_leave').insert({
    company_id: activeCompanyId(c),
    driver_id: p.driverId,
    start_date: p.startDate,
    end_date: p.endDate,
    reason: p.reason ?? null,
    created_by: user?.id ?? null,
  }).select(COLS).single();
  if (error) {
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    return c.json({ error: 'create_failed', reason: error.message }, 500);
  }
  return c.json({ leave: rowOut(data as Record<string, unknown>) }, 201);
});

// DELETE /driver-leave/:id — remove an absence (reversible: re-add it). STRICT
// company scope so one company cannot delete another's row.
driverLeave.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const sb = c.get('supabase');
  const { data: deleted, error } = await sb.from('driver_leave')
    .delete().eq('id', id).eq('company_id', activeCompanyId(c))
    .select('id').maybeSingle();
  if (error) {
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    return c.json({ error: 'delete_failed', reason: error.message }, 500);
  }
  if (!deleted) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true });
});

export default driverLeave;
