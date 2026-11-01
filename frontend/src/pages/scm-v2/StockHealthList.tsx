/* Procurement Overview · every dead or buffer row (owner 2026-10-31: the table
   showed 40 of 717 rows; list them all, sort, export). The page's own payload
   carries only the 50 largest; this reads the full lists of the SAME cached
   report from GET /procurement-overview/stock-health when the table is shown. */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { authedFetch } from "../../vendor/scm/lib/authed-fetch";
import { fmtSen } from "../../vendor/shared/format";
import { SortTh, Td, useTableSort } from "../../components/scm-v2/OverviewKit";

export type DeadRow = { warehouse: string; category: string; itemCode: string; variantKey: string; name: string | null; qty: number; valueSen: number; idleDays: number | null };
export type BufferRow = { warehouse: string; category: string; itemCode: string; variantKey: string; name: string | null; bufferQty: number; valueSen: number; lastIn: string | null; heldDays: number | null };

type Col<R> = { k: string; label: string; left?: boolean; value: (r: R) => number | string | null; show: (r: R) => string; tone?: (r: R) => string };

const DEAD_COLS = (cat: (k: string) => string): Col<DeadRow>[] => [
  { k: "item", label: "Item / variant", left: true, value: (r) => r.itemCode, show: (r) => r.itemCode },
  { k: "variant", label: "Variant", left: true, value: (r) => r.variantKey || "", show: (r) => r.variantKey || "" },
  { k: "warehouse", label: "Warehouse", left: true, value: (r) => r.warehouse, show: (r) => r.warehouse },
  { k: "category", label: "Category", left: true, value: (r) => cat(r.category), show: (r) => cat(r.category) },
  { k: "qty", label: "Dead qty", value: (r) => r.qty, show: (r) => String(r.qty) },
  { k: "value", label: "Value", value: (r) => r.valueSen, show: (r) => fmtSen(r.valueSen) },
  { k: "idle", label: "Days since it last went out", value: (r) => r.idleDays, show: (r) => (r.idleDays == null ? "—" : String(r.idleDays)), tone: (r) => ((r.idleDays ?? 0) > 365 ? "text-err" : "") },
];
const BUFFER_COLS = (cat: (k: string) => string): Col<BufferRow>[] => [
  { k: "item", label: "Item / variant", left: true, value: (r) => r.itemCode, show: (r) => r.itemCode },
  { k: "variant", label: "Variant", left: true, value: (r) => r.variantKey || "", show: (r) => r.variantKey || "" },
  { k: "warehouse", label: "Warehouse", left: true, value: (r) => r.warehouse, show: (r) => r.warehouse },
  { k: "category", label: "Category", left: true, value: (r) => cat(r.category), show: (r) => cat(r.category) },
  { k: "qty", label: "Buffer qty", value: (r) => r.bufferQty, show: (r) => String(r.bufferQty) },
  { k: "value", label: "Value", value: (r) => r.valueSen, show: (r) => fmtSen(r.valueSen) },
  { k: "lastIn", label: "Last received", value: (r) => r.lastIn, show: (r) => r.lastIn ?? "—" },
  { k: "held", label: "Held (days)", value: (r) => r.heldDays, show: (r) => (r.heldDays == null ? "—" : String(r.heldDays)), tone: (r) => ((r.heldDays ?? 0) > 90 ? "text-err" : "") },
];

/** The rows as an .xlsx sheet, the columns as shown, money in ringgit. */
export function stockHealthSheet<R>(rows: readonly R[], cols: readonly Col<R>[]): Array<Record<string, string | number | null>> {
  return rows.map((r) => Object.fromEntries(cols.map((c) => [c.label, c.k === "value" ? Number(c.value(r)) / 100 : c.value(r)])));
}

/** `category` / `warehouse`: the row clicked in the tables above, or null for all. */
export function StockHealthList({ kind, query, catLabel, category, warehouse }: { kind: "dead" | "buffer"; query: string; catLabel: (k: string) => string; category: string | null; warehouse: string | null }) {
  const q = useQuery({
    queryKey: ["procurement-overview", "stock-health", query],
    queryFn: () => authedFetch<{ dead: DeadRow[]; buffer: BufferRow[] }>(`/procurement-overview/stock-health?${query}`),
    staleTime: 60_000,
  });
  const [search, setSearch] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const cols = useMemo(() => (kind === "dead" ? DEAD_COLS(catLabel) : BUFFER_COLS(catLabel)), [kind, catLabel]) as Col<DeadRow | BufferRow>[];
  const all = useMemo(() => (((kind === "dead" ? q.data?.dead : q.data?.buffer) ?? []) as Array<DeadRow | BufferRow>)
    .filter((r) => (!category || r.category === category) && (!warehouse || r.warehouse === warehouse)), [q.data, kind, category, warehouse]);
  const needle = search.trim().toLowerCase();
  const rows = useMemo(() => (needle ? all.filter((r) => `${r.itemCode} ${r.variantKey} ${r.name ?? ""} ${r.warehouse} ${catLabel(r.category)}`.toLowerCase().includes(needle)) : all), [all, needle, catLabel]);
  const byKey = useMemo(() => new Map(cols.map((c) => [c.k, c])), [cols]);
  const { sorted, sort, toggle } = useTableSort(rows, (r, k) => byKey.get(k)?.value(r) ?? null);
  const total = rows.reduce((a, r) => a + r.valueSen, 0);

  const exportXlsx = async () => {
    setErr(null);
    try {
      const XLSX = await import("../../lib/xlsx-runtime");
      const ws = XLSX.utils.json_to_sheet(stockHealthSheet(sorted, cols));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, kind === "dead" ? "Dead items" : "Buffer items");
      XLSX.writeFileXLSX(wb, `${kind === "dead" ? "dead" : "buffer"}-items${category ? `-${category}` : ""}${warehouse ? `-${warehouse}` : ""}.xlsx`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not build the Excel file.");
    }
  };

  return (
    <div className="mt-1">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search item, warehouse, category" aria-label="Search these rows"
          className="h-8 min-w-0 flex-1 rounded-md border border-border bg-surface px-2 text-[12px]" />
        <span className="text-[11.5px] text-ink-muted tabular-nums">{q.isLoading ? "Loading…" : `${rows.length} rows · ${fmtSen(total)}`}</span>
        <button type="button" onClick={() => void exportXlsx()} disabled={!rows.length}
          className="h-8 rounded-md border border-border bg-surface px-3 text-[12px] font-semibold text-ink hover:border-primary/40 disabled:opacity-50">Export Excel</button>
      </div>
      {(q.error || err) && <div className="mb-2 rounded-md border border-err/40 bg-err/5 p-2 text-[12px] text-err">{err ?? (q.error instanceof Error ? q.error.message : "Could not load the list.")}</div>}
      <div className="max-h-[480px] overflow-auto">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 bg-surface"><tr>{cols.filter((c) => c.k !== "variant").map((c) => <SortTh key={c.k} left={c.left} k={c.k} sort={sort} onSort={toggle}>{c.label}</SortTh>)}</tr></thead>
          <tbody>{sorted.map((r, i) => (
            <tr key={`${r.itemCode}|${r.variantKey}|${r.warehouse}|${i}`}>
              {cols.filter((c) => c.k !== "variant").map((c) => c.k === "item"
                ? <Td key={c.k} left><span title={r.name ?? ""}>{r.itemCode}</span>{r.variantKey && <span className="block max-w-[320px] truncate text-[10.5px] text-ink-muted">{r.variantKey}</span>}</Td>
                : <Td key={c.k} left={c.left} className={c.tone?.(r) ?? ""}>{c.show(r)}</Td>)}
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}
