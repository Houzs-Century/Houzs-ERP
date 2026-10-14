/* POS Admin > SST & Receipt (layout E4, with a live 58 / 80 mm preview),
 * Printer & Scanner and General (layout E5). Each tab edits one settings
 * group and saves it whole; the device reads the same normalised document. */
import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { useToast } from "../../hooks/useToast";
import { cn, formatDateTime } from "../../lib/utils";
import { useWarehouses } from "../../vendor/scm/lib/inventory-queries";
import { POS_PAYMENT_METHODS, posMethodLabel } from "../../vendor/shared/pos-vocabulary";
import { type GeneralSettings, type PosSettingsGroup, type PrinterScannerSettings, type SstReceiptSettings } from "../../vendor/shared/pos-settings";
import { POS_ADMIN, useAdminSettings } from "./posAdminApi";
import { Field, Toggle, errText, ghostBtn, inputCls, primaryBtn } from "./posAdminUi";
import { SAMPLE_BILL, receiptPreviewLines } from "./receiptPreview";

function useGroup<G extends PosSettingsGroup, T>(group: G, pick: (s: NonNullable<ReturnType<typeof useAdminSettings>["data"]>["settings"]) => T) {
  const toast = useToast();
  const q = useAdminSettings();
  const [draft, setDraft] = useState<T | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (q.data && draft === null) setDraft(pick(q.data.settings)); }, [q.data, draft, pick]);
  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      await api.put(`${POS_ADMIN}/settings/${group}`, { value: draft });
      toast.success("Settings saved. Devices read them on their next sync.");
      q.reload();
    } catch (e) {
      toast.error(errText(e, "Could not save the settings."));
    } finally {
      setSaving(false);
    }
  }
  return { q, draft, setDraft, save, saving, reset: () => setDraft(q.data ? pick(q.data.settings) : null), updated: q.data?.updated[group] };
}

function SaveBar({ saving, onSave, onReset, updated }: { saving: boolean; onSave: () => void; onReset: () => void; updated?: string }) {
  return (
    <div className="mt-3 flex items-center gap-2 border-t border-border-subtle pt-3">
      <button type="button" className={primaryBtn} disabled={saving} onClick={onSave}>Save</button>
      <button type="button" className={ghostBtn} onClick={onReset}>Reset</button>
      {updated && <span className="ml-auto text-[10.5px] text-ink-muted">Last saved {formatDateTime(updated)}</span>}
    </div>
  );
}

const pickSst = (s: { sst_receipt: SstReceiptSettings }) => s.sst_receipt;
const pickPrinter = (s: { printer_scanner: PrinterScannerSettings }) => s.printer_scanner;
const pickGeneral = (s: { general: GeneralSettings }) => s.general;

export function PosSstReceiptTab() {
  const g = useGroup("sst_receipt", pickSst);
  const [previewSst, setPreviewSst] = useState(false);
  const d = g.draft;
  if (!d) return <div className="text-[11px] text-ink-muted">{g.q.error ?? "Loading settings…"}</div>;
  const set = <K extends keyof SstReceiptSettings>(k: K, v: SstReceiptSettings[K]) => g.setDraft({ ...d, [k]: v });
  const header = (i: number, v: string) => set("header_lines", d.header_lines.map((l, j) => (j === i ? v : l)));
  const lines = receiptPreviewLines(d, SAMPLE_BILL, previewSst);
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_auto]">
      <div className="space-y-4">
        <section>
          <h3 className="mb-2 text-[10.5px] font-bold uppercase tracking-wide text-ink-secondary">SST</h3>
          <div className="grid grid-cols-2 gap-3">
            <Field label="SST rate %"><input className={inputCls} inputMode="decimal" value={d.sst_rate} onChange={(e) => set("sst_rate", Number(e.target.value) || 0)} /></Field>
            <Field label="SST registration no" hint="Printed when SST is ticked"><input className={inputCls} value={d.sst_reg_no} onChange={(e) => set("sst_reg_no", e.target.value)} /></Field>
          </div>
          <Toggle checked={d.sst_default_on} onChange={(v) => set("sst_default_on", v)} label="SST ticked by default on a new bill" hint="Spec: unticked. SST is never automatic; the cashier ticks per bill." />
          <Toggle checked={d.show_sst_when_zero} onChange={(v) => set("show_sst_when_zero", v)} label="Print the SST line as 0.00 when unticked" />
          <Toggle checked={d.price_includes_sst} onChange={(v) => set("price_includes_sst", v)} label="Prices include SST" hint="Off: SST is added on top of the sub total." />
        </section>
        <section>
          <h3 className="mb-2 text-[10.5px] font-bold uppercase tracking-wide text-ink-secondary">Receipt</h3>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Title"><input className={inputCls} value={d.receipt_title} onChange={(e) => set("receipt_title", e.target.value)} /></Field>
            <Field label="Paper width">
              <select className={inputCls} value={d.paper_width} onChange={(e) => set("paper_width", Number(e.target.value) === 80 ? 80 : 58)}><option value={58}>58 mm</option><option value={80}>80 mm</option></select>
            </Field>
            <Field label="Header line 1" hint="{event name} = the event's receipt header or project name"><input className={inputCls} value={d.header_lines[0] ?? ""} onChange={(e) => header(0, e.target.value)} /></Field>
            <Field label="Header line 2"><input className={inputCls} value={d.header_lines[1] ?? ""} onChange={(e) => header(1, e.target.value)} /></Field>
            <Field label="Header line 3"><input className={inputCls} value={d.header_lines[2] ?? ""} onChange={(e) => header(2, e.target.value)} /></Field>
            <Field label="Copies"><input className={inputCls} type="number" min={1} max={3} value={d.copies} onChange={(e) => set("copies", Math.max(1, Math.min(3, Number(e.target.value) || 1)))} /></Field>
          </div>
          <Field label="Footer" className="mt-3"><textarea className={cn(inputCls, "h-16 py-1")} value={d.footer} onChange={(e) => set("footer", e.target.value)} /></Field>
          <Toggle checked={d.rounding_on_cash} onChange={(v) => set("rounding_on_cash", v)} label="Round to 5 sen on cash" hint="Only when Cash is enabled in General." />
          <Toggle checked={d.print_receipt_barcode} onChange={(v) => set("print_receipt_barcode", v)} label="Print the receipt-no barcode (Code 128)" hint="Scanned for reprint, return and exchange." />
          <Toggle checked={d.show_salesman} onChange={(v) => set("show_salesman", v)} label="Show salesman" />
          <Toggle checked={d.show_cashier} onChange={(v) => set("show_cashier", v)} label="Show cashier" />
        </section>
        <SaveBar saving={g.saving} onSave={() => void g.save()} onReset={g.reset} updated={g.updated} />
      </div>
      <div className="lg:w-[330px]">
        <div className="mb-1 flex items-center gap-2 text-[10.5px] font-bold uppercase tracking-wide text-ink-secondary">
          Live preview · {d.paper_width} mm
          <label className="ml-auto flex items-center gap-1 font-normal normal-case tracking-normal"><input type="checkbox" checked={previewSst} onChange={(e) => setPreviewSst(e.target.checked)} /> SST ticked</label>
        </div>
        <pre className="overflow-x-auto rounded-md border border-border bg-white p-3 font-mono text-[10.5px] leading-[1.25] text-black shadow-stone" style={{ width: d.paper_width === 80 ? 330 : 240 }}>{lines.join("\n")}</pre>
        <div className="mt-1 text-[10px] text-ink-muted">Sample bill. "Test print" to a terminal arrives with the printer step; until then, print from the device's Device setup.</div>
      </div>
    </div>
  );
}

export function PosPrinterScannerTab() {
  const g = useGroup("printer_scanner", pickPrinter);
  const d = g.draft;
  if (!d) return <div className="text-[11px] text-ink-muted">{g.q.error ?? "Loading settings…"}</div>;
  const set = <K extends keyof PrinterScannerSettings>(k: K, v: PrinterScannerSettings[K]) => g.setDraft({ ...d, [k]: v });
  return (
    <div className="max-w-xl space-y-4">
      <section>
        <h3 className="mb-2 text-[10.5px] font-bold uppercase tracking-wide text-ink-secondary">Printer (ESC/POS)</h3>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Connection">
            <select className={inputCls} value={d.connection} onChange={(e) => set("connection", e.target.value as PrinterScannerSettings["connection"])}>
              <option value="ANY">Bluetooth or USB</option><option value="BLUETOOTH">Bluetooth only</option><option value="USB">USB only</option>
            </select>
          </Field>
          <Field label="Default paper"><select className={inputCls} value={d.default_paper} onChange={(e) => set("default_paper", Number(e.target.value) === 80 ? 80 : 58)}><option value={58}>58 mm</option><option value={80}>80 mm</option></select></Field>
          <Field label="When the printer is unavailable" hint="The sale is saved either way.">
            <select className={inputCls} value={d.on_printer_unavailable} onChange={(e) => set("on_printer_unavailable", e.target.value as PrinterScannerSettings["on_printer_unavailable"])}>
              <option value="ASK">Ask: Skip print / Reconnect / Retry</option><option value="SKIP">Skip the print silently</option>
            </select>
          </Field>
        </div>
        <Field label="Tested printer models (one per line)" className="mt-3"><textarea className={cn(inputCls, "h-20 py-1")} value={d.tested_models.join("\n")} onChange={(e) => set("tested_models", e.target.value.split("\n").map((s) => s.trim()).filter(Boolean))} placeholder="e.g. Xprinter XP-P323B" /></Field>
      </section>
      <section>
        <h3 className="mb-2 text-[10.5px] font-bold uppercase tracking-wide text-ink-secondary">Scanner (HID keyboard mode, no configuration on the device)</h3>
        <Toggle checked={d.scanner_enter_suffix} onChange={(v) => set("scanner_enter_suffix", v)} label="Scanner sends Enter after the barcode" hint="Set the scanner to add a CR/Enter suffix; the POS adds the item on Enter." />
        <Toggle checked={d.beep} onChange={(v) => set("beep", v)} label="Beep on a successful scan" />
        <Toggle checked={d.same_barcode_adds_qty} onChange={(v) => set("same_barcode_adds_qty", v)} label="Scanning the same barcode again adds +1 qty" hint="Off: a second scan adds a new line." />
      </section>
      <SaveBar saving={g.saving} onSave={() => void g.save()} onReset={g.reset} updated={g.updated} />
    </div>
  );
}

export function PosGeneralTab() {
  const g = useGroup("general", pickGeneral);
  const warehouses = useWarehouses();
  const d = g.draft;
  if (!d) return <div className="text-[11px] text-ink-muted">{g.q.error ?? "Loading settings…"}</div>;
  const set = <K extends keyof GeneralSettings>(k: K, v: GeneralSettings[K]) => g.setDraft({ ...d, [k]: v });
  return (
    <div className="max-w-xl space-y-4">
      <section>
        <h3 className="mb-2 text-[10.5px] font-bold uppercase tracking-wide text-ink-secondary">Payment methods enabled</h3>
        {POS_PAYMENT_METHODS.map((m) => (
          <Toggle key={m} checked={d.payment_methods[m]} onChange={(v) => set("payment_methods", { ...d.payment_methods, [m]: v })} label={posMethodLabel(m)} hint={m === "CASH" ? "Off by default: fairs are cashless. On shows a Cash button, tendered keypad, rounding and change." : undefined} />
        ))}
      </section>
      <section>
        <h3 className="mb-2 text-[10.5px] font-bold uppercase tracking-wide text-ink-secondary">Selling</h3>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Idle auto-logout (minutes)"><input className={inputCls} type="number" min={1} max={240} value={d.idle_logout_minutes} onChange={(e) => set("idle_logout_minutes", Math.max(1, Number(e.target.value) || 15))} /></Field>
          <Field label="Price override"><select className={inputCls} value={d.price_override} onChange={(e) => set("price_override", e.target.value as GeneralSettings["price_override"])}><option value="SUPERVISOR">Supervisor PIN only</option><option value="OFF">Off</option></select></Field>
          <Field label="Void rule"><select className={inputCls} value={d.void_rule} onChange={(e) => set("void_rule", e.target.value as GeneralSettings["void_rule"])}><option value="SUPERVISOR_ANY_TIME">Supervisor, any time</option><option value="SUPERVISOR_SAME_DAY">Supervisor, same day only</option></select></Field>
          <Field label="Return / exchange window"><select className={inputCls} value={d.return_window} onChange={(e) => set("return_window", e.target.value as GeneralSettings["return_window"])}><option value="EVENT">Any day within the event</option><option value="SAME_DAY">Same day only</option></select></Field>
          <Field label="Receipt no format" hint="{TERM} = terminal ID, {000000} = running number"><input className={inputCls} value={d.receipt_no_format} onChange={(e) => set("receipt_no_format", e.target.value)} /></Field>
          <Field label="Customer field"><select className={inputCls} value={d.customer_field} onChange={(e) => set("customer_field", e.target.value as GeneralSettings["customer_field"])}><option value="OPTIONAL">Optional on the sell screen</option><option value="HIDDEN">Hidden</option></select></Field>
          <Field label="Main POS stock location" hint="Deducted when an event has no booth allocation" className="col-span-2">
            <select className={inputCls} value={d.pos_store_warehouse_id ?? ""} onChange={(e) => set("pos_store_warehouse_id", e.target.value || null)}>
              <option value="">Not set</option>
              {(warehouses.data ?? []).filter((w) => w.is_active).map((w) => <option key={w.id} value={w.id}>{w.code} {w.name}</option>)}
            </select>
          </Field>
        </div>
      </section>
      <section>
        <h3 className="mb-2 text-[10.5px] font-bold uppercase tracking-wide text-ink-secondary">Monitoring and alerts</h3>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Alert when pending for more than (days)"><input className={inputCls} type="number" min={1} value={d.alert_pending_days} onChange={(e) => set("alert_pending_days", Math.max(1, Number(e.target.value) || 3))} /></Field>
          <Field label="Alert after event end + (days)"><input className={inputCls} type="number" min={0} value={d.alert_event_end_days} onChange={(e) => set("alert_event_end_days", Math.max(0, Number(e.target.value) || 0))} /></Field>
          <Field label="Alert email"><input className={inputCls} type="email" value={d.alert_email} onChange={(e) => set("alert_email", e.target.value)} /></Field>
          <Field label="Heartbeat every (minutes)"><input className={inputCls} type="number" min={1} max={60} value={d.heartbeat_minutes} onChange={(e) => set("heartbeat_minutes", Math.max(1, Number(e.target.value) || 5))} /></Field>
        </div>
        <Toggle checked={d.daily_summary_email} onChange={(v) => set("daily_summary_email", v)} label="Daily summary email" hint="Off: only the one end-of-event summary is sent." />
      </section>
      <SaveBar saving={g.saving} onSave={() => void g.save()} onReset={g.reset} updated={g.updated} />
    </div>
  );
}
