/* POS Admin > Events (layout E3): the projects linked to POS — type, dates,
 * terminals with paired status, cashiers, catalog version, COMING / ON GOING /
 * DONE plus LINKED / NOT LINKED. The drawer sets terminals, cashiers (= login tiles),
 * catalog scope, stock source, event price overrides, SST default, receipt
 * header, and pushes a catalog update. Cash & Carry projects are listed
 * automatically; any other project can be linked by search. */
import { useMemo, useState } from "react";
import { Link2, RefreshCw, Unlink } from "lucide-react";
import { api } from "../../api/client";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import { cn, formatDate, formatDateTime } from "../../lib/utils";
import { fmtSen } from "../../vendor/shared/format";
import { useWarehouses } from "../../vendor/scm/lib/inventory-queries";
import { ResizableDrawer } from "../../components/ResizableDrawer";
import { SearchInput } from "../../components/Button";
import { POS_ADMIN, rm, toSen, useAdminCashiers, useAdminEvents, useAdminItems, useAdminTerminals, type PosEvent } from "./posAdminApi";
import { Empty, Field, Pill, Table, Toggle, errText, ghostBtn, inputCls, primaryBtn, td, th } from "./posAdminUi";

const statusTone = (s: PosEvent["status"]): "ok" | "info" | "muted" => (s === "ON GOING" ? "ok" : s === "COMING" ? "info" : "muted");
type Chip = "ALL" | "COMING" | "ON GOING" | "DONE";
const CHIPS: { value: Chip; label: string }[] = [{ value: "ALL", label: "All" }, { value: "COMING", label: "Coming" }, { value: "ON GOING", label: "On going" }, { value: "DONE", label: "Done" }];

/** Coming and on-going fairs first (soonest start first), then done ones (latest first). */
export function orderEvents<T extends { status: PosEvent["status"]; start_date: string | null }>(rows: readonly T[]): T[] {
  const rank = (s: PosEvent["status"]) => (s === "ON GOING" ? 0 : s === "COMING" ? 1 : 2);
  return [...rows].sort((a, b) => {
    const r = rank(a.status) - rank(b.status);
    if (r !== 0) return r;
    const da = a.start_date ?? "";
    const db = b.start_date ?? "";
    return a.status === "DONE" ? db.localeCompare(da) : da.localeCompare(db);
  });
}

export function PosEventsTab() {
  const toast = useToast();
  const dialog = useDialog();
  const events = useAdminEvents();
  const [editing, setEditing] = useState<PosEvent | null>(null);
  const [linking, setLinking] = useState(false);
  const [chip, setChip] = useState<Chip>("ALL");
  const rows = useMemo(() => orderEvents((events.data ?? []).filter((e) => chip === "ALL" || e.status === chip)), [events.data, chip]);
  const counts = useMemo(() => { const c = { ALL: 0, COMING: 0, "ON GOING": 0, DONE: 0 } as Record<Chip, number>; for (const e of events.data ?? []) { c.ALL += 1; c[e.status] += 1; } return c; }, [events.data]);

  async function push(e: PosEvent) {
    try {
      const res = await api.post<{ catalog_version: number }>(`${POS_ADMIN}/events/${e.project_id}/push`, {});
      toast.success(`Catalog v${res.catalog_version} pushed; terminals pick it up on their next heartbeat`);
      events.reload();
    } catch (err) {
      toast.error(errText(err, "Could not push the catalog."));
    }
  }
  async function unlink(e: PosEvent) {
    if (!(await dialog.confirm({ title: `Unlink ${e.name} from POS?`, message: "Its terminals are released and its cashier tiles disappear on the next sync. Synced bills stay on the project.", confirmLabel: "Unlink", danger: true }))) return;
    try {
      await api.del(`${POS_ADMIN}/events/${e.project_id}`);
      toast.success("Unlinked");
      events.reload();
    } catch (err) {
      toast.error(errText(err, "Could not unlink."));
    }
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="flex gap-1">
          {CHIPS.map((c) => <button key={c.value} type="button" className={cn(ghostBtn, chip === c.value && "border-accent bg-accent/10 text-accent")} onClick={() => setChip(c.value)}>{c.label} <span className="text-ink-muted">{counts[c.value]}</span></button>)}
        </span>
        <span className="text-[11px] text-ink-muted">Cash & Carry projects and the fairs of the booth brands (General tab) are listed on their own; pick a row to set it up for the booth.</span>
        <span className="ml-auto"><button type="button" className={ghostBtn} onClick={() => setLinking(true)} title="Find an older project by name"><Link2 size={11} /> Older project</button></span>
      </div>
      {events.loading && !events.data && <div className="text-[11px] text-ink-muted">Loading events…</div>}
      {events.error && <div className="rounded-md border border-err/40 bg-err/5 p-2 text-[11px] text-err">{events.error}</div>}
      {events.data && rows.length === 0 && <Empty>{chip === "ALL" ? "No recent or coming fair. Create the project under Projects first; it appears here on its own." : "Nothing in this group."}</Empty>}
      {rows.length > 0 && (
        <Table minWidth={1040} head={<>
          <th className={th}>Project</th><th className={th}>Type</th><th className={th}>Dates</th><th className={th}>When</th><th className={th}>POS</th><th className={th}>Terminals</th><th className={th}>Cashiers</th><th className={th}>Catalog</th><th className={th} />
        </>}>
          {rows.map((e) => (
            <tr key={e.project_id} className={cn("cursor-pointer border-t border-border-subtle hover:bg-bg/40", e.status === "DONE" && !e.linked && "opacity-60")} onClick={() => setEditing(e)}>
              <td className={td}><div className="font-semibold text-ink">{e.name}</div><div className="font-mono text-[9.5px] text-ink-muted">{e.code ?? ""}{e.venue ? ` · ${e.venue}` : ""}</div></td>
              <td className={td}>{e.event_type_name ?? e.type_label}</td>
              <td className={cn(td, "font-mono text-[10.5px] text-ink-secondary")}>{e.start_date ? formatDate(e.start_date) : "--"}{e.end_date ? ` - ${formatDate(e.end_date)}` : ""}</td>
              <td className={td}><Pill tone={statusTone(e.status)}>{e.status}</Pill></td>
              <td className={td}>{e.linked ? <Pill tone="ok">LINKED</Pill> : <Pill tone="warn">NOT LINKED</Pill>}</td>
              <td className={cn(td, "text-[10.5px]")}>
                {e.terminals.length === 0 ? <span className="text-ink-muted">none</span> : e.terminals.map((t) => (
                  <div key={t.id}><span className="font-mono">{t.code}</span> {t.prepared_at ? <Pill tone="ok">PAIRED</Pill> : <Pill tone="warn">NOT PAIRED</Pill>}{t.last_sync_at && <span className="ml-1 text-ink-muted">sync {formatDateTime(t.last_sync_at)}</span>}</div>
                ))}
              </td>
              <td className={cn(td, "text-[10.5px]")}>{e.link ? (e.link.cashiers.length === 0 ? <span className="text-amber-800">none assigned</span> : e.link.cashiers.map((c) => c.name).join(", ")) : <span className="text-ink-muted">--</span>}</td>
              <td className={cn(td, "font-mono text-[10.5px]")}>{e.link ? <>v{e.link.catalog_version}{e.link.pushed_at && <div className="text-[9.5px] text-ink-muted">{formatDateTime(e.link.pushed_at)}</div>}</> : "--"}</td>
              <td className={cn(td, "whitespace-nowrap")} onClick={(ev) => ev.stopPropagation()}>
                {e.link
                  ? <span className="flex gap-1"><button type="button" className={ghostBtn} onClick={() => void push(e)} title="Push catalog update"><RefreshCw size={11} /> Push</button><button type="button" className={ghostBtn} onClick={() => void unlink(e)} title="Unlink"><Unlink size={11} /></button></span>
                  : <button type="button" className={primaryBtn} onClick={() => setEditing(e)}><Link2 size={11} /> Link to POS</button>}
              </td>
            </tr>
          ))}
        </Table>
      )}
      {editing && <EventDrawer event={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); events.reload(); }} />}
      {linking && <LinkProject onClose={() => setLinking(false)} onLinked={() => { setLinking(false); events.reload(); }} />}
    </div>
  );
}

type Draft = { catalog_scope: "ALL" | "PICK"; stock_source_warehouse_id: string; sst_default: boolean; receipt_header: string; cashier_ids: number[]; terminal_ids: number[]; item_ids: number[]; prices: Record<number, string> };

function EventDrawer({ event, onClose, onSaved }: { event: PosEvent; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const cashiers = useAdminCashiers();
  const terminals = useAdminTerminals();
  const items = useAdminItems();
  const warehouses = useWarehouses();
  const [itemSearch, setItemSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [d, setD] = useState<Draft>(() => ({
    catalog_scope: event.link?.catalog_scope ?? "ALL",
    stock_source_warehouse_id: event.link?.stock_source_warehouse_id ?? "",
    sst_default: event.link?.sst_default ?? false,
    receipt_header: event.link?.receipt_header ?? "",
    cashier_ids: event.link?.cashiers.map((c) => c.id) ?? [],
    terminal_ids: event.terminals.map((t) => t.id),
    item_ids: event.link?.item_ids ?? [],
    prices: Object.fromEntries((event.link?.price_overrides ?? []).map((p) => [p.pos_item_id, rm(p.price_sen)])),
  }));
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }));
  const visibleItems = useMemo(() => {
    const q = itemSearch.trim().toLowerCase();
    return (items.data ?? []).filter((i) => i.active && (!q || i.item_code.toLowerCase().includes(q) || i.name.toLowerCase().includes(q)));
  }, [items.data, itemSearch]);
  const freeTerminals = (terminals.data ?? []).filter((t) => t.active && (t.project_id == null || t.project_id === event.project_id));

  async function save() {
    setSaving(true);
    try {
      const price_overrides = Object.entries(d.prices).flatMap(([id, v]) => { const sen = toSen(v); return sen == null ? [] : [{ pos_item_id: Number(id), price_sen: sen }]; });
      await api.put(`${POS_ADMIN}/events/${event.project_id}`, {
        catalog_scope: d.catalog_scope, stock_source_warehouse_id: d.stock_source_warehouse_id || null, sst_default: d.sst_default, receipt_header: d.receipt_header.trim() || null,
        cashier_ids: d.cashier_ids, terminal_ids: d.terminal_ids, item_ids: d.catalog_scope === "PICK" ? d.item_ids : [], price_overrides,
      });
      toast.success("Event saved. Push catalog update to send it to prepared terminals.");
      onSaved();
    } catch (e) {
      toast.error(errText(e, "Could not save the event."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ResizableDrawer
      onClose={onClose}
      title={event.name}
      subtitle={`${event.type_label} · ${event.start_date ? formatDate(event.start_date) : ""}${event.end_date ? ` - ${formatDate(event.end_date)}` : ""}`}
      storageKey="pos-admin-event-drawer"
      defaultWidth={640}
      footer={<div className="flex justify-end gap-2"><button type="button" className={ghostBtn} onClick={onClose}>Cancel</button><button type="button" className={primaryBtn} disabled={saving} onClick={() => void save()}>{event.link ? "Save" : "Link & save"}</button></div>}
    >
      <div className="space-y-3 p-3">
        <Field label="Terminals" hint="A terminal serves one event at a time; pick the IDs the devices will choose in Device setup.">
          {freeTerminals.length === 0 ? <div className="text-[11px] text-ink-muted">No free terminal. Create one on the Terminals tab.</div> : (
            <div className="flex flex-wrap gap-1">
              {freeTerminals.map((t) => (
                <label key={t.id} className={cn("inline-flex cursor-pointer items-center gap-1 rounded border px-2 py-1 text-[11px]", d.terminal_ids.includes(t.id) ? "border-accent bg-accent-soft/60" : "border-border")}>
                  <input type="checkbox" className="hidden" checked={d.terminal_ids.includes(t.id)} onChange={(e) => set("terminal_ids", e.target.checked ? [...d.terminal_ids, t.id] : d.terminal_ids.filter((x) => x !== t.id))} />
                  <span className="font-mono font-semibold">{t.code}</span>{t.device_name ? ` ${t.device_name}` : ""}
                </label>
              ))}
            </div>
          )}
        </Field>
        <Field label="Cashiers assigned (= login tiles, max 8 shown)">
          {(cashiers.data ?? []).filter((c) => c.active).length === 0 ? <div className="text-[11px] text-ink-muted">No active cashier. Create them on the Cashiers tab.</div> : (
            <div className="max-h-40 overflow-y-auto rounded-md border border-border p-1">
              {(cashiers.data ?? []).filter((c) => c.active).map((c) => (
                <label key={c.id} className="flex items-center gap-2 px-1 py-0.5 text-[11.5px]">
                  <input type="checkbox" checked={d.cashier_ids.includes(c.id)} onChange={(e) => set("cashier_ids", e.target.checked ? [...d.cashier_ids, c.id] : d.cashier_ids.filter((x) => x !== c.id))} />
                  <span className="font-mono text-[10px]">{c.code}</span> {c.name} {c.role === "SUPERVISOR" && <Pill tone="info">SUPERVISOR</Pill>}
                </label>
              ))}
            </div>
          )}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Catalog scope">
            <select className={inputCls} value={d.catalog_scope} onChange={(e) => set("catalog_scope", e.target.value as Draft["catalog_scope"])}>
              <option value="ALL">All active POS items</option><option value="PICK">Pick list</option>
            </select>
          </Field>
          <Field label="Stock source" hint="Booth allocation warehouse; blank = the POS store in General">
            <select className={inputCls} value={d.stock_source_warehouse_id} onChange={(e) => set("stock_source_warehouse_id", e.target.value)}>
              <option value="">POS store (General)</option>
              {(warehouses.data ?? []).filter((w) => w.is_active).map((w) => <option key={w.id} value={w.id}>{w.code} {w.name}</option>)}
            </select>
          </Field>
        </div>
        <Toggle checked={d.sst_default} onChange={(v) => set("sst_default", v)} label="SST ticked by default on this event's bills" hint="The cashier can still untick per bill." />
        <Field label="Receipt header line for this event" hint="Printed in place of {event name}; blank = the project name"><input className={inputCls} value={d.receipt_header} onChange={(e) => set("receipt_header", e.target.value)} /></Field>
        <Field label={d.catalog_scope === "PICK" ? "Pick list and event prices" : "Event price overrides"} hint="Leave a price blank to sell at the POS item price.">
          <SearchInput value={itemSearch} onChange={setItemSearch} placeholder="Filter items" widthClassName="w-full" aria-label="Filter POS items" />
          <div className="mt-1 max-h-64 overflow-y-auto rounded-md border border-border">
            <table className="w-full">
              <tbody>
                {visibleItems.map((i) => (
                  <tr key={i.id} className="border-t border-border-subtle text-[11.5px]">
                    {d.catalog_scope === "PICK" && <td className="w-6 px-1"><input type="checkbox" checked={d.item_ids.includes(i.id)} onChange={(e) => set("item_ids", e.target.checked ? [...d.item_ids, i.id] : d.item_ids.filter((x) => x !== i.id))} aria-label={`Include ${i.item_code}`} /></td>}
                    <td className="px-1 py-0.5 font-mono text-[10.5px]">{i.item_code}</td>
                    <td className="px-1 py-0.5">{i.name}</td>
                    <td className="px-1 py-0.5 text-right font-mono text-ink-muted">{fmtSen(i.price_sen)}</td>
                    <td className="w-28 px-1 py-0.5"><input className={cn(inputCls, "h-6 text-right")} placeholder="event RM" inputMode="decimal" value={d.prices[i.id] ?? ""} onChange={(e) => set("prices", { ...d.prices, [i.id]: e.target.value })} aria-label={`Event price for ${i.item_code}`} /></td>
                  </tr>
                ))}
                {visibleItems.length === 0 && <tr><td className="px-2 py-2 text-[11px] text-ink-muted">No active POS item{itemSearch ? " matches" : " yet (POS Items tab)"}.</td></tr>}
              </tbody>
            </table>
          </div>
        </Field>
      </div>
    </ResizableDrawer>
  );
}

function LinkProject({ onClose, onLinked }: { onClose: () => void; onLinked: () => void }) {
  const toast = useToast();
  const [q, setQ] = useState("");
  const [found, setFound] = useState<{ project_id: number; code: string | null; name: string; start_date: string | null; end_date: string | null; event_type_name: string | null }[]>([]);
  const [busy, setBusy] = useState<number | null>(null);

  async function search(term: string) {
    setQ(term);
    if (term.trim().length < 2) { setFound([]); return; }
    try {
      const res = await api.get<{ data: typeof found }>(`${POS_ADMIN}/events/candidates?q=${encodeURIComponent(term.trim())}`);
      setFound(Array.isArray(res.data) ? res.data : []);
    } catch (e) {
      toast.error(errText(e, "Search failed."));
    }
  }
  async function link(pid: number) {
    setBusy(pid);
    try {
      await api.put(`${POS_ADMIN}/events/${pid}`, { catalog_scope: "ALL" });
      toast.success("Project linked. Open it to assign terminals and cashiers.");
      onLinked();
    } catch (e) {
      toast.error(errText(e, "Could not link the project."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <ResizableDrawer onClose={onClose} title="Link a project to POS" subtitle="Search by project name or code" storageKey="pos-admin-link-project" defaultWidth={520}>
      <div className="space-y-2 p-3">
        <SearchInput value={q} onChange={(v) => void search(v)} placeholder="Type at least 2 characters" widthClassName="w-full" autoFocus aria-label="Search projects" />
        {found.map((p) => (
          <div key={p.project_id} className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-[11.5px]">
            <div className="flex-1"><div className="font-semibold">{p.name}</div><div className="font-mono text-[9.5px] text-ink-muted">{p.code ?? ""} {p.event_type_name ?? ""} {p.start_date ? formatDate(p.start_date) : ""}</div></div>
            <button type="button" className={primaryBtn} disabled={busy === p.project_id} onClick={() => void link(p.project_id)}><Link2 size={11} /> Link</button>
          </div>
        ))}
        {q.trim().length >= 2 && found.length === 0 && <Empty>No project matches.</Empty>}
      </div>
    </ResizableDrawer>
  );
}
