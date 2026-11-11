/* Breakdown & incident media: the scene photos and videos kept ON the case.
   Backend: /api/fleet-breakdown-files. Own file because FleetHealth.tsx is near
   its size ceiling. */
import { useState } from "react";
import { X } from "lucide-react";
import { api } from "../api/client";
import { fileLabel } from "./FleetHealthWorkOrderFiles";
import { openLoadedTab } from "../lib/openLoadedTab";

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
    try { await openLoadedTab(() => api.fetchBlobUrl(`${base}/file?key=${encodeURIComponent(key)}`), 60_000); }
    catch (e) { setErr(errText(e)); }
  };

  const remove = async (key: string) => {
    if (busy) return;
    setBusy(true); setErr(null);
    try { await api.del(`${base}?key=${encodeURIComponent(key)}`); onChanged(); }
    catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };

  return (
    <div className="mt-3 rounded-xl bg-surface p-3">
      <div className="text-[12.5px] font-semibold text-ink-secondary">Photos &amp; videos</div>
      {refs.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12.5px]">
          {refs.map((k) => (
            <span key={k} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[color:var(--hz-dk-warning-bg,#ece8df)] pl-2.5 pr-1">
              <button type="button" onClick={() => void open(k)} className="font-medium text-primary-ink underline">{mediaLabel(k)}</button>
              <button type="button" disabled={busy} onClick={() => void remove(k)} className="rounded p-1 text-ink-muted hover:text-err" aria-label={`Remove ${mediaLabel(k)}`}>
                <X size={13} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input type="file" multiple accept={BREAKDOWN_MEDIA_ACCEPT} disabled={busy} aria-label="Attach photos or videos"
          onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ""; void upload(fs); }}
          className="max-w-full text-[13px] text-ink-secondary file:mr-2 file:h-9 file:rounded-lg file:border file:border-[#d9d3c6] file:bg-surface file:px-3 file:text-[13px] file:font-semibold" />
        <span className="text-[12px] text-ink-muted">{busy ? "Saving..." : "Photo 15 MB, video (MP4/MOV) 50 MB"}</span>
      </div>
      {err && <div role="alert" className="mt-1.5 text-[12.5px] font-semibold text-err">{err}</div>}
    </div>
  );
}
