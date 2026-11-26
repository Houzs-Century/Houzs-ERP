import { scopeToAllowedCompanies, type CompanyScopeCtx } from './companyScope';

/** lat/lng null = delivered with no POD GPS (listed, not pinned). stopId: the planned trip stop, for distance from its address. */
export type Drop = { kind: 'do' | 'job'; ref: string; label: string; lat: number | null; lng: number | null; at: string; stopId: string | null };

type DoRow = { id: string; do_number: string | null; debtor_name: string | null; pod_lat: number | null; pod_lng: number | null; pod_located_at: string | null; delivered_at: string | null };
type JobRow = { source_type: string; source_id: string; leg: string; pod_lat: number | null; pod_lng: number | null; pod_located_at: string | null; completed_at: string | null };

/** Undelivered DOs and jobs without coordinates are skipped; result is in time order. PURE. */
export function shapeDrops(dos: DoRow[], jobs: JobRow[], stopByDo: Map<string, string>): Drop[] {
  const out: Drop[] = [];
  for (const d of dos) {
    const at = d.pod_located_at ?? d.delivered_at;
    if (!at) continue;
    const gps = d.pod_lat != null && d.pod_lng != null;
    out.push({ kind: 'do', ref: d.id, label: [d.do_number, d.debtor_name].filter(Boolean).join(' - ') || 'Delivery', lat: gps ? d.pod_lat : null, lng: gps ? d.pod_lng : null, at, stopId: stopByDo.get(d.id) ?? null });
  }
  for (const j of jobs) {
    const at = j.pod_located_at ?? j.completed_at;
    if (j.pod_lat == null || j.pod_lng == null || !at) continue;
    out.push({ kind: 'job', ref: `${j.source_type}:${j.source_id}:${j.leg}`, label: `${j.leg} ${j.source_id}`, lat: j.pod_lat, lng: j.pod_lng, at, stopId: null });
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export async function loadDrops(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- scm-scoped supabase-js client
  sb: any,
  c: CompanyScopeCtx,
  lorryId: string,
  date: string,
): Promise<{ drops: Drop[]; error: string | null }> {
  const { data: trips, error: tErr } = await scopeToAllowedCompanies(
    sb.from('trips').select('id').eq('lorry_id', lorryId).eq('trip_date', date).neq('status', 'CANCELLED'), c);
  if (tErr) return { drops: [], error: tErr.message };
  const tripIds = (trips ?? []).map((t: { id: string }) => t.id);
  if (!tripIds.length) return { drops: [], error: null };
  const [stops, jobs] = await Promise.all([
    scopeToAllowedCompanies(sb.from('trip_stops').select('id, do_id').in('trip_id', tripIds).not('do_id', 'is', null), c),
    scopeToAllowedCompanies(
      sb.from('job_progress').select('source_type, source_id, leg, pod_lat, pod_lng, pod_located_at, completed_at')
        .in('trip_id', tripIds).not('completed_at', 'is', null).not('pod_lat', 'is', null), c),
  ]);
  if (stops.error) return { drops: [], error: stops.error.message };
  if (jobs.error) return { drops: [], error: jobs.error.message };
  const stopByDo = new Map<string, string>((stops.data ?? []).map((s: { id: string; do_id: string }) => [s.do_id, s.id]));
  const doIds = [...stopByDo.keys()];
  let dos: DoRow[] = [];
  if (doIds.length) {
    const r = await scopeToAllowedCompanies(
      sb.from('delivery_orders').select('id, do_number, debtor_name, pod_lat, pod_lng, pod_located_at, delivered_at').in('id', doIds), c);
    if (r.error) return { drops: [], error: r.error.message };
    dos = r.data ?? [];
  }
  return { drops: shapeDrops(dos, jobs.data ?? [], stopByDo), error: null };
}
