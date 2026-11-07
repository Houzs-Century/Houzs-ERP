/* /api/scm/lorry-routes: each lorry's day by road (owner 2026-11-08).
   POST /estimate  works out home -> stops in order -> home with Google once per run
                   (kept per lorry and day; asked again only when the stops change).
   GET  /          the kept figures for a date range, per lorry, for Last Mile, Lorry
                   Capacity and Fleet Health.
   Company scope: every read and write keys on the active company; the lorry master is
   the shared fleet, resolved by plate. */
import { Hono } from 'hono';
import { z } from 'zod';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { scopeToCompany, requireActiveCompanyId } from '../lib/companyScope';
import { normalizePlate } from '../lib/plate-normalize';
import { MAX_STOPS, roadRoute, stopKey } from '../lib/road-route';

export const lorryRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();
lorryRoutes.use('*', supabaseAuth);

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const point = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
const estimateSchema = z.object({
  date: z.string().regex(ISO),
  plate: z.string().trim().min(1).max(20),
  home: point,
  stops: z.array(point).min(1).max(MAX_STOPS),
});

const out = (r: Record<string, unknown>) => ({
  lorryId: String(r.lorry_id), date: String(r.route_date).slice(0, 10), distanceM: Number(r.distance_m), durationS: Number(r.duration_s),
  stopCount: Number(r.stop_count), polyline: (r.polyline as string | null) ?? null, computedAt: String(r.computed_at),
});

lorryRoutes.post('/estimate', async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = estimateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const p = parsed.data;
  const sb = c.get('supabase');

  // company-scope: the lorry master is one fleet shared by every company (see lorries.ts).
  const { data: lorries, error: lErr } = await sb.from('lorries').select('id, plate');
  if (lErr) return c.json({ error: 'load_failed', reason: lErr.message }, 500);
  const lorry = (lorries ?? []).find((l) => normalizePlate(String(l.plate)) === normalizePlate(p.plate));
  if (!lorry) return c.json({ error: 'lorry_not_found', reason: `No lorry ${p.plate}.` }, 404);

  const key = stopKey(p.home, p.stops);
  const { data: kept, error: kErr } = await scopeToCompany(sb.from('lorry_day_routes').select('*'), c)
    .eq('lorry_id', lorry.id).eq('route_date', p.date).maybeSingle();
  if (kErr) return c.json({ error: 'load_failed', reason: kErr.message }, 500);
  if (kept && kept.stop_key === key) return c.json({ route: out(kept as Record<string, unknown>), fresh: false });

  const road = await roadRoute(c.env, p.home, p.stops);
  if (!road.ok) return c.json({ error: 'route_failed', reason: road.reason }, 502);
  const row = {
    company_id: co.companyId, lorry_id: lorry.id, route_date: p.date, stop_key: key, stop_count: p.stops.length,
    distance_m: road.distanceM, duration_s: road.durationS, polyline: road.polyline, computed_at: new Date().toISOString(),
  };
  const { data: saved, error: sErr } = await sb.from('lorry_day_routes').upsert(row, { onConflict: 'company_id,lorry_id,route_date' }).select('*').single();
  if (sErr) return c.json({ error: 'save_failed', reason: sErr.message }, 500);
  return c.json({ route: out(saved as Record<string, unknown>), fresh: true });
});

lorryRoutes.get('/', async (c) => {
  const from = c.req.query('from') ?? '';
  const to = c.req.query('to') ?? '';
  if (!ISO.test(from) || !ISO.test(to)) return c.json({ error: 'invalid_range', reason: 'from and to must be YYYY-MM-DD' }, 400);
  const lorryId = c.req.query('lorryId');
  const sb = c.get('supabase');
  let q = scopeToCompany(sb.from('lorry_day_routes').select('lorry_id, route_date, distance_m, duration_s, stop_count, polyline, computed_at'), c)
    .gte('route_date', from).lte('route_date', to).order('route_date', { ascending: true });
  if (lorryId) q = q.eq('lorry_id', lorryId);
  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ routes: ((data ?? []) as Array<Record<string, unknown>>).map(out) });
});
