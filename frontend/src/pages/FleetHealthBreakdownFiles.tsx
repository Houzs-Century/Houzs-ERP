/* Breakdown & incident media: the scene photos and videos kept ON the case.
   Backend: /api/fleet-breakdown-files. Own file because FleetHealth.tsx is near
   its size ceiling. */
import { useState } from "react";
import { X } from "lucide-react";
import { api } from "../api/client";
import { fileLabel } from "./FleetHealthWorkOrderFiles";

export const BREAKDOWN_MEDIA_ACCEPT = ".jpg,.jpeg,.png,.webp,.heic,.mp4,.mov,.pdf";
const VIDEO_MAX_BYTES = 50 * 1024 * 1024;

/** Older mobile reports stored the photo under a slips/ key with no name in it. */
export function mediaLabel(key: string): string {
  return key.startsWith("slips/") ? "Driver photo" : fileLabel(key);
}

/** PUT one file onto a case. Refuses an over-size video before sending 50 MB. */
export async function uploadBreakdownFile(caseId: string, f: File): Promise<void> {
  const ext = (f.name.split(".").pop() || "").toLowerCase();
  if ((ext === "mp4" || ext === "mov") && f.size > VIDEO_MAX_BYTES) throw new Error(`${f.name}: a video can be at most 50 MB.`);
  await api.putBinary(`/api/fleet-breakdown-files/${caseId}?ext=${encodeURIComponent(ext)}&name=${encodeURIComponent(f.name)}`,
    f, f.type || "application/octet-stream");
}

export function BreakdownFiles({ caseId, refs, onChanged }: { caseId: string; refs: string[]; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const base = `/api/fleet-breakdown-files/${caseId}`;
  const errText = (e: unknown) => (e instanceof Error ? e.message : "The file could not be saved.");

  const upload = async (files: File[]) => {
    if (busy || files.length === 0) return;
    setBusy(true); setErr(null);
    try {
      // One at a time: the route appends to media_refs.
      for (const f of files) await uploadBreakdownFile(caseId, f);
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); onChanged(); }
  };

  const open = async (key: string) => {
    try { window.open(await api.fetchBlobUrl(`${base}/file?key=${encodeURIComponent(key)}`), "_blank", "noopener"); }
    catch (e) { setErr(errText(e)); }
  };

  const remove = async (key: string) => {
    if (busy) return;
    setBusy(true); setErr(null);
    try { await api.del(`${base}?key=${encodeURIComponent(key)}`); onChanged(); }
    catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };

  return (
    <div className="mt-2 rounded-md border border-border/70 bg-surface-2/30 p-2">
      <div className="text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">Photos &amp; videos</div>
      {refs.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10.5px]">
          {refs.map((k) => (
            <span key={k} className="inline-flex items-center gap-1 rounded border border-border bg-surface px-1.5 py-0.5">
              <button type="button" onClick={() => void open(k)} className="text-primary hover:underline">{mediaLabel(k)}</button>
              <button type="button" disabled={busy} onClick={() => void remove(k)} className="text-ink-muted hover:text-err" aria-label={`Remove ${mediaLabel(k)}`}>
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <input type="file" multiple accept={BREAKDOWN_MEDIA_ACCEPT} disabled={busy} aria-label="Attach photos or videos"
          onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ""; void upload(fs); }}
          className="text-[11px] text-ink-secondary file:mr-2 file:rounded file:border file:border-border file:bg-surface-2 file:px-2 file:py-0.5 file:text-[11px]" />
        <span className="text-[10.5px] text-ink-muted">{busy ? "Saving..." : "Photo 15 MB, video (MP4/MOV) 50 MB"}</span>
      </div>
      {err && <div className="mt-1 text-[11px] text-err">{err}</div>}
    </div>
  );
}
