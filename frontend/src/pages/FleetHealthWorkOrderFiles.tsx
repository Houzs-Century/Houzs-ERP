/* Work-order files (HC-0031): the workshop quotation, invoice and photos kept
   ON the repair, so "what was fixed and what did it cost" can be checked
   against the paper later. Backend: /api/fleet-work-order-files. Own file
   because FleetHealth.tsx is near its size ceiling. */
import { useState } from "react";
import { X } from "lucide-react";
import { api } from "../api/client";

export type WorkOrderFileKind = "quote" | "invoice" | "photo";

const KINDS: Array<{ kind: WorkOrderFileKind; label: string; field: "quoteRefs" | "invoiceRefs" | "photoRefs" }> = [
  { kind: "quote", label: "Quotation", field: "quoteRefs" },
  { kind: "invoice", label: "Invoice", field: "invoiceRefs" },
  { kind: "photo", label: "Photos", field: "photoRefs" },
];
const ACCEPT = ".pdf,.jpg,.jpeg,.png,.webp,.heic";

/** The file name rides inside the server-minted key: <ms>-<name>.<ext>. */
export function fileLabel(key: string): string {
  const last = key.split("/").pop() ?? key;
  return last.replace(/^\d+-/, "");
}

export function WorkOrderFiles({ wo, onChanged }: {
  wo: { id: string; quoteRefs?: string[]; invoiceRefs?: string[]; photoRefs?: string[] };
  onChanged: () => void;
}) {
  const [kind, setKind] = useState<WorkOrderFileKind>("invoice");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const base = `/api/fleet-work-order-files/${wo.id}`;
  const fail = (e: unknown) => setErr(e instanceof Error ? e.message : "The file could not be saved.");

  const upload = async (files: File[]) => {
    if (busy || files.length === 0) return;
    setBusy(true); setErr(null);
    try {
      /* One at a time: the route appends to a refs array, so parallel uploads
         to the same work order could drop one. */
      for (const f of files) {
        const ext = (f.name.split(".").pop() || "").toLowerCase();
        await api.putBinary(`${base}?kind=${kind}&ext=${encodeURIComponent(ext)}&name=${encodeURIComponent(f.name)}`,
          f, f.type || "application/octet-stream");
      }
      onChanged();
    } catch (e) { fail(e); } finally { setBusy(false); }
  };

  const open = async (key: string) => {
    try { window.open(await api.fetchBlobUrl(`${base}/file?key=${encodeURIComponent(key)}`), "_blank", "noopener"); }
    catch (e) { fail(e); }
  };

  const remove = async (key: string) => {
    if (busy) return;
    setBusy(true); setErr(null);
    try { await api.del(`${base}?key=${encodeURIComponent(key)}`); onChanged(); }
    catch (e) { fail(e); } finally { setBusy(false); }
  };

  return (
    <div className="mt-2 rounded-md border border-border/70 bg-surface-2/30 p-2">
      <div className="text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">Documents</div>
      {KINDS.map(({ label, field }) => {
        const keys = wo[field] ?? [];
        if (keys.length === 0) return null;
        return (
          <div key={field} className="mt-1 flex flex-wrap items-center gap-1.5 text-[10.5px]">
            <span className="text-ink-muted">{label}:</span>
            {keys.map((k) => (
              <span key={k} className="inline-flex items-center gap-1 rounded border border-border bg-surface px-1.5 py-0.5">
                <button type="button" onClick={() => void open(k)} className="text-primary hover:underline">{fileLabel(k)}</button>
                <button type="button" disabled={busy} onClick={() => void remove(k)} className="text-ink-muted hover:text-err" aria-label={`Remove ${fileLabel(k)}`}>
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        );
      })}
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <select aria-label="Document type" value={kind} onChange={(e) => setKind(e.target.value as WorkOrderFileKind)}
          className="h-7 rounded border border-border bg-surface px-1.5 text-[11px]">
          {KINDS.map(({ kind: k, label }) => <option key={k} value={k}>{label}</option>)}
        </select>
        <input type="file" multiple accept={ACCEPT} disabled={busy} aria-label="Attach files"
          onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ""; void upload(fs); }}
          className="text-[11px] text-ink-secondary file:mr-2 file:rounded file:border file:border-border file:bg-surface-2 file:px-2 file:py-0.5 file:text-[11px]" />
        {busy && <span className="text-[10.5px] text-ink-muted">Saving...</span>}
      </div>
      {err && <div className="mt-1 text-[11px] text-err">{err}</div>}
    </div>
  );
}
