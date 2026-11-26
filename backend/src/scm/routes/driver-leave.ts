/* company-scope-file: these reads are DELIBERATE. migs 0202/0203/0204 state
   `company_id` on the fleet tables is "STAMPED on insert for provenance but NOT
   used to scope reads" - a lorry is one physical vehicle whichever book paid for
   it, and a company predicate here would HIDE it from the people responsible.
   Not a waiver, a signal separator: 13 of ~20 findings were these every run.
   If the fleet ever needs per-company reads, delete this header and let the
   checker fail. docs/MASTER-DATA-SCOPE-RULE.md. */

import { Hono } from 'hono';
import { z } from 'zod';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { activeCompanyId } from '../lib/companyScope';

export const driverLeave = new Hono<{ Bindings: Env; Variables: Variables }>();
driverLeave.use('*', supabaseAuth);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const COLS = 'id, driver_id, helper_id, start_date, end_date, reason, created_at';

export function isInHouseDriver(row: { in_house?: unknown } | null | undefined): boolean {
  if (!row) return false;
  return row.in_house !== false;
}

function rowOut(r: Record<string, unknown>) {
  const driverId = (r.driverId ?? r.driver_id) ?? null;
  const helperId = (r.helperId ?? r.helper_id) ?? null;
  return {
    id: String(r.id),
    driverId: driverId != null ? String(driverId) : null,
    helperId: helperId != null ? String(helperId) : null,
    startDate: String((r.startDate ?? r.start_date) ?? '').slice(0, 10),
    endDate: String((r.endDate ?? r.end_date) ?? '').slice(0, 10),
    reason: (r.reason ?? null) as string | null,
    createdAt: (r.createdAt ?? r.created_at ?? null) as string | null,
  };
}

driverLeave.get('/', async (c) => {
  const sb = c.get('supabase');
  const driverId = c.req.query('driverId');
  const helperId = c.req.query('helperId');
  const from = c.req.query('from');
  const to = c.req.query('to');
  let q = sb.from('driver_leave').select(COLS)
    .eq('company_id', activeCompanyId(c))
    .order('start_date', { ascending: false });
  if (driverId) q = q.eq('driver_id', driverId);
  if (helperId) q = q.eq('helper_id', helperId);
  if (to && ISO_DATE.test(to)) q = q.lte('start_date', to);
  if (from && ISO_DATE.test(from)) q = q.gte('end_date', from);
  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ leave: ((data ?? []) as Array<Record<string, unknown>>).map(rowOut) });
});

const createSchema = z.object({
  driverId: z.string().uuid().optional(),
  helperId: z.string().uuid().optional(),
  startDate: z.string().regex(ISO_DATE),
  endDate: z.string().regex(ISO_DATE),
  reason: z.string().trim().max(500).nullable().optional(),
})
  .refine((v) => v.startDate <= v.endDate, { message: 'startDate must be on or before endDate', path: ['endDate'] })
  .refine((v) => (v.driverId ? 1 : 0) + (v.helperId ? 1 : 0) === 1, {
    message: 'Provide exactly one of driverId or helperId', path: ['driverId'],
  });

driverLeave.post('/', async (c) => {
  // company-scope: the driver/helper lookups read the UNIFIED roster (drivers.ts / helpers.ts "every company's TMS page shows the same drivers"); the leave row itself is stamped with the active company and its list/delete are company-scoped.
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const p = parsed.data;
  const user = c.get('user') as { id?: string } | null;

  const sb = c.get('supabase');

  if (p.driverId) {
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
  } else {
    const { data: hlp, error: hErr } = await sb.from('helpers')
      .select('id').eq('id', p.helperId!).maybeSingle();
    if (hErr) return c.json({ error: 'helper_lookup_failed', reason: hErr.message }, 500);
    if (!hlp) return c.json({ error: 'helper_not_found' }, 404);
  }

  const { data, error } = await sb.from('driver_leave').insert({
    company_id: activeCompanyId(c),
    driver_id: p.driverId ?? null,
    helper_id: p.helperId ?? null,
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
