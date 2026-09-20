// ----------------------------------------------------------------------------
// ScanGrnModal — "Scan Delivery Order" on the Goods Receipt list.
//
// The GR twin of ScanOrderModal: photo a supplier DELIVERY ORDER, we read it in
// the background and CONVERT the matching open PO line(s) into a DRAFT goods
// receipt (never a standalone GRN). EVERY scan is a background job on the same
// scan_jobs pipeline (document_type='GR'):
//   1. Operator drops / snaps the delivery-order photo(s) (one or more pages;
//      jpeg/png/webp/PDF).
//   2. POST /scan-gr/enqueue uploads them, queues a server job, returns 202
//      {job_id}. The await is the upload only — seconds, not the OCR.
//   3. The Worker reads the DO, matches its lines to our open PO lines and mints
//      a DRAFT GRN. If it cannot confidently match a PO, NOTHING is created and
//      the job lands NEEDS-REVIEW with a note — the operator receives from the
//      PO by hand. The operator can close this window once the upload lands.
//
// A scan NEVER posts stock: the DRAFT is reviewed + posted from the GRN list.
// Reuses the shared scan-jobs helpers + authedFetch + the SO modal's styling.
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Camera, CheckCircle2, Loader2, Plus, X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { authedFetch } from '../lib/authed-fetch';
import { compressForOcr } from '../../shared/image-compress';
import {
  normalizeJobs,
  isActiveJob,
  jobTs,
  hhmm,
  type ScanJob,
  type ScanJobsResp,
} from '../lib/scan-jobs';
import styles from './ScanOrderModal.module.css';

const ACCEPT = 'image/jpeg,image/png,image/webp,application/pdf,.jpg,.jpeg,.png,.webp,.pdf';
const isAcceptedFile = (f: File): boolean =>
  /^(image\/(jpeg|png|webp)|application\/pdf)$/.test(f.type) || /\.(jpe?g|png|webp|pdf)$/i.test(f.name);

type EnqueueResp = { job_id: string; status: string };

export function ScanGrnModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enqueuedJobIds, setEnqueuedJobIds] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const busy = submitting;

  const addFiles = (list: FileList | File[] | null) => {
    const accepted = Array.from(list ?? []).filter(isAcceptedFile);
    if (accepted.length === 0) {
      if ((list?.length ?? 0) > 0) setError('Unsupported file — use a JPEG, PNG, WEBP or PDF.');
      return;
    }
    setFiles((cur) => [...cur, ...accepted]);
    setError(null);
  };
  const removeFile = (index: number) => {
    if (busy) return;
    setFiles((cur) => cur.filter((_, k) => k !== index));
  };

  /* Results — poll GET /scan-gr/jobs (company-scoped, GR-only) and show only the
     jobs this session enqueued. Every 4s while any is queued/running. */
  const { data: jobsData } = useQuery({
    queryKey: ['scan-grn-modal-jobs'],
    enabled: enqueuedJobIds.length > 0,
    queryFn: () => authedFetch<ScanJobsResp>('/scan-gr/jobs'),
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

  // One /scan-gr/enqueue POST — every page of the delivery order under `file`
  // (the repeated-`file` contract the backend + SO scanner share). Downscale
  // first, same helper the SO scan uses; a PDF passes through untouched.
  const runScan = async () => {
    if (submitting || files.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const fd = new FormData();
      for (const f of files) fd.append('file', await compressForOcr(f));
      const r = await authedFetch<EnqueueResp>('/scan-gr/enqueue', { method: 'POST', body: fd });
      if (r.job_id) {
        setEnqueuedJobIds((prev) => [...prev, r.job_id]);
        setFiles([]); // ready for the next delivery order
      }
    } catch {
      setError('The delivery order could not be queued. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  useEffect(() => () => { /* jobs keep running server-side after close */ }, []);

  return (
    <div className={styles.modal} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={styles.panel}>
        <div className={styles.head}>
          <div>
            <div className={styles.eyebrow}>Goods Receipt</div>
            <h2 className={styles.title}>Scan Delivery Order</h2>
            <p className={styles.sub}>
              Photo a supplier delivery order and we read it in the background,
              then create a draft goods receipt from the matching purchase order —
              ready for you to review and post. You can close this window as soon
              as the photos finish uploading.
            </p>
          </div>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close">
            <X size={18} strokeWidth={1.75} />
          </button>
        </div>

        <div className={styles.body}>
          {error && <div className={styles.error}>{error}</div>}

          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            multiple
            style={{ display: 'none' }}
            onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
          />

          <div className={styles.slot}>
            <span className={styles.slotLabel}>Delivery order {files.length > 0 ? `· ${files.length} page${files.length === 1 ? '' : 's'}` : ''}</span>
            {files.map((file, i) => (
              <div key={`${file.name}-${i}`} className={styles.slotFilled}>
                <Camera size={20} strokeWidth={1.5} />
                <span className={styles.slotFileName}>{file.name}</span>
                {!busy && (
                  <button
                    type="button"
                    className={styles.removeBtn}
                    onClick={() => removeFile(i)}
                    aria-label={`Remove page ${i + 1}`}
                  >
                    <X size={14} strokeWidth={1.75} /> Remove
                  </button>
                )}
              </div>
            ))}
            <div
              className={`${styles.slotZone} ${dragOver ? styles.slotZoneActive : ''}`}
              onClick={() => { if (!busy) inputRef.current?.click(); }}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
            >
              {files.length === 0 ? <Camera size={22} strokeWidth={1.5} /> : <Plus size={22} strokeWidth={1.5} />}
              <div>{files.length === 0 ? 'Drop the delivery order, or click' : 'Add another page'}</div>
            </div>
          </div>

          {files.length > 0 && (
            <Button variant="primary" size="sm" onClick={() => void runScan()} disabled={busy}>
              {submitting ? 'Uploading…' : 'Scan delivery order'}
            </Button>
          )}

          {enqueuedJobIds.length > 0 && (
            <div>
              <div className={styles.sectionLabel} style={{ marginBottom: 6 }}>Scanned this session</div>
              <div className={styles.results}>
                {trackedJobs.length === 0 && (
                  <div className={styles.resultRow}>
                    <span className={`${styles.chip} ${styles.chipGrey}`}>Queued</span>
                    <div className={styles.resultMain}>Uploading — the reading finishes in the background.</div>
                  </div>
                )}
                {trackedJobs.map((j) => {
                  const active = isActiveJob(j);
                  const done = j.status === 'done';
                  const failed = j.status === 'error';
                  // A 'done' job with a linked GRN is a draft; 'done' with only a
                  // note is NEEDS-REVIEW (no doc created — matcher couldn't map a PO).
                  const needsReview = done && !j.linkedDocNo;
                  const chipClass = done ? (needsReview ? styles.chipYellow : styles.chipTeal) : failed ? styles.chipYellow : styles.chipGrey;
                  const chipLabel = active ? (j.status === 'running' ? 'Reading…' : 'Queued') : done ? (needsReview ? 'Review' : 'Draft') : failed ? 'Failed' : j.status;
                  return (
                    <div key={j.id} className={styles.resultRow}>
                      <span className={`${styles.chip} ${chipClass}`}>
                        {active && <Loader2 size={11} strokeWidth={2} className={styles.spin} style={{ marginRight: 4 }} />}
                        {done && !needsReview && <CheckCircle2 size={11} strokeWidth={2} style={{ marginRight: 4 }} />}
                        {chipLabel}
                      </span>
                      <div className={styles.resultMain}>
                        {done
                          ? (j.linkedDocNo
                              ? `Draft goods receipt ${j.linkedDocNo} — open it to review and post.`
                              : (j.error || 'Needs review — open the PO and receive by hand.'))
                          : failed
                            ? (j.error || "Couldn't read the delivery order.")
                            : 'Reading the delivery order…'}
                        {done && j.linkedDocNo && j.error && (
                          <div className={styles.resultSub}>{j.error}</div>
                        )}
                      </div>
                      <span style={{ flex: 'none', fontSize: 11, color: 'var(--fg-muted)' }}>
                        {jobTs(j.createdAt) ? hhmm(jobTs(j.createdAt)) : ''}
                      </span>
                    </div>
                  );
                })}
              </div>
              <p className={styles.sub} style={{ marginTop: 8 }}>
                Draft receipts land in the Goods Receipt list — open each to review every line, then post to receive stock.
              </p>
            </div>
          )}
        </div>

        <div className={styles.foot}>
          <Button variant="secondary" size="sm" onClick={onClose}>
            {enqueuedJobIds.length > 0 || submitting ? 'Close' : 'Cancel'}
          </Button>
          {enqueuedJobIds.length > 0 && (
            <Button variant="secondary" size="sm" onClick={() => { onClose(); navigate('/scm/grns'); }}>
              Go to Goods Receipts
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
