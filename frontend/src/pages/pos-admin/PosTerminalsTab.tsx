/* POS Admin > Terminals (layout E5): the terminal IDs a device picks once in
 * Device setup. ID, device name, platform, event, printer, prepared, last
 * seen, app version, active; + New terminal; Deactivate. "Prepare" happens
 * on the device itself (P15) — this tab only hands out the ID. */
import { useState } from "react";
import { Plus } from "lucide-react";
import { api } from "../../api/client";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import { cn, formatDateTime } from "../../lib/utils";
import { fmtSen } from "../../vendor/shared/format";
import { POS_ADMIN, useAdminEvents, useAdminTerminals, type PosTerminal } from "./posAdminApi";
import { Empty, Pill, Table, errText, ghostBtn, inputCls, primaryBtn, td, th } from "./posAdminUi";

export function PosTerminalsTab() {
  const toast = useToast();
  const dialog = useDialog();
  const terminals = useAdminTerminals();
  const events = useAdminEvents();
  const [adding, setAdding] = useState(false);
  const [code, setCode] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [platform, setPlatform] = useState("Android tablet");
  const [showInactive, setShowInactive] = useState(false);
  const rows = (terminals.data ?? []).filter((t) => showInactive || t.active);
  const linkedEvents = (events.data ?? []).filter((e) => e.link);

  async function create() {
    try {
      const res = await api.post<{ code: string }>(`${POS_ADMIN}/terminals`, { code: code.trim() || undefined, device_name: deviceName.trim() || null, platform });
      toast.success(`Terminal ${res.code} created. Pick it in the device's Device setup.`);
      setAdding(false); setCode(""); setDeviceName("");
      terminals.reload();
    } catch (e) {
      toast.error(errText(e, "Could not create the terminal."));
    }
  }
  async function patch(t: PosTerminal, body: Record<string, unknown>, done: string) {
    try {
      await api.patch(`${POS_ADMIN}/terminals/${t.id}`, body);
      toast.success(done);
      terminals.reload();
    } catch (e) {
      toast.error(errText(e, "Could not update the terminal."));
    }
  }
  async function deactivate(t: PosTerminal) {
    if (t.pending_count > 0 && !(await dialog.confirm({ title: `${t.code} still has ${t.pending_count} unsynced bill(s)`, message: "Deactivating does not delete them from the device, but the ERP stops expecting them. Sync the device first if you can.", confirmLabel: "Deactivate anyway", danger: true }))) return;
    await patch(t, { active: false }, `${t.code} deactivated`);
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1 text-[11px] text-ink-secondary"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show inactive</label>
        <span className="ml-auto"><button type="button" className={primaryBtn} onClick={() => setAdding((v) => !v)}><Plus size={11} /> New terminal</button></span>
      </div>
      {adding && (
        <div className="mb-2 flex flex-wrap items-end gap-2 rounded-md border border-border-subtle bg-bg/30 p-2">
          <label className="text-[10.5px] font-semibold uppercase text-ink-secondary">ID<input className={cn(inputCls, "mt-1 w-24")} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="T01 (auto)" /></label>
          <label className="text-[10.5px] font-semibold uppercase text-ink-secondary">Device name<input className={cn(inputCls, "mt-1 w-48")} value={deviceName} onChange={(e) => setDeviceName(e.target.value)} placeholder="Samsung Tab A9 #1" /></label>
          <label className="text-[10.5px] font-semibold uppercase text-ink-secondary">Platform
            <select className={cn(inputCls, "mt-1 w-40")} value={platform} onChange={(e) => setPlatform(e.target.value)}>
              <option>Android tablet</option><option>Windows laptop</option><option>iPad</option><option>Other</option>
            </select>
          </label>
          <button type="button" className={primaryBtn} onClick={() => void create()}>Create</button>
          <button type="button" className={ghostBtn} onClick={() => setAdding(false)}>Cancel</button>
        </div>
      )}
      {terminals.loading && !terminals.data && <div className="text-[11px] text-ink-muted">Loading terminals…</div>}
      {terminals.error && <div className="rounded-md border border-err/40 bg-err/5 p-2 text-[11px] text-err">{terminals.error}</div>}
      {terminals.data && rows.length === 0 && <Empty>No terminal yet. Create T01 for the first device; the device picks it in Device setup.</Empty>}
      {rows.length > 0 && (
        <Table minWidth={1040} head={<>
          <th className={th}>ID</th><th className={th}>Device</th><th className={th}>Platform</th><th className={th}>Event</th><th className={th}>Printer</th><th className={th}>Prepared</th><th className={th}>Last seen</th><th className={th}>Last sync</th><th className={cn(th, "text-right")}>Pending</th><th className={th}>App</th><th className={th}>Status</th><th className={th} />
        </>}>
          {rows.map((t) => (
            <tr key={t.id} className="border-t border-border-subtle">
              <td className={cn(td, "font-mono font-semibold text-accent")}>{t.code}</td>
              <td className={td}><input className={cn(inputCls, "h-7")} defaultValue={t.device_name ?? ""} onBlur={(e) => { if (e.target.value !== (t.device_name ?? "")) void patch(t, { device_name: e.target.value }, "Device name saved"); }} aria-label={`Device name of ${t.code}`} /></td>
              <td className={cn(td, "text-[10.5px]")}>{t.platform ?? "--"}</td>
              <td className={td}>
                <select className={cn(inputCls, "h-7")} value={t.project_id ?? ""} onChange={(e) => void patch(t, { project_id: e.target.value ? Number(e.target.value) : null }, "Event set")} aria-label={`Event of ${t.code}`}>
                  <option value="">none</option>
                  {linkedEvents.map((e) => <option key={e.project_id} value={e.project_id}>{e.name}</option>)}
                  {t.project_id != null && !linkedEvents.some((e) => e.project_id === t.project_id) && <option value={t.project_id}>{t.project_name ?? `#${t.project_id}`}</option>}
                </select>
              </td>
              <td className={cn(td, "text-[10.5px]")}>{t.printer ?? "--"}</td>
              <td className={cn(td, "text-[10.5px]")}>{t.prepared_at ? formatDateTime(t.prepared_at) : <Pill tone="warn">NOT YET</Pill>}</td>
              <td className={cn(td, "text-[10.5px] text-ink-muted")}>{t.last_seen_at ? formatDateTime(t.last_seen_at) : "--"}</td>
              <td className={cn(td, "text-[10.5px] text-ink-muted")}>{t.last_sync_at ? formatDateTime(t.last_sync_at) : "--"}</td>
              <td className={cn(td, "text-right font-mono", t.pending_count > 0 && "font-semibold text-amber-800")}>{t.pending_count}{t.pending_count > 0 && <div className="text-[9.5px]">{fmtSen(t.pending_amount_sen)}</div>}</td>
              <td className={cn(td, "font-mono text-[10px]")}>{t.app_version ?? "--"}</td>
              <td className={td}>{t.active ? <Pill tone={t.prepared_at ? "ok" : "muted"}>{t.status}</Pill> : <Pill tone="bad">INACTIVE</Pill>}</td>
              <td className={td}>{t.active ? <button type="button" className={ghostBtn} onClick={() => void deactivate(t)}>Deactivate</button> : <button type="button" className={ghostBtn} onClick={() => void patch(t, { active: true }, `${t.code} reactivated`)}>Reactivate</button>}</td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
