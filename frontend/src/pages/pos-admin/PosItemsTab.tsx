/* POS Admin > POS Items (layout E1): the furniture SKUs tagged for the booth,
 * their barcodes, price, event price overrides, pre-set (AUTO) discount, FOC
 * rule, max manual discount, stock source and short receipt name. Add from
 * Inventory searches the SKU master; Import Excel / Export round-trip the
 * list. Changes reach devices on the next Prepare / Refresh / Push. */
import { useMemo, useState } from "react";
import { Download, PackagePlus, Plus, Trash2, Upload } from "lucide-react";
import { api } from "../../api/client";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import { readImportGrid } from "../../lib/import-sheet";
import { cn, formatDateTime } from "../../lib/utils";
import { fmtSen } from "../../vendor/shared/format";
import { useWarehouses } from "../../vendor/scm/lib/inventory-queries";
import { ResizableDrawer } from "../../components/ResizableDrawer";
import { SearchInput } from "../../components/Button";
import { mfgCategoryLabel } from "../../vendor/shared/product-categories";
import { PosBoothCategoriesDrawer } from "./PosBoothCategoriesDrawer";
import { POS_ADMIN, rm, toSen, useAdminItems, useAdminEvents, type PosItem, type SkuCandidate } from "./posAdminApi";
import { Empty, Field, Pill, Table, Toggle, dangerBtn, errText, ghostBtn, inputCls, primaryBtn, td, th } from "./posAdminUi";

type Draft = {
  uom: string; price: string; cost: string; preset_discount_type: "" | "PCT" | "RM"; preset_discount_value: string;
  foc_allowed: boolean; max_manual_disc_pct: string; stock_source_warehouse_id: string; receipt_name: string; active: boolean;
};

const draftOf = (i: PosItem): Draft => ({
  uom: i.uom, price: rm(i.price_sen), cost: rm(i.cost_sen), preset_discount_type: i.preset_discount_type ?? "",
  preset_discount_value: i.preset_discount_value == null ? "" : String(i.preset_discount_value), foc_allowed: i.foc_allowed,
  max_manual_disc_pct: i.max_manual_disc_pct == null ? "" : String(i.max_manual_disc_pct),
  stock_source_warehouse_id: i.stock_source_warehouse_id ?? "", receipt_name: i.receipt_name ?? "", active: i.active,
});

function bodyOf(d: Draft) {
  return {
    uom: d.uom.trim() || "UNIT",
    price_sen: toSen(d.price) ?? 0,
    cost_sen: toSen(d.cost),
    preset_discount_type: d.preset_discount_type || null,
    preset_discount_value: d.preset_discount_type ? Number(d.preset_discount_value) || 0 : null,
    foc_allowed: d.foc_allowed,
    max_manual_disc_pct: d.max_manual_disc_pct.trim() === "" ? null : Number(d.max_manual_disc_pct),
    stock_source_warehouse_id: d.stock_source_warehouse_id || null,
    receipt_name: d.receipt_name.trim() || null,
    active: d.active,
  };
}

const discLabel = (i: PosItem): string =>
  i.preset_discount_type === "PCT" ? `-${i.preset_discount_value}%` : i.preset_discount_type === "RM" ? `-RM${i.preset_discount_value}` : "--";

export function PosItemsTab() {
  const toast = useToast();
  const dialog = useDialog();
  const items = useAdminItems();
  const events = useAdminEvents();
  const warehouses = useWarehouses();
  const [search, setSearch] = useState("");
  const [activeOnly, setActiveOnly] = useState(true);
  const [eventFilter, setEventFilter] = useState<number | "">("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [picking, setPicking] = useState(false);
  const [editing, setEditing] = useState<PosItem | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (items.data ?? []).filter((i) => {
      if (activeOnly && !i.active) return false;
      if (eventFilter !== "" && !i.event_prices.some((p) => p.project_id === eventFilter)) return false;
      if (categoryFilter !== "" && (i.category ?? "") !== categoryFilter) return false;
      if (!q) return true;
      return i.item_code.toLowerCase().includes(q) || i.name.toLowerCase().includes(q) || i.barcodes.some((b) => b.barcode.toLowerCase().includes(q));
    });
  }, [items.data, search, activeOnly, eventFilter, categoryFilter]);
  const categories = useMemo(() => [...new Set((items.data ?? []).map((i) => i.category ?? ""))].sort(), [items.data]);

  const eventName = (pid: number) => events.data?.find((e) => e.project_id === pid)?.name ?? `#${pid}`;

  async function exportExcel() {
    const writeXlsxFile = (await import("write-excel-file")).default;
    const header = ["Item Code", "Name", "Barcode", "UOM", "Price", "Cost", "Discount Type", "Discount Value", "FOC", "Max Manual Disc", "Receipt Name", "Stock", "Active"];
    const data = [
      header.map((h) => ({ value: h, fontWeight: "bold" as const })),
      ...rows.map((i) => [
        { value: i.item_code, type: String }, { value: i.name, type: String }, { value: i.barcodes.map((b) => b.barcode).join(" "), type: String },
        { value: i.uom, type: String }, { value: i.price_sen / 100, type: Number }, { value: i.cost_sen == null ? "" : i.cost_sen / 100, type: i.cost_sen == null ? String : Number },
        { value: i.preset_discount_type === "PCT" ? "%" : i.preset_discount_type ?? "", type: String }, { value: i.preset_discount_value ?? "", type: i.preset_discount_value == null ? String : Number },
        { value: i.foc_allowed ? "Y" : "N", type: String }, { value: i.max_manual_disc_pct ?? "", type: i.max_manual_disc_pct == null ? String : Number },
        { value: i.receipt_name ?? "", type: String }, { value: i.stock_qty, type: Number }, { value: i.active ? "Y" : "N", type: String },
      ]),
    ];
    await writeXlsxFile(data, { fileName: "POS_Items.xlsx", columns: header.map((h) => ({ width: Math.max(10, h.length + 4) })), stickyRowsCount: 1 });
  }

  async function importExcel(file: File) {
    setBusy(true);
    try {
      const grid = await readImportGrid(file);
      const [head, ...body] = grid;
      if (grid.length < 2 || body.length === 0) throw new Error("The sheet has no rows under its header.");
      const rowsIn = body.filter((r) => r.some((c) => c.trim() !== "")).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
      const res = await api.post<{ created: number; updated: number; skipped: { line: number; item_code: string | null; reason: string }[] }>(`${POS_ADMIN}/items/import`, { rows: rowsIn });
      toast.success(`Imported: ${res.created} new, ${res.updated} updated${res.skipped.length ? `, ${res.skipped.length} skipped` : ""}`);
      if (res.skipped.length) {
        await dialog.confirm({ title: `${res.skipped.length} row(s) skipped`, message: res.skipped.slice(0, 15).map((s) => `Row ${s.line} ${s.item_code ?? ""}: ${s.reason}`).join("\n"), confirmLabel: "OK" });
      }
      items.reload();
    } catch (e) {
      toast.error(errText(e, "Import failed."));
    } finally {
      setBusy(false);
    }
  }

  async function deactivate(i: PosItem) {
    if (!(await dialog.confirm({ title: `Remove ${i.item_code} from POS?`, message: "The item stops reaching devices on their next prepare or refresh. Bills already sold keep their lines.", confirmLabel: "Remove", danger: true }))) return;
    try {
      await api.del(`${POS_ADMIN}/items/${i.id}`);
      toast.success("Removed from POS");
      items.reload();
    } catch (e) {
      toast.error(errText(e, "Could not remove the item."));
    }
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <SearchInput value={search} onChange={setSearch} placeholder="Search code, name, barcode" widthClassName="w-64" aria-label="Search POS items" />
        <select value={eventFilter} onChange={(e) => setEventFilter(e.target.value ? Number(e.target.value) : "")} className={cn(inputCls, "w-auto")} aria-label="Event">
          <option value="">Any event price</option>
          {(events.data ?? []).filter((e) => e.link).map((e) => <option key={e.project_id} value={e.project_id}>{e.name}</option>)}
        </select>
        <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} className={cn(inputCls, "w-auto")} aria-label="Category">
          <option value="">All categories</option>
          {categories.map((c) => <option key={c} value={c}>{c === "" ? "No category" : mfgCategoryLabel(c)}</option>)}
        </select>
        <label className="flex items-center gap-1 text-[11px] text-ink-secondary"><input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} /> POS active only</label>
        <span className="ml-auto flex items-center gap-1.5">
          <label className={cn(ghostBtn, "cursor-pointer")}>
            <Upload size={11} /> Import Excel
            <input type="file" accept=".xlsx,.xls,.csv" className="hidden" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void importExcel(f); }} />
          </label>
          <button type="button" className={ghostBtn} onClick={() => void exportExcel()} disabled={rows.length === 0}><Download size={11} /> Export</button>
          <button type="button" className={ghostBtn} disabled={busy} onClick={() => setPicking(true)} title="Tick the inventory categories the booth sells; add their products, switch off the rest"><PackagePlus size={11} /> Add by category</button>
          <button type="button" className={primaryBtn} onClick={() => setAdding(true)}><Plus size={11} /> Add from Inventory</button>
        </span>
      </div>

      {items.loading && !items.data && <div className="text-[11px] text-ink-muted">Loading POS items…</div>}
      {items.error && <div className="rounded-md border border-err/40 bg-err/5 p-2 text-[11px] text-err">{items.error}</div>}
      {items.data && rows.length === 0 && <Empty>{items.data.length === 0 ? "No POS items yet. Add from Inventory or import an Excel sheet." : "Nothing matches."}</Empty>}
      {rows.length > 0 && (
        <Table minWidth={980} head={<>
          <th className={th}>Code</th><th className={th}>Description</th><th className={th}>Barcode(s)</th><th className={th}>UOM</th>
          <th className={cn(th, "text-right")}>Price</th><th className={th}>Event price</th><th className={th}>Pre-set disc</th><th className={th}>FOC</th>
          <th className={cn(th, "text-right")}>Stock</th><th className={th}>Active</th><th className={th} />
        </>}>
          {rows.map((i) => (
            <tr key={i.id} className="cursor-pointer border-t border-border-subtle hover:bg-bg/40" onClick={() => setEditing(i)}>
              <td className={cn(td, "font-mono text-[10.5px] font-semibold text-accent")}>{i.item_code}</td>
              <td className={td}>{i.name}{i.receipt_name && <span className="ml-1 text-[10px] text-ink-muted">({i.receipt_name})</span>}{i.category && <span className="ml-1 text-[10px] uppercase text-ink-muted">{mfgCategoryLabel(i.category)}</span>}</td>
              <td className={cn(td, "font-mono text-[10px]")}>
                {i.barcodes.length === 0 ? <span className="text-amber-800">none</span> : i.barcodes.map((b) => <span key={b.barcode} className="mr-1 inline-block" title={b.kind}>{b.barcode}</span>)}
              </td>
              <td className={td}>{i.uom}</td>
              <td className={cn(td, "text-right font-mono font-semibold")}>{fmtSen(i.price_sen)}</td>
              <td className={cn(td, "text-[10.5px]")}>{i.event_prices.length === 0 ? <span className="text-ink-muted">--</span> : i.event_prices.map((p) => <div key={p.project_id}>{fmtSen(p.price_sen)} <span className="text-ink-muted">{eventName(p.project_id)}</span></div>)}</td>
              <td className={td}>{i.preset_discount_type ? <Pill tone="info">AUTO {discLabel(i)}</Pill> : <span className="text-ink-muted">--</span>}</td>
              <td className={td}>{i.foc_allowed ? <Pill tone="ok">FOC</Pill> : <span className="text-ink-muted">--</span>}</td>
              <td className={cn(td, "text-right font-mono", i.stock_qty <= 0 && "text-amber-800")}>{i.stock_qty}</td>
              <td className={td}>{i.active ? <Pill tone="ok">ON</Pill> : <Pill tone="muted">OFF</Pill>}</td>
              <td className={td} onClick={(e) => e.stopPropagation()}>
                {i.active && <button type="button" className={dangerBtn} onClick={() => void deactivate(i)} title="Remove from POS"><Trash2 size={11} /></button>}
              </td>
            </tr>
          ))}
        </Table>
      )}

      {editing && (
        <ItemDrawer
          item={editing}
          warehouses={(warehouses.data ?? []).filter((w) => w.is_active)}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); items.reload(); }}
        />
      )}
      {picking && <PosBoothCategoriesDrawer onClose={() => setPicking(false)} onChanged={() => items.reload()} />}
      {adding && <AddFromInventory onClose={() => setAdding(false)} onAdded={() => { setAdding(false); items.reload(); }} />}
    </div>
  );
}

function ItemDrawer({ item, warehouses, onClose, onSaved }: { item: PosItem; warehouses: { id: string; code: string; name: string }[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [d, setD] = useState<Draft>(() => draftOf(item));
  const [barcode, setBarcode] = useState("");
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }));

  async function save() {
    setSaving(true);
    try {
      await api.patch(`${POS_ADMIN}/items/${item.id}`, bodyOf(d));
      toast.success("POS item saved");
      onSaved();
    } catch (e) {
      toast.error(errText(e, "Could not save the item."));
    } finally {
      setSaving(false);
    }
  }
  async function addBarcode() {
    const b = barcode.trim();
    if (!b) return;
    try {
      await api.post(`${POS_ADMIN}/items/${item.id}/barcodes`, { barcode: b });
      toast.success("Barcode added");
      setBarcode("");
      onSaved();
    } catch (e) {
      toast.error(errText(e, "Could not add the barcode (is it already on another item?)."));
    }
  }
  async function removeBarcode(id: number) {
    try {
      await api.del(`${POS_ADMIN}/items/${item.id}/barcodes/${id}`);
      onSaved();
    } catch (e) {
      toast.error(errText(e, "Could not remove the barcode."));
    }
  }

  return (
    <ResizableDrawer
      onClose={onClose}
      title={<span className="font-mono">{item.item_code}</span>}
      subtitle={item.name}
      storageKey="pos-admin-item-drawer"
      defaultWidth={520}
      footer={<div className="flex justify-end gap-2"><button type="button" className={ghostBtn} onClick={onClose}>Cancel</button><button type="button" className={primaryBtn} disabled={saving} onClick={() => void save()}>Save</button></div>}
    >
      <div className="space-y-3 p-3">
        <div className="rounded-md border border-border-subtle bg-bg/30 p-2 text-[11px] text-ink-secondary">
          Inventory link: <span className="font-mono">{item.item_code}</span> {item.category ? `· ${item.category}` : ""} · stock {item.stock_qty}
          {item.sku_price_sen != null && <> · SKU price {fmtSen(item.sku_price_sen)}</>}
        </div>
        <Field label="Barcodes" hint="Scan into the box to add another. The factory and generated barcodes come from the inventory item.">
          <div className="mb-1 flex flex-wrap gap-1">
            {item.barcodes.map((b) => (
              <span key={b.barcode} className="inline-flex items-center gap-1 rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-[10.5px]">
                {b.barcode} <span className="text-[9px] text-ink-muted">{b.kind}</span>
                {b.id != null && <button type="button" className="text-rose-700" title="Remove" onClick={() => void removeBarcode(b.id!)}>x</button>}
              </span>
            ))}
          </div>
          <div className="flex gap-1">
            <input className={inputCls} value={barcode} onChange={(e) => setBarcode(e.target.value)} placeholder="Scan or type a barcode" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void addBarcode(); } }} />
            <button type="button" className={ghostBtn} onClick={() => void addBarcode()}>Add</button>
          </div>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="UOM"><input className={inputCls} value={d.uom} onChange={(e) => set("uom", e.target.value)} /></Field>
          <Field label="Selling price (RM)"><input className={inputCls} inputMode="decimal" value={d.price} onChange={(e) => set("price", e.target.value)} /></Field>
          <Field label="Cost (RM, optional)"><input className={inputCls} inputMode="decimal" value={d.cost} onChange={(e) => set("cost", e.target.value)} /></Field>
          <Field label="Max manual discount %" hint="Blank = the cashier's own cap"><input className={inputCls} inputMode="decimal" value={d.max_manual_disc_pct} onChange={(e) => set("max_manual_disc_pct", e.target.value)} /></Field>
          <Field label="Pre-set discount (AUTO)">
            <select className={inputCls} value={d.preset_discount_type} onChange={(e) => set("preset_discount_type", e.target.value as Draft["preset_discount_type"])}>
              <option value="">None</option><option value="PCT">% off</option><option value="RM">RM off</option>
            </select>
          </Field>
          <Field label="Discount value"><input className={inputCls} inputMode="decimal" disabled={!d.preset_discount_type} value={d.preset_discount_value} onChange={(e) => set("preset_discount_value", e.target.value)} /></Field>
          <Field label="Stock source" hint="Blank = the POS store in General">
            <select className={inputCls} value={d.stock_source_warehouse_id} onChange={(e) => set("stock_source_warehouse_id", e.target.value)}>
              <option value="">POS store (General)</option>
              {warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} {w.name}</option>)}
            </select>
          </Field>
          <Field label="Short receipt name (24 chars)"><input className={inputCls} maxLength={24} value={d.receipt_name} onChange={(e) => set("receipt_name", e.target.value)} /></Field>
        </div>
        <Toggle checked={d.foc_allowed} onChange={(v) => set("foc_allowed", v)} label="FOC allowed" hint="The cashier may give this item free; stock still deducts." />
        <Toggle checked={d.active} onChange={(v) => set("active", v)} label="Active on POS" />
        {item.event_prices.length > 0 && (
          <div className="text-[10.5px] text-ink-muted">Event price overrides are set on the Events tab. Last updated {formatDateTime(item.updated_at)}.</div>
        )}
      </div>
    </ResizableDrawer>
  );
}

function AddFromInventory({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const toast = useToast();
  const [q, setQ] = useState("");
  const [found, setFound] = useState<SkuCandidate[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  async function search(term: string) {
    setQ(term);
    if (term.trim().length < 2) { setFound([]); return; }
    setSearching(true);
    try {
      const res = await api.get<{ data: SkuCandidate[] }>(`${POS_ADMIN}/inventory/search?q=${encodeURIComponent(term.trim())}`);
      setFound(Array.isArray(res.data) ? res.data : []);
    } catch (e) {
      toast.error(errText(e, "Search failed."));
    } finally {
      setSearching(false);
    }
  }
  async function turnOn(s: SkuCandidate) {
    setBusy(s.product_id);
    try {
      await api.patch(`${POS_ADMIN}/items/${s.pos_item_id}`, { active: true });
      toast.success(`${s.code} is back on the POS`);
      onAdded();
    } catch (e) {
      toast.error(errText(e, "Could not turn the item on."));
    } finally {
      setBusy(null);
    }
  }
  async function add(s: SkuCandidate) {
    setBusy(s.product_id);
    try {
      await api.post(`${POS_ADMIN}/items`, { product_id: s.product_id });
      toast.success(`${s.code} added to POS`);
      onAdded();
    } catch (e) {
      toast.error(errText(e, "Could not add the item."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <ResizableDrawer onClose={onClose} title="Add from Inventory" subtitle="Search the SKU master by code, name or barcode" storageKey="pos-admin-add-item" defaultWidth={560}>
      <div className="space-y-2 p-3">
        <SearchInput value={q} onChange={(v) => void search(v)} placeholder="Type at least 2 characters" widthClassName="w-full" autoFocus aria-label="Search inventory" />
        {searching && <div className="text-[11px] text-ink-muted">Searching…</div>}
        {!searching && q.trim().length >= 2 && found.length === 0 && <Empty>No active SKU matches.</Empty>}
        {found.length > 0 && (
          <Table minWidth={480} head={<><th className={th}>Code</th><th className={th}>Name</th><th className={th}>Barcode</th><th className={cn(th, "text-right")}>Price</th><th className={cn(th, "text-right")}>Stock</th><th className={th} /></>}>
            {found.map((s) => (
              <tr key={s.product_id} className="border-t border-border-subtle">
                <td className={cn(td, "font-mono text-[10.5px]")}>{s.code}</td>
                <td className={td}>{s.name}</td>
                <td className={cn(td, "font-mono text-[10px]")}>{s.barcode ?? <span className="text-amber-800">none</span>}</td>
                <td className={cn(td, "text-right font-mono")}>{s.sell_price_sen == null ? "--" : fmtSen(s.sell_price_sen)}</td>
                <td className={cn(td, "text-right font-mono")}>{s.stock_qty}</td>
                <td className={td}>
                  {s.pos_item_id && s.pos_active ? <Pill tone="ok">POS</Pill> : s.pos_item_id ? (
                    <button type="button" className={ghostBtn} disabled={busy === s.product_id} onClick={() => void turnOn(s)} title="Switched off earlier; turn it back on"><Pill tone="muted">POS OFF</Pill> Turn on</button>
                  ) : (
                    <button type="button" className={primaryBtn} disabled={busy === s.product_id} onClick={() => void add(s)}><Plus size={11} /> Add</button>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </div>
    </ResizableDrawer>
  );
}
