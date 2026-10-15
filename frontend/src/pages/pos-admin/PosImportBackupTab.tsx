/* POS Admin > Import backup (layout E8): drop houzs_pos_T0x_backup.json from
 * a device, the ERP opens it with that terminal's key, classifies every
 * receipt (NEW / UPDATE / DUPLICATE / CONFLICT / INVALID), shows the preview,
 * and imports NEW + UPDATE through the same path the device sync uses, so
 * stock and the audit trail come out the same. Nothing is written until
 * Import is pressed. */
import { useRef, useState } from "react";
import { Upload } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api } from "../../api/client";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import { cn, formatDateTime } from "../../lib/utils";
import { fmtSen } from "../../vendor/shared/format";
import { POS_ADMIN, type BackupImportResult, type BackupPreview, type BackupRowKind } from "./posAdminApi";
import { Empty, Pill, Table, errText, ghostBtn, primaryBtn, td, th } from "./posAdminUi";

export const kindTone = (k: BackupRowKind): "ok" | "info" | "muted" | "bad" | "warn" => (k === "NEW" ? "ok" : k === "UPDATE" ? "info" : k === "DUPLICATE" ? "muted" : k === "CONFLICT" ? "bad" : "warn");

/** Read the dropped file as JSON, or say why not. */
export async function readBackupFile(file: File): Promise<{ ok: true; json: unknown } | { ok: false; reason: string }> {
  if (file.size > 25 * 1024 * 1024) return { ok: false, reason: "The file is larger than 25 MB; that is not a POS backup." };
  try {
    return { ok: true, json: JSON.parse(await file.text()) as unknown };
  } catch {
    return { ok: false, reason: "The file is not JSON. Use the houzs_pos_T0x_backup.json the device wrote." };
  }
}

export function PosImportBackupTab() {
  const toast = useToast();
  const dialog = useDialog();
  const nav = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const [fileJson, setFileJson] = useState<unknown>(null);
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<BackupPreview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BackupImportResult | null>(null);
  const [dragging, setDragging] = useState(false);

  async function take(file: File) {
    setBusy(true); setPreview(null); setResult(null); setProblem(null); setFileName(file.name);
    const read = await readBackupFile(file);
    if (!read.ok) { setProblem(read.reason); setBusy(false); return; }
    setFileJson(read.json);
    try {
      setPreview(await api.post<BackupPreview>(`${POS_ADMIN}/backup/preview`, { file: read.json }));
    } catch (e) {
      setProblem(errText(e, "The ERP could not open this backup."));
    } finally {
      setBusy(false);
    }
  }
  async function doImport() {
    if (!preview || !fileJson) return;
    const n = preview.summary.new + preview.summary.update;
    if (n === 0) { toast.info("Nothing to import: every receipt in the file is already in the ERP."); return; }
    const ok = await dialog.confirm({
      title: `Import ${preview.summary.new} new and ${preview.summary.update} updated receipt(s) from ${preview.terminal.code}?`,
      message: `${fmtSen(preview.summary.new_sen)} of new PAID sales will be added to the POS Sales list and deducted from stock, exactly as a device sync would. ${preview.summary.conflict} conflict(s) and ${preview.summary.duplicate} duplicate(s) are left untouched.`,
      confirmLabel: "Import",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await api.post<BackupImportResult>(`${POS_ADMIN}/backup/import`, { file: fileJson });
      setResult(r);
      toast.success(`Imported ${r.accepted} new, ${r.updated} updated${r.rejected.length ? `, ${r.rejected.length} rejected` : ""}`);
    } catch (e) {
      toast.error(errText(e, "Import failed; nothing was written."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div
        className={cn("mb-3 flex cursor-pointer flex-col items-center justify-center rounded-md border-2 border-dashed px-4 py-6 text-center text-[11.5px]", dragging ? "border-accent bg-accent/5" : "border-border bg-bg/30")}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files.item(0); if (f) void take(f); }}
        onClick={() => input.current?.click()}
        role="button" tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") input.current?.click(); }}
      >
        <Upload size={18} className="mb-1 text-ink-muted" />
        <div><b>Drop houzs_pos_T0x_backup.json here</b> or click to choose it.</div>
        <div className="text-ink-muted">The device writes it after every sale to the folder picked in Device setup, or download it from the sync panel. The file is encrypted; only this ERP can open it.</div>
        <input ref={input} type="file" accept=".json,application/json" className="hidden" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void take(f); }} />
      </div>
      {busy && !preview && <div className="text-[11px] text-ink-muted">Opening {fileName}…</div>}
      {problem && <div className="mb-2 rounded-md border border-err/40 bg-err/5 p-2 text-[11px] text-err">{problem}</div>}
      {preview && (
        <>
          <div className="mb-2 grid grid-cols-2 gap-2 text-[11px] md:grid-cols-4">
            <div className="rounded-md border border-border bg-surface px-3 py-2"><div className="font-mono text-[9.5px] uppercase text-ink-muted">Terminal</div><div className="font-semibold">{preview.terminal.code} {preview.terminal.device_name}</div><div className="text-ink-muted">{preview.file.event_name ?? `project #${preview.file.project_id}`}</div></div>
            <div className="rounded-md border border-border bg-surface px-3 py-2"><div className="font-mono text-[9.5px] uppercase text-ink-muted">File written</div><div className="font-semibold">{formatDateTime(preview.file.exported_at)}</div><div className="text-ink-muted">{preview.file.count} receipt(s), counter {preview.file.receipt_counter}</div></div>
            <div className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2"><div className="font-mono text-[9.5px] uppercase text-ink-muted">New</div><div className="text-[18px] font-semibold text-emerald-800">{preview.summary.new}</div><div className="text-ink-muted">{fmtSen(preview.summary.new_sen)} PAID · {preview.summary.update} update(s)</div></div>
            <div className={cn("rounded-md border px-3 py-2", preview.summary.conflict + preview.summary.invalid > 0 ? "border-rose-300 bg-rose-50" : "border-border bg-surface")}><div className="font-mono text-[9.5px] uppercase text-ink-muted">Left alone</div><div className="text-[18px] font-semibold">{preview.summary.duplicate + preview.summary.conflict + preview.summary.invalid}</div><div className="text-ink-muted">{preview.summary.duplicate} duplicate · {preview.summary.conflict} conflict · {preview.summary.invalid} invalid</div></div>
          </div>
          {preview.terminal.db_empty_at && <div className="mb-2 rounded-md border border-rose-400 bg-rose-50 p-2 text-[11px] text-rose-900">This terminal reported its local data lost on {formatDateTime(preview.terminal.db_empty_at)}. After importing, acknowledge the alert on Sync Status.</div>}
          <div className="mb-2 flex items-center gap-2">
            <button type="button" className={primaryBtn} disabled={busy || !!result || preview.summary.new + preview.summary.update === 0} onClick={() => void doImport()}>Import {preview.summary.new + preview.summary.update} receipt(s)</button>
            <button type="button" className={ghostBtn} onClick={() => { setPreview(null); setFileJson(null); setResult(null); }}>Clear</button>
            {result && <button type="button" className={ghostBtn} onClick={() => nav("/pos-admin?tab=sync")}>Open Sync Status</button>}
          </div>
          {result && (
            <div className="mb-2 rounded-md border border-emerald-300 bg-emerald-50 p-2 text-[11px] text-emerald-900">
              Imported: {result.accepted} new, {result.updated} updated. {result.rejected.length > 0 && <>Rejected: {result.rejected.map((r) => `${r.uuid.slice(0, 8)} (${r.reason ?? "?"})`).join(", ")}.</>}
            </div>
          )}
          {preview.rows.length === 0 && <Empty>The file holds no receipt.</Empty>}
          {preview.rows.length > 0 && (
            <Table minWidth={820} head={<>
              <th className={th}>Receipt</th><th className={th}>Type</th><th className={th}>Sold at</th><th className={th}>Cashier</th><th className={cn(th, "text-right")}>Total</th><th className={th}>Status</th><th className={th}>Import as</th><th className={th}>Note</th>
            </>}>
              {preview.rows.map((r) => (
                <tr key={r.uuid || r.receipt_no} className="border-t border-border-subtle">
                  <td className={cn(td, "font-mono")}>{r.receipt_no}</td>
                  <td className={td}>{r.type}</td>
                  <td className={cn(td, "text-[10.5px]")}>{r.sold_at ? formatDateTime(r.sold_at) : "--"}</td>
                  <td className={td}>{r.cashier_name}</td>
                  <td className={cn(td, "text-right font-mono")}>{fmtSen(r.total_sen)}</td>
                  <td className={td}><Pill tone={r.status === "VOID" ? "muted" : "ok"}>{r.status}</Pill></td>
                  <td className={td}><Pill tone={kindTone(r.kind)}>{r.kind}</Pill></td>
                  <td className={cn(td, "text-[10.5px] text-ink-muted")}>{r.reason ?? ""}</td>
                </tr>
              ))}
            </Table>
          )}
        </>
      )}
    </div>
  );
}
