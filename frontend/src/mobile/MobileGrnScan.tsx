// ----------------------------------------------------------------------------
// MobileGrnScan — the mobile twin of the desktop ScanGrnModal (one product, one
// logic layer). Photo a supplier DELIVERY ORDER; the background scan pipeline
// reads it and CONVERTS the matching open PO line(s) into a DRAFT goods receipt.
// Never posts stock; never creates a standalone GRN. Same /scan-gr/* contract
// and shared scan-jobs helpers the desktop uses.
// ----------------------------------------------------------------------------

import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { authedFetch } from "../vendor/scm/lib/authed-fetch";
import { compressAllForOcr } from "../vendor/shared/image-compress";
import {
  normalizeJobs,
  isActiveJob,
  jobTs,
  hhmm,
  type ScanJob,
  type ScanJobsResp,
} from "../vendor/scm/lib/scan-jobs";
import "./mobile.css";

const ACCEPT = "image/jpeg,image/png,image/webp,application/pdf,.jpg,.jpeg,.png,.webp,.pdf";
const isAcceptedFile = (f: File): boolean =>
  /^(image\/(jpeg|png|webp)|application\/pdf)$/.test(f.type) || /\.(jpe?g|png|webp|pdf)$/i.test(f.name);

type EnqueueResp = { job_id: string; status: string };

export function MobileGrnScan({ onBack }: { onBack: () => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enqueuedJobIds, setEnqueuedJobIds] = useState<string[]>([]);
  const camInputRef = useRef<HTMLInputElement>(null);
  const libInputRef = useRef<HTMLInputElement>(null);

  const addFiles = (list: FileList | null) => {
    const accepted = Array.from(list ?? []).filter(isAcceptedFile);
    if (accepted.length === 0) {
      if ((list?.length ?? 0) > 0) setError("Unsupported file — use a JPEG, PNG, WEBP or PDF.");
      return;
    }
    setFiles((cur) => [...cur, ...accepted]);
    setError(null);
  };

  const { data: jobsData } = useQuery({
    queryKey: ["mobile-grn-scan-jobs"],
    enabled: enqueuedJobIds.length > 0,
    queryFn: () => authedFetch<ScanJobsResp>("/scan-gr/jobs"),
    staleTime: 0,
    retry: false,
    refetchInterval: (query) => {
      if (enqueuedJobIds.length === 0) return false;
      const tracked = normalizeJobs(query.state.data).filter((j) => enqueuedJobIds.includes(j.id));
      const allSettled = tracked.length === enqueuedJobIds.length && !tracked.some(isActiveJob);
      return allSettled ? false : 4000;
    },
  });
  const trackedJobs = useMemo<ScanJob[]>(() => {
    const byId = new Map(normalizeJobs(jobsData).map((j) => [j.id, j]));
    return enqueuedJobIds
      .map((id) => byId.get(id))
      .filter((j): j is ScanJob => Boolean(j))
      .sort((a, b) => jobTs(a.createdAt) - jobTs(b.createdAt));
  }, [jobsData, enqueuedJobIds]);

  const runScan = async () => {
    if (submitting || files.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const compressed = await compressAllForOcr(files);
      const form = new FormData();
      for (const f of compressed) form.append("file", f);
      const r = await authedFetch<EnqueueResp>("/scan-gr/enqueue", { method: "POST", body: form });
      if (r?.job_id) {
        setEnqueuedJobIds((prev) => [...prev, r.job_id]);
        setFiles([]);
      }
    } catch {
      setError("The delivery order could not be queued. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const btn = (primary: boolean): React.CSSProperties => ({
    height: 48, padding: "0 22px", borderRadius: 12,
    border: primary ? "none" : "1px solid #16695f",
    background: primary ? "#16695f" : "#fff", color: primary ? "#fff" : "#16695f",
    fontFamily: "inherit", fontSize: 14, fontWeight: 700, cursor: "pointer",
  });

  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div className="hdr-row">
          <button onClick={onBack} className="back" aria-label="Cancel">
            <span className="chev">{"‹"}</span> {enqueuedJobIds.length > 0 || submitting ? "Close" : "Cancel"}
          </button>
        </div>
        <div className="scr-title" style={{ marginTop: 2 }}>Scan delivery order</div>
        <div style={{ fontSize: 11, color: "#767b6e", marginTop: 2 }}>
          Snap the supplier delivery order — we read it in the background and create a draft goods receipt from the matching PO for you to review and post.
        </div>
      </header>

      <div className="scroll" style={{ padding: 14, paddingBottom: 120 }}>
        {error && (
          <div style={{ background: "#fdecec", color: "#a33", borderRadius: 10, padding: "10px 12px", fontSize: 12.5, marginBottom: 12 }}>{error}</div>
        )}

        <input ref={camInputRef} type="file" accept={ACCEPT} capture="environment" style={{ display: "none" }}
          onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
        <input ref={libInputRef} type="file" accept={ACCEPT} multiple style={{ display: "none" }}
          onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />

        {files.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            {files.map((f, i) => (
              <div key={`${f.name}-${i}`} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", background: "#fff", borderRadius: 10, marginBottom: 6, fontSize: 12.5 }}>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
                {!submitting && (
                  <button onClick={() => setFiles((cur) => cur.filter((_, k) => k !== i))} style={{ border: "none", background: "none", color: "#a33", fontSize: 12, cursor: "pointer" }}>Remove</button>
                )}
              </div>
            ))}
          </div>
        )}

        <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
          <button onClick={() => camInputRef.current?.click()} disabled={submitting} style={{ ...btn(false), flex: 1 }}>
            {files.length === 0 ? "Take photo" : "Add page"}
          </button>
          <button onClick={() => libInputRef.current?.click()} disabled={submitting} style={{ ...btn(false), flex: 1 }}>Library</button>
        </div>

        {files.length > 0 && (
          <button onClick={() => void runScan()} disabled={submitting} style={{ ...btn(true), width: "100%" }}>
            {submitting ? "Uploading…" : `Scan delivery order${files.length > 1 ? ` (${files.length} pages)` : ""}`}
          </button>
        )}

        {enqueuedJobIds.length > 0 && (
          <div style={{ marginTop: 20 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#767b6e", marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.4 }}>Scanned this session</div>
            {trackedJobs.length === 0 && (
              <div style={{ fontSize: 12.5, color: "#767b6e" }}>Uploading — the reading finishes in the background.</div>
            )}
            {trackedJobs.map((j) => {
              const active = isActiveJob(j);
              const done = j.status === "done";
              const needsReview = done && !j.linkedDocNo;
              const color = done ? (needsReview ? "#a16a2e" : "#16695f") : j.status === "error" ? "#a33" : "#767b6e";
              const label = active ? (j.status === "running" ? "Reading…" : "Queued") : done ? (needsReview ? "Review" : "Draft") : j.status === "error" ? "Failed" : j.status;
              return (
                <div key={j.id} style={{ display: "flex", gap: 10, padding: "10px 12px", background: "#fff", borderRadius: 10, marginBottom: 6 }}>
                  <span style={{ flex: "none", fontSize: 11, fontWeight: 700, color }}>{label}</span>
                  <div style={{ flex: 1, fontSize: 12.5, color: "#11140f", lineHeight: 1.45 }}>
                    {done
                      ? (j.linkedDocNo
                          ? `Draft goods receipt ${j.linkedDocNo} — open it from Goods Receipts to review and post.`
                          : (j.error || "Needs review — open the PO and receive by hand."))
                      : j.status === "error"
                        ? (j.error || "Couldn't read the delivery order.")
                        : "Reading the delivery order…"}
                  </div>
                  <span style={{ flex: "none", fontSize: 11, color: "#9aa093" }}>{jobTs(j.createdAt) ? hhmm(jobTs(j.createdAt)) : ""}</span>
                </div>
              );
            })}
            <div style={{ fontSize: 11, color: "#767b6e", marginTop: 8 }}>
              Draft receipts land in the Goods Receipt list — open each to review every line, then post to receive stock.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
