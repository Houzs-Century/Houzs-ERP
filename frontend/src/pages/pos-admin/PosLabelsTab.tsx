/* POS Admin > Barcode labels (layout E1b): the inventory items with their
 * factory barcode / own generated barcode / none, "Missing only", Generate
 * for selected (EAN-13, prefix 200, saved for good on the item), label qty
 * per item, and Print labels: an A4 sheet of 40 x 30 mm labels through the
 * browser, or a TSPL / ZPL job file for a label printer. */
import { useMemo, useState } from "react";
import { Barcode, Printer } from "lucide-react";
import { api } from "../../api/client";
import { useToast } from "../../hooks/useToast";
import { cn } from "../../lib/utils";
import { fmtSen } from "../../vendor/shared/format";
import { SearchInput } from "../../components/Button";
import { Pagination } from "../../components/Pagination";
import { POS_ADMIN, useAdminLabels, type LabelRow } from "./posAdminApi";
import { Empty, Pill, Table, Toggle, errText, ghostBtn, inputCls, primaryBtn, td, th } from "./posAdminUi";
import { downloadText, labelSheetHtml, labelsTspl, labelsZpl, openPrintWindow, type LabelSpec } from "./labelPrint";

const PAGE = 50;

export function PosLabelsTab() {
  const toast = useToast();
  const [search, setSearch] = useState("");
  const [missing, setMissing] = useState(false);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Record<string, number>>({});
  const [withPrice, setWithPrice] = useState(true);
  const [busy, setBusy] = useState(false);
  const labels = useAdminLabels(search.trim(), missing, page);
  const rows = labels.data?.data ?? [];
  const total = labels.data?.total ?? 0;
  const selectedIds = useMemo(() => Object.keys(selected), [selected]);

  const toggle = (r: LabelRow) => setSelected((s) => { const n = { ...s }; if (r.product_id in n) delete n[r.product_id]; else n[r.product_id] = 1; return n; });
  const setQty = (id: string, qty: number) => setSelected((s) => ({ ...s, [id]: Math.max(1, Math.min(500, Math.floor(qty) || 1)) }));

  async function generate() {
    const ids = rows.filter((r) => r.product_id in selected && r.status === "NONE").map((r) => r.product_id);
    if (ids.length === 0) { toast.info("Select items without a barcode first."); return; }
    setBusy(true);
    try {
      const res = await api.post<{ generated: { product_id: string; barcode: string }[]; already: number }>(`${POS_ADMIN}/labels/generate`, { product_ids: ids });
      toast.success(`${res.generated.length} barcode(s) generated`);
      labels.reload();
    } catch (e) {
      toast.error(errText(e, "Could not generate barcodes."));
    } finally {
      setBusy(false);
    }
  }

  async function specsForSelected(): Promise<LabelSpec[]> {
    if (selectedIds.length === 0) return [];
    const res = await api.get<{ data: LabelRow[] }>(`${POS_ADMIN}/labels?ids=${encodeURIComponent(selectedIds.join(","))}`);
    return (Array.isArray(res.data) ? res.data : [])
      .map((r) => ({ name: r.name, code: r.code, price: withPrice && r.sell_price_sen != null ? (r.sell_price_sen / 100).toFixed(2) : null, barcode: r.own_barcode ?? r.factory_barcode ?? "", qty: r.product_id in selected ? selected[r.product_id] : 1 }))
      .filter((s) => s.barcode);
  }

  async function print(kind: "a4" | "tspl" | "zpl") {
    setBusy(true);
    try {
      const specs = await specsForSelected();
      if (specs.length === 0) { toast.info("Select items that have a barcode."); return; }
      if (kind === "a4") {
        if (!openPrintWindow(labelSheetHtml(specs))) toast.error("The browser blocked the print window. Allow pop-ups for this site.");
      } else if (kind === "tspl") downloadText("pos-labels.tspl", labelsTspl(specs));
      else downloadText("pos-labels.zpl", labelsZpl(specs));
    } catch (e) {
      toast.error(errText(e, "Could not build the labels."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search code or name" widthClassName="w-64" aria-label="Search inventory items" />
        <label className="flex items-center gap-1 text-[11px] text-ink-secondary"><input type="checkbox" checked={missing} onChange={(e) => { setMissing(e.target.checked); setPage(1); }} /> Missing only</label>
        <span className="text-[11px] text-ink-muted">{selectedIds.length} selected</span>
        <span className="ml-auto flex items-center gap-1.5">
          <button type="button" className={primaryBtn} disabled={busy || selectedIds.length === 0} onClick={() => void generate()}><Barcode size={11} /> Generate for selected</button>
          <button type="button" className={ghostBtn} disabled={busy || selectedIds.length === 0} onClick={() => void print("a4")}><Printer size={11} /> Print A4 sheet</button>
          <button type="button" className={ghostBtn} disabled={busy || selectedIds.length === 0} onClick={() => void print("tspl")}>TSPL file</button>
          <button type="button" className={ghostBtn} disabled={busy || selectedIds.length === 0} onClick={() => void print("zpl")}>ZPL file</button>
        </span>
      </div>
      <div className="mb-2"><Toggle checked={withPrice} onChange={setWithPrice} label="Print the price on the label" /></div>

      {labels.loading && !labels.data && <div className="text-[11px] text-ink-muted">Loading inventory…</div>}
      {labels.error && <div className="rounded-md border border-err/40 bg-err/5 p-2 text-[11px] text-err">{labels.error}</div>}
      {labels.data && rows.length === 0 && <Empty>{missing ? "Every item matching has a barcode." : "No active inventory item matches."}</Empty>}
      {rows.length > 0 && (
        <Table minWidth={820} head={<>
          <th className={th}><input type="checkbox" aria-label="Select page" checked={rows.every((r) => r.product_id in selected)} onChange={(e) => setSelected((s) => { const n = { ...s }; for (const r of rows) { if (e.target.checked) { if (!(r.product_id in n)) n[r.product_id] = 1; } else delete n[r.product_id]; } return n; })} /></th>
          <th className={th}>Code</th><th className={th}>Name</th><th className={th}>Factory barcode</th><th className={th}>Own barcode</th><th className={th}>Status</th><th className={cn(th, "text-right")}>Price</th><th className={th}>POS</th><th className={th}>Qty labels</th>
        </>}>
          {rows.map((r) => {
            const on = r.product_id in selected;
            return (
              <tr key={r.product_id} className={cn("border-t border-border-subtle", on && "bg-accent-soft/30")}>
                <td className={td}><input type="checkbox" checked={on} onChange={() => toggle(r)} aria-label={`Select ${r.code}`} /></td>
                <td className={cn(td, "font-mono text-[10.5px] font-semibold")}>{r.code}</td>
                <td className={td}>{r.name}</td>
                <td className={cn(td, "font-mono text-[10px]")}>{r.factory_barcode ?? <span className="text-ink-muted">--</span>}</td>
                <td className={cn(td, "font-mono text-[10px]")}>{r.own_barcode ?? <span className="text-ink-muted">--</span>}</td>
                <td className={td}>{r.status === "FACTORY" ? <Pill tone="info">FACTORY</Pill> : r.status === "GENERATED" ? <Pill tone="ok">GENERATED</Pill> : <Pill tone="warn">NO BARCODE</Pill>}</td>
                <td className={cn(td, "text-right font-mono")}>{r.sell_price_sen == null ? "--" : fmtSen(r.sell_price_sen)}</td>
                <td className={td}>{r.is_pos_item ? <Pill tone="ok">POS</Pill> : <span className="text-ink-muted">--</span>}</td>
                <td className={td}>{on && <input type="number" min={1} max={500} className={cn(inputCls, "w-20")} value={selected[r.product_id]} onChange={(e) => setQty(r.product_id, Number(e.target.value))} aria-label={`Labels for ${r.code}`} />}</td>
              </tr>
            );
          })}
        </Table>
      )}
      {total > PAGE && <div className="mt-2"><Pagination page={page} perPage={PAGE} total={total} onPageChange={setPage} /></div>}
    </div>
  );
}
