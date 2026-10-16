import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { JOB_PROGRESS_KEY } from "../vendor/scm/lib/job-progress-queries";
import { authedFetch } from "../vendor/scm/lib/authed-fetch";
import { uploadSlipFull, ALLOWED_SLIP_MIMES } from "../vendor/scm/lib/slip";
import "./mobile.css";
import { PodPhotoAlbum } from "../components/scm-v2/PodPhotoAlbum";
import {
  jobKey, LEG_LABEL, detailRows, str, hm,
  type JobRef, type JobProgress, type JobResponse,
} from "../vendor/scm/lib/delivery-job";
export { useJobProgressMap } from "../vendor/scm/lib/job-progress-queries";
export { jobRefOf, jobKey, jobLabelOf, type JobRef, type JobProgress } from "../vendor/scm/lib/delivery-job";

/* A run-sheet stop that is NOT a delivery order: Setup / Dismantle (a project),
   a Service Case leg, or a manual DP job (Supplier pickup, Transfer, Lorry
   service). Same chain as a DO — On the way -> Arrived -> photos -> Complete —
   through /delivery-jobs (backend scm/routes/delivery-job-progress.ts), which
   also files the photos on the job's own document. */

export function MobileJobStop({ jobRef, seq, onBack, onDone }: {
  jobRef: JobRef; seq: number | null; onBack: () => void; onDone: () => void;
}) {
  const qc = useQueryClient();
  const base = `/delivery-jobs/${jobRef.sourceType}/${encodeURIComponent(jobRef.sourceId)}/${encodeURIComponent(jobRef.leg)}`;
  const q = useQuery({ queryKey: ["delivery-job", jobKey(jobRef)], queryFn: () => authedFetch<JobResponse>(base), staleTime: 15_000 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [photos, setPhotos] = useState<File[]>([]);
  const [notes, setNotes] = useState("");
  const [gps, setGps] = useState<{ lat: number; lng: number; accuracyM: number | null; atIso: string } | null>(null);
  const [capturing, setCapturing] = useState(false);

  const progress = q.data?.progress ?? null;
  const ctx = q.data?.context;
  const done = !!progress?.completed_at;

  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["delivery-job", jobKey(jobRef)] }),
      qc.invalidateQueries({ queryKey: JOB_PROGRESS_KEY }),
    ]);
  };
  const post = async (path: string, body?: unknown) => {
    setError(null); setBusy(true);
    try {
      await authedFetch(`${base}/${path}`, { method: "POST", body: JSON.stringify(body ?? {}) });
      await refresh();
      return true;
    } catch (e) {
      setError((e as Error).message || "Could not save. Check your connection and try again.");
      return false;
    } finally { setBusy(false); }
  };

  const captureGps = () => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- absent on old WebViews despite the DOM type
    if (!navigator.geolocation) return;
    setCapturing(true);
    navigator.geolocation.getCurrentPosition(
      (p) => { setGps({ lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: p.coords.accuracy, atIso: new Date().toISOString() }); setCapturing(false); },
      () => setCapturing(false),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 },
    );
  };

  const complete = async () => {
    if (!photos.length) { setError("Take at least one POD photo first."); return; }
    setError(null); setBusy(true);
    try {
      const keys: string[] = [];
      for (const f of photos) keys.push((await uploadSlipFull({ file: f })).r2Key);
      await authedFetch(`${base}/complete`, {
        method: "POST",
        body: JSON.stringify({ photoKeys: keys, notes, ...(gps ? { lat: gps.lat, lng: gps.lng, accuracyM: gps.accuracyM, locatedAt: gps.atIso } : {}) }),
      });
      await refresh();
      onDone();
    } catch (e) {
      setError((e as Error).message || "Could not complete the job. Nothing was saved; try again.");
    } finally { setBusy(false); }
  };

  const label = LEG_LABEL[jobRef.leg] ?? jobRef.leg;
  const step = done ? "done" : progress?.arrived_at ? "arrived" : progress?.departed_at ? "otw" : "sched";

  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div className="hdr-row">
          <button className="back" onClick={onBack}><span className="chev">‹</span> Delivery Planning</button>
          <span className={`badge ${done ? "b-green" : "b-brand"}`}>{done ? "Completed" : step === "arrived" ? "Arrived" : step === "otw" ? "On the way" : "Scheduled"}</span>
        </div>
        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--mut)", letterSpacing: ".04em" }}>
          {seq != null ? `STOP ${seq} · ` : ""}{label.toUpperCase()}{ctx?.ref ? ` · ${ctx.ref}` : ""}
        </div>
        <div className="scr-title">{str(ctx?.title) ?? label}</div>
      </header>

      <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px 16px" }}>
        {q.isPending && <div className="list-note">Loading…</div>}
        {q.error && <div style={{ color: "var(--red)", fontSize: 12 }}>{(q.error as Error).message}</div>}
        {ctx && (
          <>
            {str(ctx.contact_phone) && (
              <a className="btn-ghost" href={`tel:${str(ctx.contact_phone)}`} style={{ display: "block", textAlign: "center", marginBottom: 10 }}>Call {str(ctx.contact_name) ?? "contact"}</a>
            )}
            {str(ctx.address) && (
              <a className="btn-ghost" target="_blank" rel="noreferrer" style={{ display: "block", textAlign: "center", marginBottom: 12 }}
                href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(String(ctx.address))}`}>Navigate</a>
            )}
            <div className="card" style={{ padding: 12, marginBottom: 12 }}>
              {detailRows(ctx).filter(([, v]) => v).map(([k, v]) => (
                <div key={k} style={{ display: "flex", gap: 10, fontSize: 12.5, padding: "4px 0" }}>
                  <span className="fld-l" style={{ minWidth: 110 }}>{k}</span><span style={{ flex: 1 }}>{v}</span>
                </div>
              ))}
              {Array.isArray(ctx.lines) && ctx.lines.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <div className="fld-l">Items</div>
                  {(ctx.lines as Array<{ item_code: string; product_name: string | null; qty: number }>).map((l, i) => (
                    <div key={i} style={{ fontSize: 12.5, display: "flex", justifyContent: "space-between", padding: "3px 0" }}>
                      <span>{l.product_name || l.item_code}</span><span className="tnum">×{l.qty}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="card" style={{ padding: 12, marginBottom: 12 }}>
              <div className="fld-l" style={{ marginBottom: 6 }}>Tracking</div>
              {([["On the way", progress?.departed_at], ["Arrived", progress?.arrived_at], ["Completed — POD uploaded", progress?.completed_at]] as const).map(([k, v]) => (
                <div key={k} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "3px 0", color: v ? "var(--ink)" : "var(--mut2)" }}>
                  <span>{k}</span><span className="tnum">{hm(v ?? null) ?? "—"}</span>
                </div>
              ))}
            </div>

            {(progress?.pod_photo_keys?.length ?? 0) > 0 && (
              <div className="card" style={{ padding: 12, marginBottom: 12 }}>
                <div className="fld-l" style={{ marginBottom: 6 }}>POD photos</div>
                <PodPhotoAlbum paths={(progress?.pod_photo_keys ?? []).map((_, n) => `/api/scm${base}/photo/${n}`)} fileStem={`POD-${str(ctx.ref) ?? jobRef.leg}`} />
              </div>
            )}

            {step === "arrived" && (
              <div className="card" style={{ padding: 12 }}>
                <div className="fld-l" style={{ marginBottom: 6 }}>POD photos (at least one)</div>
                <input type="file" accept={ALLOWED_SLIP_MIMES.filter((m) => m.startsWith("image/")).join(",")} capture="environment" multiple
                  onChange={(e) => setPhotos((prev) => [...prev, ...Array.from(e.target.files ?? [])].slice(0, 10))} />
                {photos.length > 0 && <div style={{ fontSize: 12, marginTop: 6 }}>{photos.length} photo{photos.length === 1 ? "" : "s"} ready</div>}
                <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (optional)" rows={2}
                  style={{ width: "100%", marginTop: 10, fontFamily: "inherit", fontSize: 12.5, borderRadius: 8, padding: 8, border: "1px solid var(--line)" }} />
                <button type="button" className="btn-ghost" onClick={captureGps} disabled={capturing} style={{ marginTop: 8 }}>
                  {gps ? "Location captured — recapture" : capturing ? "Locating…" : "Capture location"}
                </button>
              </div>
            )}
            {error && <div style={{ marginTop: 12, fontSize: 12, color: "var(--red)", textAlign: "center" }}>{error}</div>}
          </>
        )}
      </div>

      <footer className="actbar">
        {ctx && step === "sched" && <button type="button" className="btn" disabled={busy} onClick={() => post("depart")}>Start — I'm on the way</button>}
        {ctx && step === "otw" && <button type="button" className="btn" disabled={busy} onClick={() => post("arrive")}>Mark arrived</button>}
        {ctx && step === "arrived" && <button type="button" className="btn" disabled={busy} onClick={complete}>{busy ? "Uploading…" : "Complete job →"}</button>}
        {ctx && done && <div style={{ textAlign: "center", fontSize: 12, color: "var(--green)", fontWeight: 700, padding: 6 }}>This job is completed.</div>}
        {!ctx && <button type="button" className="btn-ghost" onClick={onBack}>Back</button>}
      </footer>
    </div>
  );
}
