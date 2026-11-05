import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Camera } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { fmtSen, fmtDate, todayMY } from '../../../vendor/shared/format';
import { DateField } from '../../../vendor/scm/components/DateField';
import { SearchInput } from '../../../components/Button';
import { useDeliveryHistory } from '../../../vendor/scm/lib/fleet-day-queries';
import { groupHistoryByDay, historyPreset, addDays } from '../../../vendor/scm/lib/fleet-day-cards';
import { clockMY } from './vm';

const TH = ['Lorry', 'Driver', 'SO', 'DO', 'Customer', 'Slot', 'Done', 'Amount', 'POD'];

/** History tab (phase 3c): delivered orders over a date range, grouped by day,
 *  with presets, multi-select lorry chips and search. Date range is read-only
 *  past data; the max end is yesterday. */
export function HistoryTab() {
  const yesterday = useMemo(() => addDays(todayMY(), -1), []);
  const [range, setRange] = useState(() => historyPreset(7, todayMY()));
  const [selPlates, setSelPlates] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const q = useDeliveryHistory(range.from, range.to);
  const rows = q.data ?? [];
  const plates = useMemo(() => [...new Set(rows.map((r) => r.plate).filter((p): p is string => !!p))].sort(), [rows]);
  const searching = query.trim().length >= 2;
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (selPlates.size && (!r.plate || !selPlates.has(r.plate))) return false;
      if (needle.length >= 2 && ![r.customer, r.soDocNo, r.doNumber].some((v) => (v ?? '').toLowerCase().includes(needle))) return false;
      return true;
    });
  }, [rows, selPlates, query]);
  const days = useMemo(() => groupHistoryByDay(filtered), [filtered]);

  const togglePlate = (p: string) => setSelPlates((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; });
  const toggleDay = (day: string) => setCollapsed((s) => { const n = new Set(s); if (n.has(day)) n.delete(day); else n.add(day); return n; });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1 text-[12px] text-ink-secondary">From
          <DateField value={range.from} onChange={(iso) => { if (iso) setRange((r) => ({ ...r, from: iso })); }} className="rounded-md border border-border bg-surface px-2 py-1 text-[12.5px] text-ink" />
        </label>
        <label className="flex items-center gap-1 text-[12px] text-ink-secondary">To
          <DateField value={range.to} onChange={(iso) => { if (iso) setRange((r) => ({ ...r, to: iso <= yesterday ? iso : yesterday })); }} className="rounded-md border border-border bg-surface px-2 py-1 text-[12.5px] text-ink" />
        </label>
        {[7, 14, 30].map((d) => (
          <button key={d} type="button" onClick={() => setRange(historyPreset(d, todayMY()))} className="rounded-full border border-border px-2.5 py-1 text-[11.5px] text-ink-secondary hover:bg-surface-2">{d} days</button>
        ))}
        <span className="text-[11.5px] text-ink-muted">{filtered.length} delivered · {days.length} day{days.length === 1 ? '' : 's'}</span>
        <span className="flex-1" />
        <SearchInput value={query} onChange={setQuery} placeholder="Customer, SO / DO" widthClassName="w-full sm:w-[240px]" aria-label="Search history" />
      </div>

      {plates.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-ink-muted">Lorries:</span>
          <button type="button" onClick={() => setSelPlates(new Set())} className={cn('rounded-full border px-2.5 py-0.5 text-[11px]', selPlates.size === 0 ? 'border-primary bg-primary-soft text-primary' : 'border-border text-ink-secondary')}>All lorries</button>
          {plates.map((p) => (
            <button key={p} type="button" onClick={() => togglePlate(p)} className={cn('rounded-full border px-2.5 py-0.5 font-mono text-[11px]', selPlates.has(p) ? 'border-primary bg-primary-soft text-primary' : 'border-border text-ink-secondary')}>{p}</button>
          ))}
        </div>
      )}

      {q.isLoading ? (
        <p className="p-4 text-[13px] text-ink-muted">Loading history…</p>
      ) : q.error ? (
        <p className="rounded-md border border-err/40 bg-err-bg p-4 text-[13px] text-err">Could not load history. {q.error instanceof Error ? q.error.message : ''}</p>
      ) : days.length === 0 ? (
        <p className="rounded-md border border-border bg-surface p-6 text-center text-[12.5px] text-ink-muted">No deliveries in this range.</p>
      ) : (
        days.map((d) => {
          const isOpen = searching || !collapsed.has(d.day);
          return (
            <div key={d.day} className="overflow-hidden rounded-md border border-border bg-surface">
              <button type="button" onClick={() => toggleDay(d.day)} className="flex w-full flex-wrap items-center gap-2 bg-accent-soft/50 px-3 py-2 text-left text-[12.5px]">
                {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <span className="font-semibold text-ink">{fmtDate(d.day)}</span>
                <span className="text-ink-muted">{d.lorries} lorr{d.lorries === 1 ? 'y' : 'ies'} · {d.drops} drops · POD {d.podPct ?? 0}%</span>
                <span className="flex-1" />
                <span className="font-mono tabular-nums text-ink-secondary">{fmtSen(d.totalSen)}</span>
              </button>
              {isOpen && (
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse">
                    <thead className="border-b border-border bg-surface-2">
                      <tr>{TH.map((h) => <th key={h} className="px-2 py-1.5 text-left font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted">{h}</th>)}</tr>
                    </thead>
                    <tbody>
                      {d.rows.map((r, j) => (
                        <tr key={`${r.soDocNo ?? 'x'}-${r.doNumber ?? j}`} className="border-b border-border-subtle">
                          <td className="px-2 py-1.5 font-mono text-[12px]">{r.plate ?? '—'}</td>
                          <td className="px-2 py-1.5 text-[12.5px]">{r.driver ?? '—'}</td>
                          <td className="px-2 py-1.5 font-mono text-[12px]">{r.soDocNo ?? '—'}</td>
                          <td className="px-2 py-1.5 font-mono text-[12px]">{r.doNumber ?? '—'}</td>
                          <td className="px-2 py-1.5 text-[12.5px]">{r.customer ?? '—'}</td>
                          <td className="px-2 py-1.5 text-[12.5px]">{r.slot ?? '—'}</td>
                          <td className="px-2 py-1.5 text-[12px] text-synced">{clockMY(r.doneAt) ?? '—'}</td>
                          <td className="px-2 py-1.5 font-mono text-[12.5px] tabular-nums">{fmtSen(r.amountSen)}</td>
                          <td className="px-2 py-1.5">{r.hasPod ? <Camera size={13} strokeWidth={1.75} className="text-ink-muted" aria-label="POD photo" /> : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
