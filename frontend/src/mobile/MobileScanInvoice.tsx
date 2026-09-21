// ----------------------------------------------------------------------------
// MobileScanInvoice — the phone's supplier-invoice scanner. The PI sibling of
// MobileScan (the SO slip scanner) and the mobile half of the desktop
// ScanInvoiceModal: desktop and mobile are one product, so both surface the
// same capability.
//
// Snap / choose a supplier invoice -> POST /scan-pi/enqueue (background) -> the
// Worker reads it, matches our OPEN Goods Receipt(s) and CONVERTS them into a
// DRAFT Purchase Invoice. Nothing is posted; a needs-review outcome (no PI) is
// shown plainly when the invoice can't be matched. The phone can leave the
// screen the moment the upload lands — this list polls for progress.
// ----------------------------------------------------------------------------

import { useEffect, useRef, useState } from "react";
import { compressAllForOcr } from "../vendor/shared/image-compress";
import {
  enqueuePiScan, fetchPiScanJobs, clearFailedPiScans,
  isActivePiJob, piHhmm, piJobTs, isPiTodayTs, type PiScanJob,
} from "../vendor/scm/lib/pi-scan-jobs";

export function MobileScanInvoice({
  onBack,
  onOpenPi,
}: {
  onBack: () => void;
  onOpenPi: (docNo: string) => void;
}) {
  const cameraRef = useRef<HTMLInputElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<PiScanJob[]>([]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const rows = await fetchPiScanJobs();
        if (!alive) return;
        setJobs(rows);
        timer = setTimeout(tick, rows.some(isActivePiJob) ? 4000 : 8000);
      } catch {
        if (alive) timer = setTimeout(tick, 8000);
      }
    };
    void tick();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, []);

  const onFiles = async (list: FileList | null | undefined) => {
    const files = list ? Array.from(list) : [];
    if (files.length === 0) return;
    setError(null);
    setBusy(true);
    try {
      const compressed = await compressAllForOcr(files);
      await enqueuePiScan(compressed);
      try { setJobs(await fetchPiScanJobs()); } catch { /* poll catches up */ }
    } catch (e) {
      setError((e as Error).message || "Couldn't upload the invoice — try again.");
    } finally {
      setBusy(false);
    }
  };

  const onClear = async () => {
    try { await clearFailedPiScans(); setJobs(await fetchPiScanJobs()); } catch { /* best-effort */ }
  };

  const visible = jobs.filter((j) => isPiTodayTs(piJobTs(j.createdAt)));
  const hasFailed = jobs.some((j) => j.status === "error");

  const btn: React.CSSProperties = {
    height: 48, borderRadius: 12, border: "1px solid #16695f", background: "#fff",
    color: "#16695f", fontFamily: "inherit", fontSize: 14, fontWeight: 700, cursor: "pointer",
    display: "flex", alignItems: "center", justifyContent: "center", gap: 8, width: "100%",
  };

  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div className="hdr-row">
          <button onClick={onBack} className="back" aria-label="Cancel">
            <span className="chev">{"‹"}</span> Cancel
          </button>
        </div>
        <div className="scr-title" style={{ marginTop: 2 }}>Scan invoice</div>
        <div style={{ fontSize: 11, color: "#767b6e", marginTop: 2 }}>
          Snap a supplier invoice — we read it and create a draft invoice from the matching Goods Receipt. Nothing is posted until you confirm it.
        </div>
      </header>

      <div className="scroll" style={{ padding: 14, paddingBottom: 120 }}>
        {error && (
          <div style={{ background: "#fbe9e7", color: "#b23c17", borderRadius: 10, padding: "9px 12px", fontSize: 12.5, marginBottom: 12 }}>{error}</div>
        )}

        <input ref={cameraRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }}
          onChange={(e) => { void onFiles(e.target.files); e.target.value = ""; }} />
        <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" multiple style={{ display: "none" }}
          onChange={(e) => { void onFiles(e.target.files); e.target.value = ""; }} />

        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 18 }}>
          <button style={{ ...btn, background: "#16695f", color: "#fff", opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={() => cameraRef.current?.click()}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" /><circle cx="12" cy="13" r="4" /></svg>
            {busy ? "Uploading…" : "Take a photo"}
          </button>
          <button style={{ ...btn, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={() => fileRef.current?.click()}>
            Choose from files
          </button>
        </div>

        {visible.length > 0 && (
          <div>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 6 }}>
              <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.3, color: "#767b6e", textTransform: "uppercase" }}>Recent scans</div>
              {hasFailed && (
                <button onClick={() => void onClear()} style={{ background: "none", border: "none", color: "#767b6e", fontSize: 11.5, cursor: "pointer" }}>Clear failed</button>
              )}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {visible.map((j) => {
                const done = j.status === "done";
                const ok = done && !!j.linkedDocNo;
                const bad = j.status === "error" || (done && !j.linkedDocNo);
                return (
                  <div key={j.id} style={{ border: "1px solid #e7e2d6", borderRadius: 10, padding: "10px 12px", background: "#fff" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 700, color: bad ? "#b23c17" : "#11140f" }}>
                      <span>
                        {isActivePiJob(j) && "Reading invoice…"}
                        {ok && `Draft ${j.linkedDocNo}`}
                        {done && !j.linkedDocNo && "Needs review"}
                        {j.status === "error" && "Could not process"}
                      </span>
                      <span style={{ marginLeft: "auto", fontSize: 11, fontWeight: 500, color: "#767b6e" }}>{piHhmm(piJobTs(j.createdAt))}</span>
                    </div>
                    {j.error && <div style={{ fontSize: 11.5, color: "#767b6e", marginTop: 4, lineHeight: 1.5 }}>{j.error}</div>}
                    {ok && (
                      <button onClick={() => onOpenPi(j.linkedDocNo!.split(",")[0]?.trim() ?? j.linkedDocNo!)}
                        style={{ marginTop: 6, background: "none", border: "none", color: "#16695f", fontSize: 12, fontWeight: 700, cursor: "pointer", padding: 0 }}>
                        Open draft invoice ›
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
