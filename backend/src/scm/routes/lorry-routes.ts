/* /api/scm/lorry-routes: each lorry's day by road (owner 2026-11-08), worked out ONCE on
   the server (scm/lib/lorry-day-runs.ts) and read by every page.
   POST /day   works out the day's runs now and returns them (Last Mile opens a day with it;
               the nightly cron does the same for the days just gone). Google is asked
               only for a run that changed.
   GET  /      the kept figures for a date range, for Lorry Capacity, Fleet Health and the
               lorry record.
   company-scope: the lorry fleet is one shared master across companies and a lorry's day
   is one physical run (see lorry-day-runs.ts), so the figures are the fleet's, read whole
   like GET /lorries. */
import { Hono } from 'hono';
import { z } from 'zod';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { computeDayRoutes } from '../lib/lorry-day-runs';

export const lorryRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();
lorryRoutes.use('*', supabaseAuth);

const ISO = /^\d{4}-\d{2}-\d{2}$/;

const out = (r: Record<string, unknown>) => ({
  lorryId: String(r.lorry_id), date: String(r.route_date).slice(0, 10), distanceM: Number(r.distance_m), durationS: Number(r.duration_s),
  stopCount: Number(r.stop_count), polyline: (r.polyline as string | null) ?? null, computedAt: String(r.computed_at),
});
const COLS = 'lorry_id, route_date, distance_m, duration_s, stop_count, polyline, computed_at';

lorryRoutes.post('/day', async (c) => { // company-scope: the shared fleet's runs, see the header
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = z.object({ date: z.string().regex(ISO) }).safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const { date } = parsed.data;
  const sb = c.get('supabase');
  let outcomes;
  try { outcomes = await computeDayRoutes(sb, c.env, date); } catch (e) {
    return c.json({ error: 'route_failed', reason: String((e as Error).message) }, 500);
  }
  const { data, error } = await sb.from('lorry_day_routes').select(COLS).eq('route_date', date);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ date, routes: (data as Array<Record<string, unknown>>).map(out), outcomes });
});

lorryRoutes.get('/', async (c) => { // company-scope: the shared fleet's runs, see the header
  const from = c.req.query('from') ?? '';
  const to = c.req.query('to') ?? '';
  if (!ISO.test(from) || !ISO.test(to)) return c.json({ error: 'invalid_range', reason: 'from and to must be YYYY-MM-DD' }, 400);
  const lorryId = c.req.query('lorryId');
  const sb = c.get('supabase');
  let q = sb.from('lorry_day_routes').select(COLS).gte('route_date', from).lte('route_date', to).order('route_date', { ascending: true });
  if (lorryId) q = q.eq('lorry_id', lorryId);
  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ routes: (data as Array<Record<string, unknown>>).map(out) });
});
