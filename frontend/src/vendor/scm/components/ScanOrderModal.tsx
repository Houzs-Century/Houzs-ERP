// ----------------------------------------------------------------------------
// ScanOrderModal — "Scan Order" on the Sales Orders list.
//
// Handwritten-slip OCR flow. EVERY scan is a BACKGROUND job — the SAME path the
// mobile Scan screen (MobileScan.tsx) uses, no desktop-only variant:
//   1. Operator drops / snaps photo(s) of a showroom sale-order slip
//      (jpeg/png/webp, PDF also accepted). The salesperson defaults to the
//      logged-in user (staff scan their OWN slips); kept editable for the
//      occasional someone-else slip.
//   2. POST /scan-so/enqueue per order uploads the photos, queues a server-side
//      job and returns 202 {job_id} BEFORE any OCR runs. The await is the photo
//      upload only — seconds, not the model round-trip.
//   3. The Worker's waitUntil pipeline does the OCR, reconciles it against the
//      live catalog and mints the DRAFT SO on its own. The operator can close
//      this modal (or the tab) the moment the upload lands — the draft appears
//      in Orders and a private "Sales order saved — <doc no>" notice + Profile
//      badge announces it (postScanNotice). While the modal is open it also
//      polls GET /scan-so/jobs for a live results list.
//
// ── ONE LOGIC LAYER (2026-07-16) ────────────────────────────────────────────
// This modal USED to split: a single order ran a BLOCKING POST /scan-so/extract
// (the operator watched a "Scanning slip…" spinner, and the whole result lived
// only in this component's memory — closing the modal threw the scan away),
// while two or more orders went to /enqueue. Owner: "電話版本可以跑後面為什麼
// 這裡不可以" + "然後我點了 cancel 關掉就不見了". The extract branch is GONE;
// one order and ten orders take the identical background path, so a scan is
// durable server-side before this modal can be closed.
//
// There is NO in-modal review (Task #73 — owner: "整个流程不可以走后门 / OCR
// 生成的 SO Draft 全部都不是按照 drop down 选项来做的"). The drafts land in
// Orders and every field is reviewed + corrected in the real New SO form, where
// every input is dropdown-bound. The OCR → dropdown-value reconciliation now
// runs SERVER-side inside the job (the shared reconciler), exactly as it does
// for a phone scan — it is no longer this modal's job.
//
// The modal NEVER creates the SO itself — the background job mints a DRAFT and
// every field is reviewed in the normal New SO form, where pricing, variants and
// validation run as usual.
//
// ── MOBILE PARITY ───────────────────────────────────────────────────────────
// Capabilities mirrored from MobileScan (the CAPABILITY, not the mobile layout —
// this modal keeps its own styling):
//
//   1. LABELED SLOTS — the single undifferentiated dropzone is split into a
//      labeled "Order slip" slot + an optional "Payment receipts" slot (mirrors
//      mobile's Front/Payment split). The slip is one file; the receipts are a
//      LIST — an order paid across several receipts (deposit + balance, split
//      terminals) books one payment per receipt. Upload shape: the slip file
//      first, then every receipt file, all under `file` (same repeated-`file`
//      contract mobile's enqueueOne uses — no positional dependence).
//
//   2. BACKGROUND JOBS — "Add another order" queues as many orders as the
//      operator has slips; ONE order takes the same path. POST /scan-so/enqueue
//      per order, then poll GET /scan-so/jobs via the shared scan-jobs.ts
//      helpers for a live results list. There is NO new backend flow and no
//      desktop-only flow — the exact endpoints + shared job helpers mobile uses.
//
//   3. DUPLICATE WARNING — /scan-so/enqueue answers 409 duplicate_slip when this
//      exact slip photo already minted an SO. That is a WARNING, never a block
//      (owner 2026-07-15): the order stays on screen with the reason (which
//      names the existing order) and a "Create anyway" button that re-sends the
//      same upload with force=1. The background job still flags it a soft
//      duplicate so the trail survives. Same policy as the backend + mobile.
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Camera, CheckCircle2, Loader2, Plus, Receipt, Upload, X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { useAuth } from '../../../auth/AuthContext';
import { authedFetch } from '../lib/authed-fetch';
import { sortByText } from '../lib/sort-options';
import { compressForOcr } from '../../shared/image-compress';
import {
  normalizeJobs,
  normalizeScanSalespeople,
  isActiveJob,
  jobTs,
  hhmm,
  SCAN_SALESPEOPLE_PATH,
  type ScanJob,
  type ScanJobsResp,
} from '../lib/scan-jobs';
import styles from './ScanOrderModal.module.css';

const ICON = { size: 14, strokeWidth: 1.75 } as const;

export type ScanPrefillLine = {
  itemCode:       string;
  itemGroup:      string;
  description:    string;
  qty:            number;
  unitPriceSen: number;
  remark:         string;
  rawText:        string;
  fabricCode:     string;
  suggestedCode:  string;
  confidence:     number;
  specialCodes:   string[];
};

export type ScanPrefillPayment = {
  methodValue:      string;
  bankValue:        string;
  installmentLabel: string;
  onlineTypeValue:  string;
  approvalCode:     string;
  depositSen:     number;
};

export type ScanPrefill = {
  customerName:   string;
  phone:          string;
  phones:         string[];
  address1:       string;
  addressState:    string;
  addressCity:     string;
  addressPostcode: string;
  customerSoRef:  string;
  note:           string;
  deliveryDate:   string | null;
  slipDate:       string | null;
  customerType:   string;
  buildingType:   string;
  venueId:        string;
  payment:        ScanPrefillPayment | null;
  lines:          ScanPrefillLine[];
  slipImageKey:   string;
  receiptImageKey: string;
  sampleId:       string | null;
  salesperson:    string | null;
  aiOriginal:     ExtractedSlip | null;
};

type SkuMatch = { code: string; confidence: number; reason: string };
type ExtractedLine = {
  rawText: string;
  qtyGuess: number;
  priceRmGuess: number | null;
  skuMatch: SkuMatch | null;
  fabricMatch: SkuMatch | null;
  specialsMatch: SkuMatch[];
  notes: string | null;
};
type OptionMatch = { value: string; confidence: number; reason: string };
export type ExtractedSlip = {
  customerName: string | null;
  address: string | null;
  addressLine1: string | null;
  city: string | null;
  postcode: string | null;
  addressStateMatch: OptionMatch | null;
  phones: string[];
  location: string | null;
  deliveryDate: string | null;
  slipDate: string | null;
  salesRep: string | null;
  customerSoRef: string | null;
  paymentMethod: string | null;
  depositRm: number | null;
  totalRm: number | null;
  remarks: string | null;
  approvalCode: string | null;
  paymentMethodMatch: OptionMatch | null;
  bankMatch: OptionMatch | null;
  onlineTypeMatch: OptionMatch | null;
  installmentPlanMatch: OptionMatch | null;
  customerTypeMatch: OptionMatch | null;
  buildingTypeMatch: OptionMatch | null;
  locationMatch: OptionMatch | null;
  lines: ExtractedLine[];
};
type EnqueueResp = { job_id: string; status: string };


type OrderRow = { id: string; slip: File | null; receipts: File[] };
let ORDER_SEQ = 0;
const newOrder = (): OrderRow => ({ id: `ord-${++ORDER_SEQ}-${Date.now()}`, slip: null, receipts: [] });

const ACCEPT = 'image/jpeg,image/png,image/webp,application/pdf';
const isAcceptedFile = (f: File): boolean =>
  /^image\/(jpeg|png|webp)$/.test(f.type) ||
  f.type === 'application/pdf' ||
  /\.(jpe?g|png|webp|pdf)$/i.test(f.name);

interface Props {
  onClose: () => void;
}

export const ScanOrderModal = ({ onClose }: Props) => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const slipInputRef = useRef<HTMLInputElement>(null);
  const receiptInputRef = useRef<HTMLInputElement>(null);
  const activeOrderIdRef = useRef<string | null>(null);

  const [orders, setOrders] = useState<OrderRow[]>(() => [newOrder()]);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [orderErrors, setOrderErrors] = useState<Record<string, string>>({});
  const [forcingId, setForcingId] = useState<string | null>(null);
  const [enqueuedJobIds, setEnqueuedJobIds] = useState<string[]>([]);

  const multiOrder = orders.length > 1;

  const [salesperson, setSalesperson] = useState(() => user?.name ?? '');
  const [knownReps, setKnownReps] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    authedFetch<unknown>(SCAN_SALESPEOPLE_PATH)
      .then((r) => { if (alive) setKnownReps(normalizeScanSalespeople(r)); })
      .catch(() => { });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    authedFetch('/scan-so/warm', { method: 'POST' }).catch(() => { });
  }, []);

  const repParam = salesperson.trim();
  const { data: jobsData } = useQuery({
    queryKey: ['scan-modal-jobs', repParam],
    enabled: enqueuedJobIds.length > 0,
    queryFn: () =>
      authedFetch<ScanJobsResp>(
        repParam ? `/scan-so/jobs?salesperson=${encodeURIComponent(repParam)}` : '/scan-so/jobs',
      ),
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

  const pickSlip = (orderId: string) => {
    if (submitting) return;
    activeOrderIdRef.current = orderId;
    slipInputRef.current?.click();
  };
  const pickReceipt = (orderId: string) => {
    if (submitting) return;
    activeOrderIdRef.current = orderId;
    receiptInputRef.current?.click();
  };
  const clearOrderError = (orderId: string) =>
    setOrderErrors((cur) => {
      if (!cur[orderId]) return cur;
      const next = { ...cur };
      delete next[orderId];
      return next;
    });
  const setSlip = (orderId: string, file: File | null) => {
    setOrders((cur) => cur.map((o) => (o.id === orderId ? { ...o, slip: file } : o)));
    setError(null);
    clearOrderError(orderId);
  };
  const addReceipts = (orderId: string, files: File[]) => {
    const accepted = files.filter(isAcceptedFile);
    if (accepted.length === 0) return;
    setOrders((cur) => cur.map((o) => (o.id === orderId ? { ...o, receipts: [...o.receipts, ...accepted] } : o)));
    setError(null);
    clearOrderError(orderId);
  };
  const removeReceipt = (orderId: string, index: number) => {
    if (submitting) return;
    setOrders((cur) =>
      cur.map((o) => (o.id === orderId ? { ...o, receipts: o.receipts.filter((_, k) => k !== index) } : o)),
    );
    clearOrderError(orderId);
  };
  const onSlipFile = (file: File | undefined) => {
    const orderId = activeOrderIdRef.current;
    if (!orderId || !file) return;
    if (!isAcceptedFile(file)) { setError('Unsupported file — use a JPEG, PNG, WEBP or PDF.'); return; }
    setSlip(orderId, file);
  };
  const onReceiptFiles = (list: FileList | null) => {
    const orderId = activeOrderIdRef.current;
    if (!orderId || !list) return;
    addReceipts(orderId, Array.from(list));
  };
  const onDropSlip = (orderId: string, list: FileList | null) => {
    setDragOver(null);
    const file = Array.from(list ?? []).find(isAcceptedFile);
    if (file) setSlip(orderId, file);
  };
  const onDropReceipts = (orderId: string, list: FileList | null) => {
    setDragOver(null);
    addReceipts(orderId, Array.from(list ?? []));
  };

  const addOrder = () => {
    if (submitting) return;
    setOrders((cur) => [...cur, newOrder()]);
    setError(null);
  };
  const removeOrder = (orderId: string) => {
    if (submitting) return;
    setOrders((cur) => {
      const next = cur.filter((o) => o.id !== orderId);
      return next.length ? next : [newOrder()];
    });
    clearOrderError(orderId);
    setError(null);
  };

  // One /scan-so/enqueue POST for an order. force=1 = the operator confirmed
  // "create anyway" on a duplicate-slip warning, so the backend skips its hard
  // reject and queues the order (owner 2026-07-15: duplicate = warn, not block).
  const enqueueOrder = async (order: OrderRow, force = false): Promise<EnqueueResp> => {
    const fd = new FormData();
    fd.append('file', await compressForOcr(order.slip!));
    for (const receipt of order.receipts) {
      fd.append('file', await compressForOcr(receipt));
    }
    const repTyped = salesperson.trim();
    if (repTyped) fd.append('salesperson', repTyped);
    if (force) fd.append('force', '1');
    return authedFetch<EnqueueResp>('/scan-so/enqueue', { method: 'POST', body: fd });
  };

  const createAnyway = async (orderId: string) => {
    const order = orders.find((o) => o.id === orderId);
    if (!order || !order.slip || forcingId) return;
    setForcingId(orderId);
    try {
      const r = await enqueueOrder(order, true);
      if (r?.job_id) setEnqueuedJobIds((prev) => [...prev, r.job_id]);
    } catch {
      setForcingId(null);
      setError('The order still could not be queued. Please try again.');
      return;
    }
    setForcingId(null);
    setOrderErrors((cur) => {
      const next = { ...cur };
      delete next[orderId];
      return next;
    });
    setOrders((cur) => {
      const keep = cur.filter((o) => o.id !== orderId);
      return keep.length ? keep : [newOrder()];
    });
  };

  // Queue EVERY readied order. One slip or ten — the identical path (owner
  // 2026-07-16: "電話版本可以跑後面為什麼這裡不可以"). Sequential so a stack of
  // photos doesn't open ten parallel uploads on showroom wifi.
  const runScan = async () => {
    if (submitting) return;
    const queueable = orders.filter((o) => o.slip);
    if (queueable.length === 0) return;
    setSubmitting(true);
    setError(null);
    setOrderErrors({});
    const dupErrors: Record<string, string> = {};
    const newJobIds: string[] = [];
    try {
      for (const order of queueable) {
        try {
          const r = await enqueueOrder(order);
          if (r?.job_id) {
            newJobIds.push(r.job_id);
            setEnqueuedJobIds((prev) => [...prev, r.job_id]);
          }
        } catch (e) {
          const err = e as Error & { status?: number; body?: string };
          if (err.status === 409 && typeof err.body === 'string' && err.body.includes('duplicate_slip')) {
            let reason = 'This slip was already uploaded.';
            try {
              const b = JSON.parse(err.body) as { reason?: string };
              if (typeof b.reason === 'string' && b.reason.trim() !== '') reason = b.reason;
            } catch { }
            dupErrors[order.id] = reason;
            continue;
          }
          throw e;
        }
      }

      if (Object.keys(dupErrors).length > 0) {
        setOrders((cur) => {
          const keep = cur.filter((o) => dupErrors[o.id]);
          return keep.length ? keep : [newOrder()];
        });
        setOrderErrors(dupErrors);
        if (newJobIds.length === 0) return;
      } else {
        setOrders([newOrder()]);
      }

      if (newJobIds.length === 0 && Object.keys(dupErrors).length === 0) {
        setError("Couldn't read the slip — try again.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const busy = submitting;
  const ready = orders.length > 0 && orders.every((o) => o.slip !== null);

  const renderSlipSlot = (order: OrderRow) => {
    const key = `${order.id}:slip`;
    return (
      <div className={styles.slot}>
        <span className={styles.slotLabel}>Order slip</span>
        {order.slip ? (
          <div className={styles.slotFilled}>
            <Camera size={20} strokeWidth={1.5} />
            <span className={styles.slotFileName}>{order.slip.name}</span>
            {!busy && (
              <button
                type="button"
                className={styles.removeBtn}
                onClick={() => setSlip(order.id, null)}
                aria-label="Remove Order slip"
              >
                <X size={14} strokeWidth={1.75} /> Remove
              </button>
            )}
          </div>
        ) : (
          <div
            className={`${styles.slotZone} ${dragOver === key ? styles.slotZoneActive : ''}`}
            onClick={() => pickSlip(order.id)}
            onDragOver={(e) => { e.preventDefault(); setDragOver(key); }}
            onDragLeave={() => setDragOver((cur) => (cur === key ? null : cur))}
            onDrop={(e) => { e.preventDefault(); onDropSlip(order.id, e.dataTransfer.files); }}
          >
            <Camera size={22} strokeWidth={1.5} />
            <div>Drop the slip, or click</div>
          </div>
        )}
      </div>
    );
  };

  const renderReceiptSlot = (order: OrderRow) => {
    const key = `${order.id}:receipt`;
    const count = order.receipts.length;
    return (
      <div className={styles.slot}>
        <span className={styles.slotLabel}>
          Payment receipts
          <span className={styles.slotLabelOptional}>
            {count === 0 ? ' · optional' : ` · ${count} payment${count === 1 ? '' : 's'}`}
          </span>
        </span>
        {order.receipts.map((file, i) => (
          <div key={`${file.name}-${i}`} className={styles.slotFilled}>
            <Receipt size={20} strokeWidth={1.5} />
            <span className={styles.slotFileName}>{file.name}</span>
            {!busy && (
              <button
                type="button"
                className={styles.removeBtn}
                onClick={() => removeReceipt(order.id, i)}
                aria-label={`Remove payment receipt ${i + 1}`}
              >
                <X size={14} strokeWidth={1.75} /> Remove
              </button>
            )}
          </div>
        ))}
        <div
          className={`${styles.slotZone} ${dragOver === key ? styles.slotZoneActive : ''}`}
          onClick={() => pickReceipt(order.id)}
          onDragOver={(e) => { e.preventDefault(); setDragOver(key); }}
          onDragLeave={() => setDragOver((cur) => (cur === key ? null : cur))}
          onDrop={(e) => { e.preventDefault(); onDropReceipts(order.id, e.dataTransfer.files); }}
        >
          {count === 0 ? <Receipt size={22} strokeWidth={1.5} /> : <Plus size={22} strokeWidth={1.5} />}
          <div>{count === 0 ? 'Card receipt (optional) — one per payment' : 'Add another receipt'}</div>
        </div>
      </div>
    );
  };

  return (
    <div className={styles.modal} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={styles.panel}>
        <div className={styles.head}>
          <div>
            <div className={styles.eyebrow}>Sales Orders</div>
            <h2 className={styles.title}>Scan Order</h2>
            <p className={styles.sub}>
              Photo a handwritten sale-order slip and we read it in the background —
              each slip becomes a draft order in Orders, ready to review. You can
              close this window as soon as the photos finish uploading.
            </p>
          </div>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close">
            <X size={18} strokeWidth={1.75} />
          </button>
        </div>

        <div className={styles.body}>
          {error && <div className={styles.error}>{error}</div>}

          <input
            ref={slipInputRef}
            type="file"
            accept={ACCEPT}
            style={{ display: 'none' }}
            onChange={(e) => { onSlipFile(e.target.files?.[0]); e.target.value = ''; }}
          />
          <input
            ref={receiptInputRef}
            type="file"
            accept={ACCEPT}
            multiple
            style={{ display: 'none' }}
            onChange={(e) => { onReceiptFiles(e.target.files); e.target.value = ''; }}
          />

          <label className={styles.field}>
            <span className={styles.fieldLabel}>Salesperson</span>
            <input
              className={styles.input}
              list="scan-so-salespeople"
              value={salesperson}
              onChange={(e) => setSalesperson(e.target.value)}
            />
          </label>
          <datalist id="scan-so-salespeople">
            {sortByText(knownReps).map((r) => <option key={r} value={r} />)}
          </datalist>

          {orders.map((order, oi) => (
            <div key={order.id} className={styles.orderCard}>
              {multiOrder && (
                <div className={styles.orderHead}>
                  <span className={styles.orderTitle}>Order {oi + 1}</span>
                  {!busy && (
                    <button
                      type="button"
                      className={styles.removeOrderBtn}
                      onClick={() => removeOrder(order.id)}
                    >
                      <X size={12} strokeWidth={1.75} /> Remove
                    </button>
                  )}
                </div>
              )}
              <div className={styles.slotGrid}>
                {renderSlipSlot(order)}
                {renderReceiptSlot(order)}
              </div>
              {orderErrors[order.id] && (
                <div className={styles.warn}>
                  <AlertTriangle size={18} strokeWidth={1.75} style={{ flex: 'none', marginTop: 1 }} />
                  <div style={{ flex: 1 }}>
                    <p className={styles.warnTitle}>Possible duplicate</p>
                    <p className={styles.warnBody}>
                      {orderErrors[order.id]} Whether to open it again is your call — create a
                      new order anyway, or change the photo if it is the same order.
                    </p>
                    <div className={styles.warnActions}>
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => void createAnyway(order.id)}
                        disabled={forcingId === order.id}
                      >
                        {forcingId === order.id ? 'Creating…' : 'Create anyway'}
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}

          <button
            type="button"
            className={styles.addOrderBtn}
            onClick={addOrder}
            disabled={busy}
          >
            <Plus size={ICON.size} strokeWidth={ICON.strokeWidth} /> Add another order
          </button>

          {enqueuedJobIds.length > 0 && (
            <div>
              <div className={styles.sectionLabel} style={{ marginBottom: 6 }}>
                Scanned this session
              </div>
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
                  const chipClass = done ? styles.chipTeal : failed ? styles.chipYellow : styles.chipGrey;
                  const chipLabel = active ? (j.status === 'running' ? 'Reading…' : 'Queued') : done ? 'Done' : failed ? 'Failed' : j.status;
                  return (
                    <div key={j.id} className={styles.resultRow}>
                      <span className={`${styles.chip} ${chipClass}`}>
                        {active && <Loader2 size={11} strokeWidth={2} className={styles.spin} style={{ marginRight: 4 }} />}
                        {done && <CheckCircle2 size={11} strokeWidth={2} style={{ marginRight: 4 }} />}
                        {chipLabel}
                      </span>
                      <div className={styles.resultMain}>
                        {done
                          ? (j.soDocNo ? `${j.soDocNo} — saved to Orders` : 'Saved to Orders')
                          : failed
                            ? (j.error || "Couldn't read the slip.")
                            : 'Reading the slip…'}
                        {j.duplicateOf && (
                          <div className={styles.resultSub}>Possible duplicate of {j.duplicateOf}</div>
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
                Drafts land in Orders — open each to review every field before finalising.
              </p>
            </div>
          )}

          <p className={styles.sub} style={{ marginTop: 4 }}>
            Each order takes an order slip and, optionally, one or more card-terminal
            payment receipts — each receipt becomes its own payment on the draft. We
            read every slip and save a draft order per slip in the background — you do
            not have to wait here for it.
          </p>
        </div>

        <div className={styles.foot}>
          {/* "Cancel" ONLY while nothing has been sent yet — then it really does
              cancel. The moment an upload is in flight the label becomes
              "Close", because closing no longer stops anything: each enqueued
              job is already durable server-side and finishes on its own (owner
              2026-07-16: "然後我點了 cancel 關掉就不見了"). */}
          <Button variant="secondary" size="sm" onClick={onClose}>
            {enqueuedJobIds.length > 0 || submitting ? 'Close' : 'Cancel'}
          </Button>
          {enqueuedJobIds.length > 0 && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => { onClose(); navigate('/scm/sales-orders'); }}
            >
              View Orders
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            onClick={() => void runScan()}
            disabled={!ready || busy}
          >
            {busy
              ? <Loader2 size={ICON.size} strokeWidth={ICON.strokeWidth} className={styles.spin} />
              : <Upload size={ICON.size} strokeWidth={ICON.strokeWidth} />}
            <span>
              {submitting
                ? 'Uploading…'
                : multiOrder
                  ? `Scan & save ${orders.length} drafts`
                  : 'Scan & save draft'}
            </span>
          </Button>
        </div>
      </div>
    </div>
  );
};
