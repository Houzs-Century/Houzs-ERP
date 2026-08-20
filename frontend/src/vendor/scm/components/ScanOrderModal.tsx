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
  isActiveJob,
  jobTs,
  hhmm,
  type ScanJob,
  type ScanJobsResp,
} from '../lib/scan-jobs';
import styles from './ScanOrderModal.module.css';

const ICON = { size: 14, strokeWidth: 1.75 } as const;

/* ── Handoff contract with SalesOrderNew.tsx ───────────────────────────── */
export type ScanPrefillLine = {
  itemCode:       string;        // '' when no SKU matched — operator picks in the form
  itemGroup:      string;        // 'sofa' | 'bedframe' | 'mattress' | 'accessory' | 'service' | 'others'
  description:    string;
  qty:            number;
  unitPriceSen: number;        // RM handwriting × 100, rounded
  remark:         string;        // short "Slip: …" chip (rawText capped ~40c) + notes; full rawText below
  /* Verification + learning carry-through. rawText is the slip's verbatim row
     (the source of truth the edit-gate pairs against the corrected code);
     confidence/suggestedCode drive the per-line "scanned · NN%" chip in the
     New SO form and let it tell a confirmed AI match from an operator pick. */
  rawText:        string;
  fabricCode:     string;        // matched fabric ('' = none)
  suggestedCode:  string;        // the SKU code Claude suggested ('' = none)
  confidence:     number;        // 0-1 confidence of the suggested SKU
  /* Configured SOFA special-add-on CODES the slip remark resolved to (already
     validated server-side against the catalog + the line model's
     allowed_options.specials). The New SO line-seed auto-checks these specials.
     [] when none. */
  specialCodes:   string[];
};

/* SO-Maintenance-matched payment block → seeds ONE PaymentDraft row in the
   New SO Payments table (visible + editable + deletable there — no hidden
   writes). methodValue is the payment_method row VALUE (the immutable key
   PaymentsTable's methodLabel select stores: Merchant / Online /
   Installment / Cash); bank / plan / online sub-type are the L2 picks. */
export type ScanPrefillPayment = {
  methodValue:      string;
  bankValue:        string;        // payment_merchant value ('' = none)
  installmentLabel: string;        // installment_plan value, e.g. '12 months'
  onlineTypeValue:  string;        // online_type value ('' = none)
  approvalCode:     string;        // card-terminal approval / ref no. ('' = none)
  depositSen:     number;        // deposit on slip ×100 (0 = operator fills)
};

export type ScanPrefill = {
  customerName:   string;
  phone:          string;        // first phone, raw string
  phones:         string[];      // all phones (carried so the edit-gate sees the full set)
  address1:       string;
  /* Structured address parts → the New SO form's State / City / Postcode
     dropdowns. addressState is a real my_localities state VALUE (validated
     server-side; '' = no confident match → leave the dropdown alone). city /
     postcode are reconciled against the form's locality cascade for the chosen
     state ('' = none). */
  addressState:    string;
  addressCity:     string;
  addressPostcode: string;
  /* The customer's own order reference (e.g. "HC14032") → Customer SO Ref. */
  customerSoRef:  string;
  note:           string;        // genuine order remark only (+ unresolved venue / non-date delivery)
  deliveryDate:   string | null; // only when a clean YYYY-MM-DD
  /* The SLIP'S OWN written date (ExtractedSlip.slipDate), only when a clean
     YYYY-MM-DD. NOT the SO's Processing Date — desktop DERIVES that from
     Delivery − 6 weeks and never reads this field. */
  slipDate:       string | null;
  customerType:   string;        // customer_type value matched to SO Maintenance ('' = none)
  buildingType:   string;        // building_type value matched to SO Maintenance ('' = none)
  /* VENUE UNIFY — a REAL venue id from the SAME useVenues() master the New SO
     form's Venue dropdown renders ('' = no confident match → the form keeps
     its salesperson-default venue). The raw OCR location text never lands in
     the dropdown; it survives in the Note. */
  venueId:        string;
  payment:        ScanPrefillPayment | null;
  lines:          ScanPrefillLine[];
  // R2 key of the scanned slip image ('' = none/PDF). Carried onto the New SO
  // create body so the SO detail page can show it as "Original Slip" proof.
  slipImageKey:   string;
  // R2 key of the scanned card-terminal payment receipt ('' = none). Carried
  // onto the New SO create body so the SO detail page can show it as "Payment
  // Receipt" proof alongside the order slip.
  receiptImageKey: string;
  /* Edit-gate carry-through — the learning POST now fires from the New SO
     save. sampleId addresses the so_scan_samples row; salesperson rides along
     so the per-rep pool grows + rules re-distill; aiOriginal is the FROZEN
     AI-extracted slip the save compares the operator's final values against
     (no diff = no learning POST). */
  sampleId:       string | null;
  salesperson:    string | null;
  aiOriginal:     ExtractedSlip | null;
};

/* ── The AI-extraction shape ────────────────────────────────────────────────
   Kept here (and exported) because it is part of the ScanPrefill handoff
   contract SalesOrderNew.tsx reads back — `aiOriginal` is the frozen snapshot
   its save diffs against to decide whether to fire the edit-gate learning POST.
   This modal no longer calls /scan-so/extract itself; the background job does
   the reading. */
type SkuMatch = { code: string; confidence: number; reason: string };
type ExtractedLine = {
  rawText: string;
  qtyGuess: number;
  priceRmGuess: number | null;
  skuMatch: SkuMatch | null;
  fabricMatch: SkuMatch | null;
  /* Configured SOFA special add-ons the row asks for (validated server-side
     against the catalog + the line's model allowed_options.specials). [] when
     none — seeds the New SO line's checked specials. */
  specialsMatch: SkuMatch[];
  notes: string | null;
};
/* SO-Maintenance option match — value is a so_dropdown_options row VALUE,
   already validated server-side against the ACTIVE list. */
type OptionMatch = { value: string; confidence: number; reason: string };
export type ExtractedSlip = {
  customerName: string | null;
  address: string | null;
  /* Structured address parts (the New SO form fills State / City / Postcode
     from these). addressStateMatch is snapped server-side to the live
     my_localities state list (never-invent rule), city/postcode are free text
     reconciled against the form's locality cascade. */
  addressLine1: string | null;
  city: string | null;
  postcode: string | null;
  addressStateMatch: OptionMatch | null;
  phones: string[];
  location: string | null;
  deliveryDate: string | null;
  /* THE SLIP'S OWN DATE — the date the rep wrote on the handwritten slip.
     It is NOT the Sales Order's Processing Date (internal_expected_dd, the
     factory-start date), and NOT a card receipt's printed transaction date.
     All three were once called "processingDate"; the SO's is still called that,
     these two are not. */
  slipDate: string | null;
  salesRep: string | null;
  /* The customer's own order reference (top-right of the slip, e.g. "HC14032")
     → seeds the form's Customer SO Ref field. */
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
type SalespeopleResp = { success: boolean; data: { salespeople: string[] } };
/* POST /scan-so/enqueue — 202 the instant the photos land, BEFORE any OCR. */
type EnqueueResp = { job_id: string; status: string };

/* The OCR → New SO prefill MAPPING lives in one shared, pure reconciler
   (../lib/scan-prefill). It is called SERVER-side by the background job for both
   desktop and phone scans, so the mapping can never drift between the two. The
   ScanPrefill types above stay exported: they are the sessionStorage handoff
   contract SalesOrderNew.tsx reads. */

/* One queued order in the session: a single order slip + ZERO OR MORE payment
   receipts. `id` is a stable client key (independent of array index so removing
   an order doesn't reshuffle React keys). Mirrors mobile's OrderDraft (front +
   payShots[]): an order can be paid across several receipts (deposit + balance,
   split card terminals), and the background job books ONE payment per receipt.
   The /scan-so/enqueue contract is positional-agnostic — the slip is appended
   first, then every receipt, all under the `file` field. */
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
  // ONE hidden slip input + ONE hidden receipt input, both re-targeted to the
  // active order right before each pick (activeOrderIdRef).
  const slipInputRef = useRef<HTMLInputElement>(null);
  const receiptInputRef = useRef<HTMLInputElement>(null);
  const activeOrderIdRef = useRef<string | null>(null);

  // The session is an ARRAY of orders (one order in the common case). Each order
  // = one slip + an optional receipt. ONE order and TEN take the identical
  // background /enqueue path — there is no review-first branch any more.
  const [orders, setOrders] = useState<OrderRow[]>(() => [newOrder()]);
  const [dragOver, setDragOver] = useState<string | null>(null); // "<orderId>:<kind>" while dragging
  const [submitting, setSubmitting] = useState(false); // photo upload in flight
  const [error, setError] = useState<string | null>(null);
  // Per-order 409 duplicate_slip WARNING on /enqueue, keyed by OrderRow.id.
  const [orderErrors, setOrderErrors] = useState<Record<string, string>>({});
  // The order id currently being re-queued via "Create anyway" (force=1).
  const [forcingId, setForcingId] = useState<string | null>(null);
  // Job ids returned by /enqueue this session — the results list polls their
  // status via the shared /scan-so/jobs helper.
  const [enqueuedJobIds, setEnqueuedJobIds] = useState<string[]>([]);

  const multiOrder = orders.length > 1;

  // Salesperson — each rep has their own handwriting/notation habits, so the
  // extractor learns PER REP (rules + few-shot filtered to this rep). Owner
  // (2026-06-23): default this to whoever is logged in (the usual case — staff
  // scan their OWN slips), kept editable for the occasional someone-else slip.
  // It also rides into the prefill so the New SO save can attribute the
  // learning sample.
  const [salesperson, setSalesperson] = useState(() => user?.name ?? '');
  const [knownReps, setKnownReps] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    authedFetch<SalespeopleResp>('/scan-so/salespeople')
      .then((r) => { if (alive) setKnownReps(r.data.salespeople); })
      .catch(() => { /* datalist is a convenience — field stays free-text */ });
    return () => { alive = false; };
  }, []);

  // Pre-warm the Anthropic catalog prompt-cache the moment the modal opens, so
  // it's hot by the time the background job reads the slip. Fire-and-forget —
  // never blocks or errors the modal (it's a pure optimisation; a cold cache
  // just means the first job pays full price).
  useEffect(() => {
    authedFetch('/scan-so/warm', { method: 'POST' }).catch(() => { /* best-effort warm */ });
  }, []);

  /* ── Results — the SHARED background-job status poll ─────────────────────
     After /scan-so/enqueue the OCR + DRAFT create run server-side. We poll the
     SAME GET /scan-so/jobs endpoint the mobile Scan screen uses (via the shared
     normalizeJobs helper) and show only the jobs THIS session enqueued. Poll
     every 4s while any tracked job is still queued/running or hasn't surfaced
     yet; a fully-settled list stops the interval. */
  const repParam = salesperson.trim();
  const { data: jobsData } = useQuery({
    queryKey: ['scan-modal-jobs', repParam],
    enabled: enqueuedJobIds.length > 0,
    queryFn: () =>
      authedFetch<ScanJobsResp>(
        repParam ? `/scan-so/jobs?salesperson=${encodeURIComponent(repParam)}` : '/scan-so/jobs',
      ),
    staleTime: 0,
    retry: false, // fail-soft — a jobs hiccup just leaves the rows pending
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

  /* ── Slot capture ───────────────────────────────────────────────────────
     Re-target the hidden input to the active order, then open the file picker.
     The slip is a single file (a re-pick replaces it); receipts are a list —
     each pick APPENDS (the receipt input is `multiple`), and each receipt has
     its own remove control. */
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
    clearOrderError(orderId); // a new photo invalidates that order's dup warning
  };
  // Append accepted receipt files to an order (each = one payment). No cap — an
  // order can take as many receipts as it was paid across.
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
  // Never let the list go empty — removing the last order resets it to blank.
  const removeOrder = (orderId: string) => {
    if (submitting) return;
    setOrders((cur) => {
      const next = cur.filter((o) => o.id !== orderId);
      return next.length ? next : [newOrder()];
    });
    clearOrderError(orderId);
    setError(null);
  };

  /* ── The ONE scan path (single order or a stack) ─────────────────────────
     Reuse the SAME endpoint mobile uses: POST /scan-so/enqueue per order
     returns a job id, and the OCR + DRAFT SO create finish server-side. The
     await below is the PHOTO UPLOAD only — never the model round-trip — so the
     operator is free in seconds and may close this modal at once: the job row
     is durable before we respond, and the draft + its private notice land on
     their own. A 409 duplicate_slip refusal for one order is surfaced inline on
     that order's card (the others still enqueue). While the modal stays open the
     results list polls /scan-so/jobs for the drafts as they land in Orders. */
  // One /scan-so/enqueue POST for an order. force=1 = the operator confirmed
  // "create anyway" on a duplicate-slip warning, so the backend skips its hard
  // reject and queues the order (owner 2026-07-15: duplicate = warn, not block).
  const enqueueOrder = async (order: OrderRow, force = false): Promise<EnqueueResp> => {
    const fd = new FormData();
    // Downscale first — same helper mobile uses, so both surfaces send the model
    // the same shape of image. A PDF drop passes through untouched. The slip is
    // appended first, then EVERY receipt (each becomes one payment on the draft):
    // the same repeated-`file` shape mobile's enqueueOne sends, so desktop and
    // mobile hit the identical enqueue contract.
    fd.append('file', await compressForOcr(order.slip!));  // order slip first
    for (const receipt of order.receipts) {
      fd.append('file', await compressForOcr(receipt));    // one file per payment receipt
    }
    const repTyped = salesperson.trim();
    if (repTyped) fd.append('salesperson', repTyped);
    if (force) fd.append('force', '1');
    return authedFetch<EnqueueResp>('/scan-so/enqueue', { method: 'POST', body: fd });
  };

  // "Create anyway" — re-queue a duplicate-slip-warned order with force=1. On
  // success the card drops off (like a normal queue) and its warning clears; the
  // background job still marks it a soft duplicate for the trail.
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
            // Track EACH job the instant it is accepted, not after the whole
            // stack uploads — the results list starts polling straight away and
            // a mid-stack close still leaves the queued ones accounted for.
            setEnqueuedJobIds((prev) => [...prev, r.job_id]);
          }
        } catch (e) {
          const err = e as Error & { status?: number; body?: string };
          // 409 duplicate_slip = this order's slip already created an SO. Owner
          // 2026-07-15: WARN, don't block — keep it on screen with the reason +
          // a "Create anyway" button (force=1); the OTHER orders still enqueue.
          if (err.status === 409 && typeof err.body === 'string' && err.body.includes('duplicate_slip')) {
            let reason = 'This slip was already uploaded.';
            try {
              const b = JSON.parse(err.body) as { reason?: string };
              if (typeof b.reason === 'string' && b.reason.trim() !== '') reason = b.reason;
            } catch { /* body wasn't JSON — keep the fallback wording */ }
            dupErrors[order.id] = reason;
            continue;
          }
          throw e;
        }
      }

      if (Object.keys(dupErrors).length > 0) {
        // Keep ONLY the refused orders on screen (with their inline reason); the
        // queued ones are already running server-side and appear in the results
        // list below.
        setOrders((cur) => {
          const keep = cur.filter((o) => dupErrors[o.id]);
          return keep.length ? keep : [newOrder()];
        });
        setOrderErrors(dupErrors);
        if (newJobIds.length === 0) return;
      } else {
        // All queued cleanly — reset the capture area to a fresh blank order.
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

  /* The single "Order slip" slot — a dashed dropzone when empty, a solid
     filename card with a remove control when filled. */
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

  /* The "Payment receipts" slot — a LIST of receipt cards (each removable, each
     becoming one payment on the draft) plus an "add another receipt" dropzone.
     Optional: an order with no receipt still lands a draft with no payment. */
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

          {/* Hidden inputs — one for slips, one for receipts, both re-targeted to
              the active order before each pick. */}
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

          {/* One card per queued order, each grouping its labeled slip + receipt
              slots. The single order in the common case renders the same way,
              without a removable header. */}
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

          {/* Add another order → one more slip on the same background queue. */}
          <button
            type="button"
            className={styles.addOrderBtn}
            onClick={addOrder}
            disabled={busy}
          >
            <Plus size={ICON.size} strokeWidth={ICON.strokeWidth} /> Add another order
          </button>

          {/* Results — the shared /scan-so/jobs poll. Shown once anything has
              been enqueued this session. Closing the modal does NOT stop these
              jobs; it only stops watching them here. */}
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
