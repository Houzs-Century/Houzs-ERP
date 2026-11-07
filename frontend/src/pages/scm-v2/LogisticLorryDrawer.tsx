// What one lorry did, day by day and newest first: every job on it, not only its
// delivery orders. A job type filter and a search narrow it.
import { useMemo, useState } from "react";
import { fmtSen } from "../../vendor/shared/format";
import { ResizableDrawer } from "../../components/ResizableDrawer";
import { Th, Td } from "../../components/scm-v2/OverviewKit";

export type LorryWorkRow = { key: string; date: string; type: string; ref: string; customer: string; region: string; amountSen: number; onOpen: (() => void) | null };

/** Newest day first; inside a day, deliveries before the rest. */
export function workByDay(rows: readonly LorryWorkRow[]): Array<{ date: string; rows: LorryWorkRow[] }> {
  const days = new Map<string, LorryWorkRow[]>();
  for (const r of rows) days.set(r.date, [...(days.get(r.date) ?? []), r]);
  return [...days.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, list]) => ({ date, rows: [...list].sort((a, b) => Number(b.type === "Delivery") - Number(a.type === "Delivery") || a.type.localeCompare(b.type)) }));
}

export function LogisticLorryDrawer({ plate, subtitle, rows, onClose }: { plate: string; subtitle: string; rows: LorryWorkRow[]; onClose: () => void }) {
  const [type, setType] = useState("");
  const [q, setQ] = useState("");
  const types = useMemo(() => [...new Set(rows.map((r) => r.type))].sort(), [rows]);
  const s = q.trim().toLowerCase();
  const shown = rows.filter((r) => (!type || r.type === type) && (!s || `${r.ref} ${r.customer} ${r.region} ${r.date}`.toLowerCase().includes(s)));
  const days = workByDay(shown);
  return (
    <ResizableDrawer onClose={onClose} title={`${plate} · every job`} subtitle={`${subtitle} · ${shown.length} of ${rows.length} jobs`} storageKey="overview-drill-width" defaultWidth={820} ariaLabel={`${plate} jobs`}>
      <div className="p-3">
        <div className="mb-2 flex flex-wrap gap-2">
          <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Job type" className="min-h-[40px] rounded-md border border-border bg-surface px-2 text-[12.5px] text-ink">
            <option value="">All job types</option>
            {types.map((t) => <option key={t} value={t}>{t} · {rows.filter((r) => r.type === t).length}</option>)}
          </select>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search these rows" aria-label="Search these rows" className="min-h-[40px] min-w-0 flex-1 rounded-md border border-border bg-surface px-3 text-[12.5px] text-ink" />
        </div>
        {days.length === 0 && <p className="text-[12.5px] text-ink-muted">No job on this lorry here.</p>}
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead><tr><Th left>Job type</Th><Th left>Ref</Th><Th left>Customer</Th><Th left>Region</Th><Th>Amount</Th></tr></thead>
            {days.map((d) => (
              <tbody key={d.date}>
                <tr className="bg-surface-2"><td colSpan={5} className="border-b border-border px-2.5 py-1.5 text-[12px] font-semibold text-ink">{d.date} · {d.rows.length} {d.rows.length === 1 ? "job" : "jobs"} · {fmtSen(d.rows.reduce((a, r) => a + r.amountSen, 0))}</td></tr>
                {d.rows.map((r) => (
                  <tr key={r.key} className={r.onOpen ? "cursor-pointer hover:bg-surface-2/50" : ""} onClick={r.onOpen ?? undefined}>
                    <Td left>{r.type}</Td>
                    <Td left className={r.onOpen ? "text-primary" : ""}>{r.ref}</Td>
                    <Td left className="max-w-[220px] truncate">{r.customer}</Td>
                    <Td left>{r.region}</Td>
                    <Td>{r.amountSen ? fmtSen(r.amountSen) : "—"}</Td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      </div>
    </ResizableDrawer>
  );
}
