import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { JOB_PROGRESS_KEY } from "../vendor/scm/lib/job-progress-queries";
import { authedFetch } from "../vendor/scm/lib/authed-fetch";
import { fieldPhotoContext, uploadFieldPhoto } from "../vendor/scm/lib/slip";
import { serverFieldPhotoRestore, useFieldPhotos } from "../lib/fieldPhotos";
import { CREW_STOP_POLL_MS } from "../vendor/scm/lib/crew-stop-photos";
import { FieldPhotos } from "../components/FieldPhotos";
import {
  deliveryIssueDraftError, invalidateDeliveryIssues, reportJobDeliveryIssue, useRunDeliveryIssues,
  type DeliveryIssueDraft,
} from "../vendor/scm/lib/delivery-issue-queries";
import { DeliveryIssueForm, MobileDeliveryIssues, EMPTY_ISSUE_DRAFT } from "./DeliveryIssueForm";
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
  /* The crew share the stop: while it is open and not completed, ask again so
     the other crew member's On the way / Arrived / Complete shows here too. */
  const q = useQuery({
    queryKey: ["delivery-job", jobKey(jobRef)], queryFn: () => authedFetch<JobResponse>(base), staleTime: 15_000,
    refetchInterval: (query) => (query.state.data?.progress?.completed_at ? false : CREW_STOP_POLL_MS),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [gps, setGps] = useState<{ lat: number; lng: number; accuracyM: number | null; atIso: string } | null>(null);
  const [capturing, setCapturing] = useState(false);
  /* "Report a problem": sent AFTER the job is completed, so a problem never
     blocks the job (A2). */
  const [issueOn, setIssueOn] = useState(false);
  const [issueDraft, setIssueDraft] = useState<DeliveryIssueDraft>(EMPTY_ISSUE_DRAFT);
  const issuesQ = useRunDeliveryIssues({ jobs: [jobKey(jobRef)] }, true, CREW_STOP_POLL_MS);

  const progress = q.data?.progress ?? null;
  const people = q.data?.people ?? {};
  const who = (id: unknown) => (id == null ? null : people[String(id)] || null);
  const ctx = q.data?.context;
  const done = !!progress?.completed_at;
  // The backend takes at most 10 photos when a job is completed (delivery-job-progress.ts MAX_PHOTOS).
  // After a page reload the photos already uploaded for this stop come back from the server.
  const photoContext = fieldPhotoContext({ kind: "job", key: jobKey(jobRef) });
  const photos = useFieldPhotos({
    stampLabel: null, // no time watermark on photos (owner 2026-11-11)
    max: 10,
    upload: (file) => uploadFieldPhoto({ file, context: photoContext }),
    restore: ctx && !done ? serverFieldPhotoRestore(photoContext) : null,
  });

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
      // The other crew member may have just done it: show the stop as it is now.
      void refresh();
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
    // Photos upload as they are taken; Complete sends only the uploaded ones.
    const gate = photos.gate("Take at least one POD photo first.");
    if (!gate.ok) { setError(gate.reason); return; }
    const issueError = issueOn ? deliveryIssueDraftError(issueDraft) : null;
    if (issueError) { setError(issueError); return; }
    setError(null); setBusy(true);
    try {
      await authedFetch(`${base}/complete`, {
        method: "POST",
        body: JSON.stringify({ photoKeys: gate.keys, notes, ...(gps ? { lat: gps.lat, lng: gps.lng, accuracyM: gps.accuracyM, locatedAt: gps.atIso } : {}) }),
      });
      await refresh();
    } catch (e) {
      setError((e as Error).message || "Could not complete the job. Your photos are uploaded; try Complete again.");
      void refresh();
      setBusy(false);
      return;
    }
    if (issueOn && !(await sendIssue("The job is completed, but the problem report did not send"))) { setBusy(false); return; }
    setBusy(false);
    onDone();
  };

  const sendIssue = async (failPrefix: string): Promise<boolean> => {
    try {
      await reportJobDeliveryIssue(jobRef, issueDraft);
      setIssueDraft(EMPTY_ISSUE_DRAFT);
      setIssueOn(false);
      await invalidateDeliveryIssues(qc);
      return true;
    } catch (e) {
      setError(`${failPrefix}: ${(e as Error).message || "please try again"}.`);
      return false;
    }
  };
  const sendIssueOnly = async () => {
    if (busy) return;
    const err = deliveryIssueDraftError(issueDraft);
    if (err) { setError(err); return; }
    setError(null); setBusy(true);
    await sendIssue("The problem report did not send");
    setBusy(false);
  };

  const label = LEG_LABEL[jobRef.leg] ?? jobRef.leg;
  const step = done ? "done" : progress?.arrived_at ? "arrived" : progress?.departed_at ? "otw" : "sched";

  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div className="hdr-row">
          <button className="back" onClick={onBack}><span className="chev">‹</span> Last Mile Delivery</button>
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
              {([["On the way", progress?.departed_at, progress?.departed_by], ["Arrived", progress?.arrived_at, progress?.arrived_by], ["Completed — POD uploaded", progress?.completed_at, progress?.completed_by]] as const).map(([k, v, by]) => (
                <div key={k} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "3px 0", color: v ? "var(--ink)" : "var(--mut2)" }}>
                  <span>{k}</span><span className="tnum">{hm(v ?? null) ?? "—"}{v && who(by) ? ` · ${who(by)}` : ""}</span>
                </div>
              ))}
              {done && str(progress.pod_notes) && (
                <div style={{ fontSize: 12.5, marginTop: 6 }}><span className="fld-l">Notes</span> {str(progress.pod_notes)}</div>
              )}
            </div>

            {(progress?.pod_photo_keys?.length ?? 0) > 0 && (
              <div className="card" style={{ padding: 12, marginBottom: 12 }}>
                <div className="fld-l" style={{ marginBottom: 6 }}>POD photos</div>
                <PodPhotoAlbum paths={(progress?.pod_photo_keys ?? []).map((_, n) => `/api/scm${base}/photo/${n}`)} fileStem={`POD-${str(ctx.ref) ?? jobRef.leg}`} title={str(ctx.ref) ?? jobRef.leg} />
              </div>
            )}

            {step === "arrived" && (
              <div className="card" style={{ padding: 12 }}>
                <FieldPhotos api={photos} disabled={busy} title="POD photos (at least one)" />
                <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (optional)" rows={2}
                  style={{ width: "100%", marginTop: 10, fontFamily: "inherit", fontSize: 12.5, borderRadius: 8, padding: 8, border: "1px solid var(--line)" }} />
                <button type="button" className="btn-ghost" onClick={captureGps} disabled={capturing} style={{ marginTop: 8 }}>
                  {gps ? "Location captured — recapture" : capturing ? "Locating…" : "Capture location"}
                </button>
              </div>
            )}
            <MobileDeliveryIssues issues={issuesQ.data} />
            {(step === "arrived" || done) && (
              !issueOn ? (
                <button type="button" className="btn-ghost" onClick={() => setIssueOn(true)} style={{ width: "100%", marginTop: 12, color: "var(--red)", borderColor: "var(--red)" }}>
                  {done ? "Report a problem" : "Completed with issue"}
                </button>
              ) : (
                <div className="card" style={{ padding: 12, marginTop: 12, border: "1px solid var(--red)" }}>
                  <DeliveryIssueForm value={issueDraft} onChange={setIssueDraft} disabled={busy} />
                  <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                    <button type="button" className="btn-ghost" disabled={busy} onClick={() => { setIssueOn(false); setIssueDraft(EMPTY_ISSUE_DRAFT); }} style={{ flex: 1 }}>No problem</button>
                    {done && <button type="button" className="btn" disabled={busy} onClick={sendIssueOnly} style={{ flex: 1 }}>{busy ? "Sending…" : "Send report"}</button>}
                  </div>
                  {!done && <div style={{ fontSize: 11, color: "var(--mut)", marginTop: 8 }}>The job is still completed; the office gets a service case with your photos.</div>}
                </div>
              )
            )}
            {error && <div style={{ marginTop: 12, fontSize: 12, color: "var(--red)", textAlign: "center" }}>{error}</div>}
          </>
        )}
      </div>

      <footer className="actbar">
        {ctx && step === "sched" && <button type="button" className="btn" disabled={busy} onClick={() => post("depart")}>Start — I'm on the way</button>}
        {ctx && step === "otw" && <button type="button" className="btn" disabled={busy} onClick={() => post("arrive")}>Mark arrived</button>}
        {ctx && step === "arrived" && <button type="button" className="btn" disabled={busy} onClick={complete}>{busy ? "Completing…" : issueOn ? "Complete with issue →" : "Complete job →"}</button>}
        {ctx && done && <div style={{ textAlign: "center", fontSize: 12, color: "var(--green)", fontWeight: 700, padding: 6 }}>This job is completed.</div>}
        {!ctx && <button type="button" className="btn-ghost" onClick={onBack}>Back</button>}
      </footer>
    </div>
  );
}
