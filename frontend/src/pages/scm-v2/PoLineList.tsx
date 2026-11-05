/* Procurement Overview · every outstanding PO line under the breakdown (owner
   2026-10-31: click Mattress / a supplier and its POs list below; layer them by
   days overdue, click a layer to see its POs; sort; export; empty layers hidden). */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { fmtSen } from "../../vendor/shared/format";
import { cn } from "../../lib/utils";
import { SortTh, Td, useTableSort } from "../../components/scm-v2/OverviewKit";

export type PoLine = {
  poId: string; poNumber: string; poDate: string; supplier: string; category: string; itemCode: string | null;
  itemDesc: string | null; soDocNo: string | null; dueDate: string | null; openQty: number; openSen: number; daysLate: number | null;
};

/* Days past the date first put on the PO; "not due" also holds lines with no date. */
export const LAYERS = [
  { k: "late30", label: "Over 30 days late", min: 31, max: Infinity },
  { k: "late15", label: "15–30 days late", min: 15, max: 30 },
  { k: "late8", label: "8–14 days late", min: 8, max: 14 },
  { k: "late4", label: "4–7 days late", min: 4, max: 7 },
  { k: "late1", label: "1–3 days late", min: 1, max: 3 },
  { k: "notDue", label: "Not yet due", min: -Infinity, max: 0 },
] as const;
export type LayerKey = (typeof LAYERS)[number]["k"] | "late";

export function layerOf(l: Pick<PoLine, "daysLate">): (typeof LAYERS)[number]["k"] {
  const d = l.daysLate ?? 0;
  return LAYERS.find((x) => d >= x.min && d <= x.max)?.k ?? "notDue";
}
const inLayer = (l: PoLine, k: LayerKey | null) => k == null || (k === "late" ? (l.daysLate ?? 0) > 0 : layerOf(l) === k);

type Col = { k: string; label: string; left?: boolean; value: (l: PoLine) => number | string | null };
const COLS = (cat: (k: string) => string): Col[] => [
  { k: "po", label: "PO", left: true, value: (l) => l.poNumber },
  { k: "poDate", label: "PO date", value: (l) => l.poDate },
  { k: "supplier", label: "Supplier", left: true, value: (l) => l.supplier },
  { k: "category", label: "Category", left: true, value: (l) => cat(l.category) },
  { k: "item", label: "Item", left: true, value: (l) => l.itemCode },
  { k: "desc", label: "Description", left: true, value: (l) => l.itemDesc },
  { k: "so", label: "Sales order", left: true, value: (l) => l.soDocNo },
  { k: "qty", label: "Still to come", value: (l) => l.openQty },
  { k: "amount", label: "Amount", value: (l) => l.openSen },
  { k: "due", label: "Date on PO", value: (l) => l.dueDate },
  { k: "late", label: "Days late", value: (l) => l.daysLate },
];

/** The rows as an .xlsx sheet, the columns as shown, money in ringgit. */
export function poLineSheet(rows: readonly PoLine[], cat: (k: string) => string): Array<Record<string, string | number | null>> {
  const cols = COLS(cat);
  return rows.map((l) => Object.fromEntries(cols.map((c) => [c.label, c.k === "amount" ? l.openSen / 100 : c.value(l)])));
}

export function PoLineList({ lines, focusLabel, layer, onLayer, catLabel, onClearFocus }: {
  lines: readonly PoLine[]; focusLabel: string | null; layer: LayerKey | null; onLayer: (k: LayerKey | null) => void;
  catLabel: (k: string) => string; onClearFocus: () => void;
}) {
  const [search, setSearch] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const cols = useMemo(() => COLS(catLabel), [catLabel]);
  const byKey = useMemo(() => new Map(cols.map((c) => [c.k, c])), [cols]);
  const layers = LAYERS.map((x) => {
    const of = lines.filter((l) => layerOf(l) === x.k);
    return { ...x, count: of.length, sen: of.reduce((a, l) => a + l.openSen, 0) };
  }).filter((x) => x.count > 0);
  const needle = search.trim().toLowerCase();
  const rows = useMemo(() => lines.filter((l) => inLayer(l, layer)
    && (!needle || `${l.poNumber} ${l.supplier} ${l.itemCode ?? ""} ${l.itemDesc ?? ""} ${l.soDocNo ?? ""}`.toLowerCase().includes(needle))), [lines, layer, needle]);
  const { sorted, sort, toggle } = useTableSort(rows, (l, k) => byKey.get(k)?.value(l) ?? null);
  const total = rows.reduce((a, l) => a + l.openSen, 0);
  const layerLabel = layer === "late" ? "All overdue" : LAYERS.find((x) => x.k === layer)?.label ?? null;

  const exportXlsx = async () => {
    setErr(null);
    try {
      const XLSX = await import("../../lib/xlsx-runtime");
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(poLineSheet(sorted, catLabel)), "PO lines");
      XLSX.writeFileXLSX(wb, `po-lines${focusLabel ? `-${focusLabel}` : ""}${layer ? `-${layer}` : ""}.xlsx`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not build the Excel file.");
    }
  };

  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-1.5">
        <Chip on={layer == null} onClick={() => onLayer(null)} label="All outstanding" count={lines.length} sen={lines.reduce((a, l) => a + l.openSen, 0)} late={false} />
        {layers.map((x) => (
          <Chip key={x.k} on={layer === x.k} onClick={() => onLayer(layer === x.k ? null : x.k)} label={x.label} count={x.count} sen={x.sen} late={x.k !== "notDue"} />
        ))}
      </div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search PO, supplier, item, sales order" aria-label="Search these PO lines"
          className="h-8 min-w-0 flex-1 rounded-md border border-border bg-surface px-2 text-[12px]" />
        <span className="text-[11.5px] text-ink-muted tabular-nums">
          {[focusLabel, layerLabel].filter(Boolean).join(" · ")}{focusLabel || layerLabel ? " · " : ""}{rows.length} lines · {fmtSen(total)}
        </span>
        {focusLabel && <button type="button" className="text-[12px] text-primary hover:underline" onClick={onClearFocus}>Show all</button>}
        <button type="button" onClick={() => void exportXlsx()} disabled={!rows.length}
          className="h-8 rounded-md border border-border bg-surface px-3 text-[12px] font-semibold text-ink hover:border-primary/40 disabled:opacity-50">Export Excel</button>
      </div>
      {err && <div className="mb-2 rounded-md border border-err/40 bg-err/5 p-2 text-[12px] text-err">{err}</div>}
      {rows.length === 0 ? <p className="py-2 text-[12.5px] text-ink-muted">No outstanding PO lines here.</p> : (
        <div className="max-h-[520px] overflow-auto">
          <table className="w-full border-collapse">
            <thead className="sticky top-0 bg-surface"><tr>{cols.map((c) => <SortTh key={c.k} left={c.left} k={c.k} sort={sort} onSort={toggle}>{c.label}</SortTh>)}</tr></thead>
            <tbody>{sorted.map((l, i) => (
              <tr key={`${l.poId}|${l.itemCode}|${l.dueDate}|${i}`} className="hover:bg-surface-2/50">
                <Td left><Link to={`/scm/purchase-orders/${l.poId}`} className="text-primary hover:underline">{l.poNumber}</Link></Td>
                <Td>{l.poDate}</Td>
                <Td left className="max-w-[160px] truncate">{l.supplier}</Td>
                <Td left>{catLabel(l.category)}</Td>
                <Td left>{l.itemCode ?? "—"}</Td>
                <Td left className="max-w-[220px] truncate"><span title={l.itemDesc ?? ""}>{l.itemDesc ?? "—"}</span></Td>
                <Td left>{l.soDocNo ?? <span className="text-ink-muted">stock</span>}</Td>
                <Td>{l.openQty}</Td>
                <Td>{fmtSen(l.openSen)}</Td>
                <Td>{l.dueDate ?? "—"}</Td>
                <Td className={cn((l.daysLate ?? 0) >= 8 ? "font-semibold text-err" : (l.daysLate ?? 0) > 0 ? "text-warning-text" : "text-ink-muted")}>
                  {l.daysLate == null ? "—" : l.daysLate > 0 ? l.daysLate : l.daysLate === 0 ? "today" : `in ${-l.daysLate}`}
                </Td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Chip({ on, onClick, label, count, sen, late }: { on: boolean; onClick: () => void; label: string; count: number; sen: number; late: boolean }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on}
      className={cn("rounded-md border px-2.5 py-1 text-left text-[12px] tabular-nums",
        on ? "border-primary bg-primary-soft/60 text-ink" : "border-border bg-surface text-ink-secondary hover:border-primary/40")}>
      <span className={cn("block font-semibold", late && "text-err")}>{label}</span>
      <span className="block text-[11px] text-ink-muted">{count} lines · {fmtSen(sen)}</span>
    </button>
  );
}
