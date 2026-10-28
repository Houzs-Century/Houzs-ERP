// ----------------------------------------------------------------------------
// ScanInvoiceModal — "Scan invoice" on the Purchase Invoices list.
//
// The PI sibling of ScanOrderModal (SO slip scanner). Photo / drop a SUPPLIER
// INVOICE; every scan is a BACKGROUND job (the SAME /scan-pi/enqueue -> queue ->
// DRAFT flow the mobile invoice scanner uses):
//   1. Operator drops / snaps the invoice (jpeg/png/webp/pdf).
//   2. POST /scan-pi/enqueue uploads the photo(s), queues a server-side job and
//      returns 202 {job_id} BEFORE any OCR. The await is the upload only.
//   3. The Worker reads the invoice, matches it to our OPEN Goods Receipt(s) and
//      CONVERTS them into a DRAFT Purchase Invoice on its own — nothing is
//      posted. The operator can close this window the moment the upload lands; a
//      private "Invoice saved as a draft — <no>" notice announces it, and while
//      the modal is open it polls GET /scan-pi/jobs for a live results list.
//
// SAFETY: this modal never creates a document. If the scan cannot be matched to
// a received GRN, the background job lands a NEEDS-REVIEW result (no PI, a plain
// reason) — never a guessed link or a standalone invoice.
// ----------------------------------------------------------------------------

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { AlertTriangle, CheckCircle2, FileText, Loader2, Upload, X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { compressAllForOcr } from '../../shared/image-compress';
import {
  enqueuePiScan, fetchPiScanJobs, clearFailedPiScans,
  isActivePiJob, piHhmm, piJobTs, isPiTodayTs, type PiScanJob,
} from '../lib/pi-scan-jobs';

const ACCEPT = 'image/jpeg,image/png,image/webp,application/pdf';

export function ScanInvoiceModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<PiScanJob[]>([]);

  // Poll the job list while the modal is open (every 4s), a touch faster while
  // any job is still active — the same cadence the SO scanner uses.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const rows = await fetchPiScanJobs();
        if (!alive) return;
        setJobs(rows);
        const anyActive = rows.some(isActivePiJob);
        timer = setTimeout(tick, anyActive ? 4000 : 8000);
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
      // Downscale/re-encode before the upload — these are the bytes the model
      // reads (same as the mobile path).
      const compressed = await compressAllForOcr(files);
      await enqueuePiScan(compressed);
      // Refresh immediately so the new queued card appears without waiting a tick.
      try { setJobs(await fetchPiScanJobs()); } catch { /* poll will catch up */ }
    } catch (e) {
      setError((e as Error).message || 'Could not upload the invoice. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const onClear = async () => {
    try { await clearFailedPiScans(); setJobs(await fetchPiScanJobs()); } catch { /* best-effort */ }
  };

  const openPi = (docNo: string) => {
    // linkedDocNo may be a comma-joined list (multi-bucket); search the list on
    // the first number so the operator lands on their new draft.
    const first = docNo.split(',')[0]?.trim() ?? docNo;
    navigate(`/scm/purchase-invoices?q=${encodeURIComponent(first)}`);
    onClose();
  };

  const todays = jobs.filter((j) => isPiTodayTs(piJobTs(j.createdAt)));
  const hasFailed = jobs.some((j) => j.status === 'error');

  return (
    <div
      className="fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-lg rounded-xl bg-surface shadow-xl ring-1 ring-border">
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-sidebar-ink-muted">Purchase Invoices</div>
            <h2 className="text-[15px] font-semibold text-ink">Scan invoice</h2>
            <p className="mt-1 text-[12.5px] leading-snug text-sidebar-ink-muted">
              Photo a supplier invoice and we read it in the background, then create a
              draft invoice from the matching Goods Receipt. Nothing is posted — open
              the draft to review and confirm. You can close this window once the upload finishes.
            </p>
          </div>
          <button type="button" className="text-sidebar-ink-muted hover:text-ink" onClick={onClose} aria-label="Close">
            <X size={18} strokeWidth={1.75} />
          </button>
        </div>

        <div className="space-y-3 px-5 py-4">
          {error && (
            <div className="rounded-md bg-err/10 px-3 py-2 text-[12.5px] text-err">{error}</div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPT}
            multiple
            style={{ display: 'none' }}
            onChange={(e) => { void onFiles(e.target.files); e.target.value = ''; }}
          />

          <button
            type="button"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
            className="flex w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border px-4 py-8 text-sidebar-ink-muted hover:border-accent-bright/50 hover:text-ink disabled:opacity-60"
          >
            {busy ? <Loader2 size={24} className="animate-spin" /> : <Upload size={24} strokeWidth={1.5} />}
            <span className="text-[13px] font-medium">{busy ? 'Uploading…' : 'Choose or snap invoice photos'}</span>
            <span className="text-[11.5px]">JPEG / PNG / WEBP / PDF · one invoice per file</span>
          </button>

          {todays.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-sidebar-ink-muted">Recent scans</span>
                {hasFailed && (
                  <button type="button" className="text-[11.5px] text-sidebar-ink-muted hover:text-ink" onClick={() => void onClear()}>
                    Clear failed
                  </button>
                )}
              </div>
              {todays.map((j) => (
                <div key={j.id} className="flex items-start gap-2.5 rounded-md border border-border px-3 py-2.5">
                  <div className="mt-0.5 flex-none">
                    {isActivePiJob(j) && <Loader2 size={16} className="animate-spin text-accent-bright" />}
                    {j.status === 'done' && j.linkedDocNo && <CheckCircle2 size={16} className="text-success" />}
                    {(j.status === 'error' || (j.status === 'done' && !j.linkedDocNo)) && (
                      <AlertTriangle size={16} className="text-err" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-[12.5px]">
                      <FileText size={13} className="flex-none text-sidebar-ink-muted" />
                      <span className="font-medium text-ink">
                        {isActivePiJob(j) && 'Reading invoice…'}
                        {j.status === 'done' && j.linkedDocNo && `Draft ${j.linkedDocNo}`}
                        {j.status === 'done' && !j.linkedDocNo && 'Needs review'}
                        {j.status === 'error' && 'Could not process'}
                      </span>
                      <span className="ml-auto flex-none text-[11px] text-sidebar-ink-muted">{piHhmm(piJobTs(j.createdAt))}</span>
                    </div>
                    {j.error && <p className="mt-1 text-[11.5px] leading-snug text-sidebar-ink-muted">{j.error}</p>}
                    {j.status === 'done' && j.linkedDocNo && (
                      <button type="button" className="mt-1 text-[11.5px] font-semibold text-accent-bright hover:underline" onClick={() => openPi(j.linkedDocNo!)}>
                        Open draft invoice
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  );
}
