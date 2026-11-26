import { Link, useSearchParams } from 'react-router-dom';
import { fmtSen, todayMY } from '../../../../shared/src/vendor/shared/format';
import { useLorries, useLorryKmDaily } from '../../vendor/scm/lib/lorries-queries';
import { fmtKm, useRoadFigures } from '../../vendor/scm/lib/lorry-routes-queries';
import { DateField } from '../../vendor/scm/components/DateField';

function Sub({ odoKm, googleM, costSen }: { odoKm: number | null; googleM: number | null; costSen: number | null }) {
  const parts = [
    odoKm != null && <span key="o" title="Odometer km, from the iTrack device">O {odoKm.toFixed(1)}</span>,
    googleM != null && <span key="g" title="Google km, from its warehouse and back">G {fmtKm(googleM)}</span>,
    costSen != null && <span key="c">{fmtSen(costSen)}</span>,
  ].filter(Boolean);
  if (!parts.length) return null;
  return <span className="block space-x-1.5 text-[11px] text-ink-muted">{parts}</span>;
}

export function LorryKmDaily() {
  const [params, setParams] = useSearchParams();
  const today = todayMY();
  const to = params.get('kmTo') ?? today;
  const from = params.get('kmFrom') ?? new Date(Date.parse(`${today}T00:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10);
  const set = (key: string, v: string) => setParams((p) => { const n = new URLSearchParams(p); if (v) n.set(key, v); else n.delete(key); return n; }, { replace: true });
  const q = useLorryKmDaily(from, to);
  const road = useRoadFigures(from, to, null);
  const lorries = useLorries();
  const days = q.data?.days ?? [];
  const googleM = new Map((road.data ?? []).map((r) => [`${r.lorryId}|${r.date}`, r.distanceM]));
  const rate = new Map((lorries.data ?? []).map((l) => [l.id, l.cost_per_km_sen ?? null]));
  const cost = (id: string, km: number | null) => {
    const r = rate.get(id);
    return km == null || r == null ? null : Math.round(km * r);
  };

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-[14px] font-semibold text-ink">Km per day</h3>
        <label className="flex items-center gap-1.5 text-[12px] text-ink-muted">From
          <DateField aria-label="From" value={from} max={to} onChange={(v) => set('kmFrom', v)} />
        </label>
        <label className="flex items-center gap-1.5 text-[12px] text-ink-muted">To
          <DateField aria-label="To" value={to} min={from} max={today} onChange={(v) => set('kmTo', v)} />
        </label>
      </div>
      {q.isLoading ? (
        <p className="text-[13px] text-ink-muted">Loading km…</p>
      ) : q.isError ? (
        <p role="alert" className="text-[13px] text-red-600 dark:text-red-300">Could not load km per day. {q.error instanceof Error ? q.error.message : ''}</p>
      ) : q.data && q.data.lorries.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border bg-surface-dim px-4 py-4 text-center text-[13px] text-ink-muted">No GPS fixes in this range.</p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-[13px]">
              <thead className="bg-surface-dim text-left text-[11px] uppercase tracking-wide text-ink-muted">
                <tr>
                  <th className="px-3 py-2">Lorry</th>
                  {days.map((d) => <th key={d} className="px-3 py-2 text-right tabular-nums">{d.slice(5)}</th>)}
                  <th className="px-3 py-2 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {(q.data?.lorries ?? []).map((l) => {
                  const gpsKm = l.km.reduce<number>((a, k) => a + (k ?? 0), 0);
                  const g = days.map((d) => googleM.get(`${l.id}|${d}`) ?? null);
                  const gTotal = g.some((m) => m != null) ? g.reduce<number>((a, m) => a + (m ?? 0), 0) : null;
                  const oTotal = l.odoKm.some((k) => k != null) ? l.odoKm.reduce<number>((a, k) => a + (k ?? 0), 0) : null;
                  return (
                    <tr key={l.id} className="border-t border-border align-top">
                      <td className="px-3 py-2 font-semibold text-ink">{l.plate}</td>
                      {l.km.map((k, i) => (
                        <td key={days[i]} className="px-3 py-2 text-right tabular-nums">
                          {k != null && <Link className="text-accent underline-offset-2 hover:underline" to={`/fleet-health/${l.id}?day=${days[i]}`}>{k.toFixed(1)}</Link>}
                          <Sub odoKm={l.odoKm[i] ?? null} googleM={g[i] ?? null} costSen={cost(l.id, k)} />
                        </td>
                      ))}
                      <td className="px-3 py-2 text-right font-semibold tabular-nums">
                        {gpsKm.toFixed(1)}
                        <Sub odoKm={oTotal} googleM={gTotal} costSen={cost(l.id, gpsKm)} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-[12px] text-ink-muted">
            Top: km by GPS. O: km by the lorry's own odometer (iTrack lorries only). G: Google km for the planned run, warehouse and back.{' '}
            RM: GPS km times the lorry's RM/km (set in Vehicle details).
            {road.isError && ' Google km could not load.'}
            {lorries.isError && ' RM/km could not load.'}
          </p>
        </>
      )}
    </section>
  );
}
