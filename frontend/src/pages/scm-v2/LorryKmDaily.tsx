// Km per lorry per Malaysia day from the GPS trackers (GET /lorries/km-daily).
// Blank cell = no fixes that day. Each cell opens that lorry's page on that day.
import { Link, useSearchParams } from 'react-router-dom';
import { todayMY } from '../../vendor/shared/format';
import { useLorryKmDaily } from '../../vendor/scm/lib/lorries-queries';

const DATE_INPUT = 'h-[34px] rounded-lg border border-border bg-surface px-2 text-[13px] text-ink';

export function LorryKmDaily() {
  const [params, setParams] = useSearchParams();
  const today = todayMY();
  const to = params.get('kmTo') ?? today;
  const from = params.get('kmFrom') ?? new Date(Date.parse(`${today}T00:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10);
  const set = (key: string, v: string) => setParams((p) => { const n = new URLSearchParams(p); if (v) n.set(key, v); else n.delete(key); return n; }, { replace: true });
  const q = useLorryKmDaily(from, to);
  const days = q.data?.days ?? [];

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-[14px] font-semibold text-ink">Km per day</h3>
        <label className="flex items-center gap-1.5 text-[12px] text-ink-muted">From
          <input type="date" className={DATE_INPUT} value={from} max={to} onChange={(e) => set('kmFrom', e.target.value)} />
        </label>
        <label className="flex items-center gap-1.5 text-[12px] text-ink-muted">To
          <input type="date" className={DATE_INPUT} value={to} min={from} max={today} onChange={(e) => set('kmTo', e.target.value)} />
        </label>
      </div>
      {q.isLoading ? (
        <p className="text-[13px] text-ink-muted">Loading km…</p>
      ) : q.isError ? (
        <p role="alert" className="text-[13px] text-red-600 dark:text-red-300">Could not load km per day. {q.error instanceof Error ? q.error.message : ''}</p>
      ) : q.data && q.data.lorries.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border bg-surface-dim px-4 py-4 text-center text-[13px] text-ink-muted">No GPS fixes in this range.</p>
      ) : (
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
              {(q.data?.lorries ?? []).map((l) => (
                <tr key={l.id} className="border-t border-border">
                  <td className="px-3 py-2 font-semibold text-ink">{l.plate}</td>
                  {l.km.map((k, i) => (
                    <td key={days[i]} className="px-3 py-2 text-right tabular-nums">
                      {k == null ? '' : <Link className="text-accent underline-offset-2 hover:underline" to={`/fleet-health/${l.id}?day=${days[i]}`}>{k.toFixed(1)}</Link>}
                    </td>
                  ))}
                  <td className="px-3 py-2 text-right font-semibold tabular-nums">{l.km.reduce<number>((a, k) => a + (k ?? 0), 0).toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
