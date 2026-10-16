/* POS Admin > Cashiers (layout E2): the part-timers who log in at the booth
 * with a name tile + PIN. Separate from ERP users: a cashier can never log
 * in to the ERP. ID, name, phone, role (Part-timer / Supervisor), PIN (set /
 * reset, never shown), max manual discount, events assigned (= the login
 * tiles), working hours / rate and bank notes (info only), active. */
import { useState } from "react";
import { KeyRound, Plus } from "lucide-react";
import { api } from "../../api/client";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import { cn, formatDateTime } from "../../lib/utils";
import { ResizableDrawer } from "../../components/ResizableDrawer";
import { POS_ADMIN, useAdminCashiers, useAdminEvents, type PosCashier } from "./posAdminApi";
import { Empty, Field, Pill, Table, Toggle, errText, ghostBtn, inputCls, primaryBtn, td, th } from "./posAdminUi";

type Draft = { code: string; name: string; phone: string; role: "PARTTIME" | "SUPERVISOR"; pin: string; pin2: string; max_discount_pct: string; working_hours_note: string; bank_note: string; event_ids: number[]; active: boolean };

const blank = (): Draft => ({ code: "", name: "", phone: "", role: "PARTTIME", pin: "", pin2: "", max_discount_pct: "0", working_hours_note: "", bank_note: "", event_ids: [], active: true });
const draftOf = (c: PosCashier): Draft => ({ code: c.code, name: c.name, phone: c.phone ?? "", role: c.role, pin: "", pin2: "", max_discount_pct: String(c.max_discount_pct), working_hours_note: c.working_hours_note ?? "", bank_note: c.bank_note ?? "", event_ids: c.events.map((e) => e.project_id), active: c.active });

export const PIN_RULE = "4 to 6 digits";
export const pinProblem = (pin: string, pin2: string, required: boolean): string | null => {
  if (!pin && !pin2) return required ? `PIN is required (${PIN_RULE})` : null;
  if (!/^\d{4,6}$/.test(pin)) return `PIN must be ${PIN_RULE}`;
  if (pin !== pin2) return "The two PINs differ";
  return null;
};

export function PosCashiersTab() {
  const toast = useToast();
  const dialog = useDialog();
  const cashiers = useAdminCashiers();
  const events = useAdminEvents();
  const [editing, setEditing] = useState<PosCashier | "new" | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const rows = (cashiers.data ?? []).filter((c) => showInactive || c.active);

  async function resetPin(c: PosCashier) {
    const pin = await dialog.prompt({ title: `New PIN for ${c.name}`, message: PIN_RULE, placeholder: "e.g. 2468", inputType: "number", required: true });
    if (pin == null) return;
    const problem = pinProblem(pin, pin, true);
    if (problem) { toast.error(problem); return; }
    try {
      await api.post(`${POS_ADMIN}/cashiers/${c.id}/pin`, { pin });
      toast.success(`PIN reset for ${c.name}. It reaches devices on their next sync.`);
    } catch (e) {
      toast.error(errText(e, "Could not reset the PIN."));
    }
  }

  async function setActive(c: PosCashier, active: boolean) {
    try {
      await api.patch(`${POS_ADMIN}/cashiers/${c.id}`, { active });
      toast.success(active ? `${c.name} is active` : `${c.name} deactivated; the tile disappears on the next sync`);
      cashiers.reload();
    } catch (e) {
      toast.error(errText(e, "Could not update the cashier."));
    }
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1 text-[11px] text-ink-secondary"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show inactive</label>
        <span className="ml-auto"><button type="button" className={primaryBtn} onClick={() => setEditing("new")}><Plus size={11} /> New cashier</button></span>
      </div>
      {cashiers.loading && !cashiers.data && <div className="text-[11px] text-ink-muted">Loading cashiers…</div>}
      {cashiers.error && <div className="rounded-md border border-err/40 bg-err/5 p-2 text-[11px] text-err">{cashiers.error}</div>}
      {cashiers.data && rows.length === 0 && <Empty>No cashiers yet. Create the part-timers before the event; each gets a name tile and a PIN on the POS.</Empty>}
      {rows.length > 0 && (
        <Table minWidth={900} head={<>
          <th className={th}>ID</th><th className={th}>Name</th><th className={th}>Phone</th><th className={th}>Role</th><th className={th}>PIN</th>
          <th className={cn(th, "text-right")}>Max manual disc</th><th className={th}>Events assigned</th><th className={th}>Last login</th><th className={th}>Active</th>
        </>}>
          {rows.map((c) => (
            <tr key={c.id} className="cursor-pointer border-t border-border-subtle hover:bg-bg/40" onClick={() => setEditing(c)}>
              <td className={cn(td, "font-mono text-[10.5px] font-semibold text-accent")}>{c.code}</td>
              <td className={td}>{c.name}</td>
              <td className={cn(td, "font-mono text-[10.5px]")}>{c.phone ?? "--"}</td>
              <td className={td}>{c.role === "SUPERVISOR" ? <Pill tone="info">SUPERVISOR</Pill> : <Pill tone="muted">PART-TIMER</Pill>}</td>
              <td className={td} onClick={(e) => e.stopPropagation()}><button type="button" className={ghostBtn} onClick={() => void resetPin(c)}><KeyRound size={11} /> Reset</button></td>
              <td className={cn(td, "text-right font-mono")}>{c.max_discount_pct}%</td>
              <td className={cn(td, "text-[10.5px]")}>{c.events.length === 0 ? <span className="text-ink-muted">none</span> : c.events.map((e) => e.name).join(", ")}</td>
              <td className={cn(td, "text-[10.5px] text-ink-muted")}>{c.last_login_at ? formatDateTime(c.last_login_at) : "--"}</td>
              <td className={td} onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={c.active} onChange={(e) => void setActive(c, e.target.checked)} aria-label={`${c.name} active`} /></td>
            </tr>
          ))}
        </Table>
      )}
      {editing && (
        <CashierDrawer
          cashier={editing === "new" ? null : editing}
          events={(events.data ?? []).filter((e) => e.link).map((e) => ({ id: e.project_id, name: e.name, status: e.status }))}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); cashiers.reload(); }}
        />
      )}
    </div>
  );
}

function CashierDrawer({ cashier, events, onClose, onSaved }: { cashier: PosCashier | null; events: { id: number; name: string; status: string }[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [d, setD] = useState<Draft>(() => (cashier ? draftOf(cashier) : blank()));
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }));
  const isNew = cashier === null;

  async function save() {
    if (!d.name.trim()) { toast.error("Name is required"); return; }
    const problem = pinProblem(d.pin, d.pin2, isNew);
    if (problem) { toast.error(problem); return; }
    setSaving(true);
    try {
      const body = { code: d.code.trim() || undefined, name: d.name.trim(), phone: d.phone.trim() || null, role: d.role, max_discount_pct: Number(d.max_discount_pct) || 0, working_hours_note: d.working_hours_note.trim() || null, bank_note: d.bank_note.trim() || null, event_ids: d.event_ids, active: d.active };
      if (isNew) {
        await api.post(`${POS_ADMIN}/cashiers`, { ...body, pin: d.pin });
      } else {
        await api.patch(`${POS_ADMIN}/cashiers/${cashier.id}`, body);
        if (d.pin) await api.post(`${POS_ADMIN}/cashiers/${cashier.id}/pin`, { pin: d.pin });
      }
      toast.success(isNew ? "Cashier created" : "Cashier saved");
      onSaved();
    } catch (e) {
      toast.error(errText(e, "Could not save the cashier."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ResizableDrawer
      onClose={onClose}
      title={isNew ? "New cashier" : <span><span className="font-mono">{cashier.code}</span> {cashier.name}</span>}
      subtitle="Part-timer account for the POS app. Never an ERP login."
      storageKey="pos-admin-cashier-drawer"
      defaultWidth={520}
      footer={<div className="flex justify-end gap-2"><button type="button" className={ghostBtn} onClick={onClose}>Cancel</button><button type="button" className={primaryBtn} disabled={saving} onClick={() => void save()}>{isNew ? "Create" : "Save"}</button></div>}
    >
      <div className="space-y-3 p-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Cashier ID" hint={isNew ? "Blank = next free (C01, C02 …)" : "Cannot change"}><input className={inputCls} value={d.code} disabled={!isNew} onChange={(e) => set("code", e.target.value.toUpperCase())} placeholder="C01" /></Field>
          <Field label="Role">
            <select className={inputCls} value={d.role} onChange={(e) => set("role", e.target.value as Draft["role"])}>
              <option value="PARTTIME">Part-timer (sell only)</option><option value="SUPERVISOR">Supervisor (void, return, overrides)</option>
            </select>
          </Field>
          <Field label="Name"><input className={inputCls} value={d.name} onChange={(e) => set("name", e.target.value)} autoFocus /></Field>
          <Field label="Phone"><input className={inputCls} value={d.phone} onChange={(e) => set("phone", e.target.value)} inputMode="tel" /></Field>
          <Field label={isNew ? "PIN" : "New PIN (blank = keep)"} hint={PIN_RULE}><input className={inputCls} value={d.pin} onChange={(e) => set("pin", e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" type="password" autoComplete="new-password" /></Field>
          <Field label="Confirm PIN"><input className={inputCls} value={d.pin2} onChange={(e) => set("pin2", e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" type="password" autoComplete="new-password" /></Field>
          <Field label="Max manual discount %" hint="Above this the POS asks for a supervisor PIN"><input className={inputCls} value={d.max_discount_pct} onChange={(e) => set("max_discount_pct", e.target.value)} inputMode="decimal" /></Field>
        </div>
        <Field label="Assign to events" hint="The cashier's tile shows on the terminals of these events">
          {events.length === 0 ? <div className="text-[11px] text-ink-muted">No event is linked to POS yet (Events tab).</div> : (
            <div className="max-h-40 overflow-y-auto rounded-md border border-border p-1">
              {events.map((e) => (
                <label key={e.id} className="flex items-center gap-2 px-1 py-0.5 text-[11.5px]">
                  <input type="checkbox" checked={d.event_ids.includes(e.id)} onChange={(ev) => set("event_ids", ev.target.checked ? [...d.event_ids, e.id] : d.event_ids.filter((x) => x !== e.id))} />
                  {e.name} <span className="text-[9.5px] text-ink-muted">{e.status}</span>
                </label>
              ))}
            </div>
          )}
        </Field>
        <Field label="Working hours / rate (info only)"><textarea className={cn(inputCls, "h-16 py-1")} value={d.working_hours_note} onChange={(e) => set("working_hours_note", e.target.value)} placeholder="e.g. 10am-10pm, RM 120/day" /></Field>
        <Field label="Bank (for payment later, info only)"><input className={inputCls} value={d.bank_note} onChange={(e) => set("bank_note", e.target.value)} placeholder="Bank, account no" /></Field>
        <Toggle checked={d.active} onChange={(v) => set("active", v)} label="Active" hint="An inactive cashier never appears on a login screen." />
      </div>
    </ResizableDrawer>
  );
}
