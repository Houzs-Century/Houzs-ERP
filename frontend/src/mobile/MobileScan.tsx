import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { authedFetch } from "../vendor/scm/lib/authed-fetch";
import { useAuth } from "../auth/AuthContext";
import { splitE164 } from "../vendor/shared/phone";
import { compressAllForOcr } from "../vendor/shared/image-compress";
import type { ExtractedSlip } from "../vendor/scm/components/ScanOrderModal";
import {
  reconcileScanPrefill,
  reconcilePayment,
  type ReconcileCatalogs,
} from "../vendor/scm/lib/scan-prefill";
import { useSoDropdownOptions, optionsOrFallback } from "../vendor/scm/lib/so-dropdown-options-queries";
import { useLocalities, distinctStates } from "../vendor/scm/lib/localities-queries";
import { useVenues } from "../vendor/scm/lib/venues-queries";
import { createDraftFromPrefill } from "./MobileNewSO";
import { newIdempotencyKey } from "../lib/idempotency";
import { serviceNotify } from "../vendor/scm/lib/dialog-service";
import {
  normalizeJobs,
  jobTs,
  isTodayTs,
  hhmm,
  isActiveJob,
  type ScanJob,
  type ScanJobsResp,
} from "../vendor/scm/lib/scan-jobs";
import "./mobile.css";

// Re-export the shared job helpers so existing consumers that import them from
// MobileScan (MobileSalesOrders) keep working after the move to scan-jobs.ts.
export { normalizeJobs };
export type { ScanJob, ScanJobsResp };

// Mobile OCR "Scan" screen — capture phone photos of a handwritten sales
// slip and POST them to /scan-so/enqueue: the upload returns in seconds with a
// job id and the OCR + DRAFT SO create finish SERVER-SIDE inside the Worker's
// waitUntil (owner 2026-07-04: "upload 了直接关掉 App,后台自己慢慢跑"). The
// operator does NOT review the form first — each order lands in Orders as a
// DRAFT when its job finishes, and closing the app no longer kills anything.
//
// The legacy on-screen flow (await /scan-so/extract per payment slip, then
// createDraftFromPrefill client-side) is kept verbatim as submitLegacy — the
// automatic fallback when /enqueue 404s (a worker without the route yet).
// createDraftFromPrefill sends asDraft: true (status DRAFT — the backend
// drafts ONLY on that explicit flag, never on empty dates alone).
//
// SURVIVES NAVIGATION — the create fetch is FIRED (not awaited before we leave):
// once it's in flight it completes even if the operator has navigated away or
// pressed Cancel in-app, so a draft still lands in Orders. (One limitation: a
// full app/tab CLOSE mid-flight can still drop an in-flight create — only a
// server-side job would fully survive that. See the report note.)
//
// MULTIPLE ORDERS PER SESSION — the operator often has a stack of slips. This
// screen models the session as an ARRAY of orders, each its own front slip +
// payment-slip array: OrderDraft = { front, payShots[] }. "+ Add order" queues
// another order; each order is captured and grouped under its own "Order N"
// header. The "each payment slip = one payment" rule stays PER ORDER.
//
// MULTIPLE PAYMENT SLIPS (per order) — an order can take 2-3 payments (deposit +
// balances), and each physical slip / card-terminal receipt is ONE payment. The
// front slip stays single per order; the payment slip is an ARRAY (add-more +
// per-slip remove).
//
// PRIMARY PATH (/scan-so/enqueue): enqueueOne uploads the front slip + EVERY
// payment slip in one multipart POST (all under `file`). The background job now
// OCRs EACH receipt and books ONE payment per receipt (each with its own amount /
// bank / approval), so N slips → N payments server-side. This is the SAME
// repeated-`file` enqueue contract the desktop Scan Order modal sends — one logic
// layer, no mobile-only shape.
//
// LEGACY FALLBACK (/scan-so/extract, submitLegacy, only when /enqueue 404s on a
// stale worker): that older contract reads exactly ONE order slip + ONE payment
// receipt into a SINGLE payment, so we OCR each payment slip in its OWN /extract
// call (the front slip attached to every call), then merge — the FIRST call
// supplies the order + payment #1, calls 2..N each supply one more payment. Same
// end result (N payments per N slips) via the 1-slip+1-receipt contract verbatim.
//
// DELETE — every uploaded thumbnail (front + payment, in every order) carries a
// small "×" remove control so a wrong capture can be dropped before submitting.
//
// MULTI-ORDER — because we now create the draft ourselves (no single-prefill
// handoff limit), EVERY queued order becomes its own DRAFT: we OCR each order
// and fire one createDraftFromPrefill per order. N orders → N drafts in Orders.
//
// Camera capture uses a hidden <input type="file" accept="image/*"> per slot —
// the standard PWA pattern. The FRONT slip input keeps capture="environment"
// (one slip, straight to the rear camera); the PAYMENT input is `multiple`
// WITHOUT capture so the OS picker can offer gallery multi-select (owner: pick
// all the payment photos in one go — capture forces a one-shot camera and
// ignores `multiple`). No getUserMedia / live video.
//
// The multipart POST reuses authedFetch: it stamps the bearer from
// localStorage['auth:token'], leaves the multipart content-type to the browser
// (so the boundary is set correctly), and applies the long scan timeout for the
// /scan- path. A missing ANTHROPIC_API_KEY (staging) returns 503
// anthropic_key_missing, which we surface as a clear "not available here" note.

type Shot = { file: File; url: string };
type Slot = Shot | null;

/* A picked file can now be a PDF (desktop parity — a PDF slip / e-receipt), and
   an object-URL of a PDF rendered into an <img> is a broken thumbnail. So the
   preview branches on this: image → the <img>, PDF → a document tile with the
   filename. */
const isPdfShot = (s: Shot): boolean =>
  s.file.type === "application/pdf" || /\.pdf$/i.test(s.file.name);

/* One queued order in the session: a single front slip + its payment slips.
   `id` is a stable client key for React lists + remove (independent of array
   index so removing an order doesn't reshuffle keys).

   `id` and `idempotencyKey` are deliberately SEPARATE and must stay so. `id` is
   a React list key + the key of the orderErrors map; reusing it as the order key
   would work by accident today and teach the next reader that a UI key carries
   order semantics — the same trap MobileNewSO.Payment records (BUG-HISTORY
   2026-07-17, fix/p1-so-create-idem). `idempotencyKey` is a real
   crypto.randomUUID and means "this scanned slip becomes ONE draft order". */
type OrderDraft = { id: string; idempotencyKey: string; front: Slot; payShots: Shot[] };

let ORDER_SEQ = 0;
/* The ONLY birth site of an OrderDraft (all 6 call sites verified; every other
   setOrders is a `{ ...o }` spread that carries the key through), so the key
   lives exactly as long as the object the operator thinks of as "this order":
   the same one for as long as the order sits on screen, and resetOrders() after
   a submit mints a fresh one — so the next scan is a genuinely new order. */
const newOrder = (): OrderDraft => ({
  id: `ord-${++ORDER_SEQ}-${Date.now()}`,
  idempotencyKey: newIdempotencyKey(),
  front: null,
  payShots: [],
});

/* ── "Recent scans" background-job status list ─────────────────────────────
   After /scan-so/enqueue the OCR runs server-side; without feedback the phone
   is blind while it does (owner 2026-07-04). The screen now polls
   GET /scan-so/jobs?salesperson= (latest 20) and shows TODAY's jobs at the top:

     queued / running  — always listed (grey pill / teal "Reading…" spinner).
     done              — the job IS a draft in Orders now, so it must not
                         linger here: shown ONCE briefly ("Done → SO-xxxx,
                         saved to Orders", tappable → that order), dropped
                         ~10s after first seen on this visit, and never shown
                         at all once ~2 minutes past its finish (covers the
                         next screen open).
     error / duplicate — the operator MUST see failures, so these stay put for
                         the whole visit (no 10s/2min expiry) and are only
                         dismissed once a FULL later visit has come and gone
                         (see SCAN_VISIT below). A done job that carries a
                         warning (duplicateOf, or a payment note in `error`)
                         is treated the same sticky way.

   Poll cadence: refetchInterval 4000 ONLY while a listed job is queued or
   running; otherwise no interval. Section hides entirely when nothing is
   visible. Fields are dual-read camelCase ?? snake_case (pg camelCase rule)
   even though jobToJson camelizes today. The ScanJob shape, normalizeJobs and
   the jobTs / isTodayTs / hhmm / isActiveJob predicates now live in the shared
   vendor/scm/lib/scan-jobs.ts (reused by the desktop Scan Order modal) and are
   imported + re-exported at the top of this file. */
/* Owner 2026-07-04: a DONE scan is already a draft in Orders (announced by the
   Orders-open toast), so it must NOT linger on the Scan screen — not even a
   done-with-duplicate or done-with-a-note row. The Scan screen now shows only
   live progress (queued/running) plus genuine SYSTEM failures (status 'error',
   which produced no draft at all — a clearable "please rescan" row). The
   common "couldn't read the slip" case is no longer an error: the backend
   lands a blank draft for it, so it flows through the toast like any draft. */
const isStickyJob = (j: ScanJob): boolean => j.status === "error";

/* Visit tracking for the sticky-row dismissal — module scope so it survives
   screen unmounts. A sticky row stays visible for the ENTIRE visit in which it
   appears and is dropped only when its terminal update predates the PREVIOUS
   visit's start (i.e. a full visit has already shown it). The 5s clamp keeps
   dev StrictMode's double-mount from counting as a re-entry. */
let SCAN_VISIT = { openedAt: 0, prevOpenedAt: 0 };

/* ── /scan-so/extract response shape (subset the mobile flow consumes) ─────
   The SO scan endpoint returns sampleId + imageKey + receiptImageKey (NOT
   uploadSessionId — that belongs to scan-payment). extracted is the slip;
   catalog.skus lets us resolve a matched SKU code to a display name. */
type SkuMatch = { code: string; confidence: number; reason: string };
type CatalogSku = { code: string; name: string; category: string; baseModel: string | null };
type ExtractResp = {
  success: boolean;
  data: {
    sampleId: string | null;
    imageKey?: string | null;
    receiptImageKey?: string | null;
    extracted: ExtractedSlip;
    warnings: Array<{ field: string; value: string; message: string; lineIdx?: number }>;
    catalog: { skus: CatalogSku[]; fabrics: Array<{ code: string; description: string | null }> };
  };
};

/* ── Handoff contract with MobileNewSO ───────────────────────────────────
   A dropdown-agnostic prefill mapped to the mobile New SO form's simpler
   state shape (free-text venue, plain State/method strings). Carries the
   sampleId + salesperson + frozen AI-original so the New SO save can run the
   same edit-gate learning POST desktop does (/scan-so/samples/:id/confirm). */
export type MobileScanLine = {
  name: string; // matched SKU name, else the raw slip text (operator edits)
  qty: string;
  price: string; // RM
  remark: string;
  /* Learning carry-through — the verbatim slip row + the AI's SKU guess, so the
     New SO save can pair the operator's final line against the AI original. */
  rawText: string;
  suggestedCode: string;
  confidence: number;
  itemCode: string; // the SKU code the scan matched ('' = no match)
};
export type MobileScanPayment = {
  method: string; // Cash / Merchant / Online (3-method model)
  amount: string; // RM
  approval: string;
};
/* One captured payment slip = ONE payment. Carries the OCR'd values PLUS the
   captured File so the New SO form can pre-attach it to the payment row and
   upload it (a payment row is only RECORDED once it has an uploaded slip). The
   front slip has no such carrier — it seeds the order header, not a payment. */
export type MobileScanPaymentSlip = MobileScanPayment & {
  file: File; // the captured payment-slip image, for the New SO row's slip upload
};
export type MobileScanPrefill = {
  name: string;
  phone: string; // national digits (no +60 — the form's prefix box owns it)
  emergencyPhone: string; // second slip number → emergency contact
  address1: string;
  state: string;
  city: string;
  postcode: string;
  custRef: string;
  note: string;
  deliveryDate: string; // '' when none / not a clean date
  processingDate: string;
  customerType: string;
  buildingType: string;
  venue: string; // raw slip location text (mobile venue is free-text)
  /* First payment (back-compat) — kept so the mobile New SO form's existing
     single-payment seed keeps working unchanged. Equals payments[0] ?? null. */
  payment: MobileScanPayment | null;
  /* ALL payments — one entry per captured payment slip, each OCR'd in its own
     /extract call and carrying its captured File for the New SO row's slip
     upload. Empty when no payment slip was captured. The New SO form should seed
     ONE payment row per entry (see report note). */
  payments: MobileScanPaymentSlip[];
  lines: MobileScanLine[];
  /* Edit-gate carry-through — mirrors desktop's ScanPrefill. */
  sampleId: string | null;
  salesperson: string | null;
  aiOriginal: ExtractedSlip;
};

/* mfg_product_category → the mobile line has no itemGroup; we only surface a
   display name, so category isn't needed here (kept minimal). */

const CHECK = (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

const CAMERA = (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" />
    <circle cx="12" cy="13" r="3" />
  </svg>
);

/* A small red "×" delete control reused for every uploaded thumbnail (front +
   payment). Position is supplied by the caller. */
function RemoveButton({ label, onClick, style }: { label: string; onClick: () => void; style: CSSProperties }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      style={{ width: 20, height: 20, borderRadius: "50%", border: "none", background: "rgba(178,58,58,.92)", color: "#fff", fontFamily: "inherit", fontSize: 13, lineHeight: 1, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", ...style }}
    >
      {"×"}
    </button>
  );
}

/* Preview fill for a captured slip — the <img> for an image, a document tile for
   a PDF (an object-URL of a PDF in an <img> renders as a broken thumbnail). Fills
   its positioned `.ph` wrapper; the wrapper owns the overlays (check / remove /
   retake). Added with PDF accept (desktop parity). */
function ShotPreview({ shot, alt }: { shot: Shot; alt: string }) {
  if (isPdfShot(shot)) {
    return (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 5, background: "#eef1ec", padding: 8, boxSizing: "border-box" }}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#5c6156" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>
        <span style={{ fontSize: 10, fontWeight: 700, color: "#5c6156", textAlign: "center", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" }}>{shot.file.name}</span>
        <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: ".1em", color: "#9aa093" }}>PDF</span>
      </div>
    );
  }
  return <img src={shot.url} alt={alt} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />;
}

const SLOT_LABELS = ["Front slip", "Payment slip"];

/* Status pill for a Recent-scans row: Queued grey / Reading… teal-tint with a
   spinner / Done solid teal / Failed red-tint. Anything unexpected renders as
   Queued-grey with the raw word so a new backend state never blanks the row. */
function JobPill({ status }: { status: string }) {
  const base: CSSProperties = {
    display: "inline-flex", alignItems: "center", gap: 5, flex: "none",
    height: 22, padding: "0 9px", borderRadius: 999, fontSize: 10.5, fontWeight: 800,
  };
  if (status === "running") {
    return (
      <span style={{ ...base, background: "#e3efed", color: "#16695f" }}>
        <span style={{ width: 10, height: 10, borderRadius: "50%", border: "2px solid rgba(22,105,95,.3)", borderTopColor: "#16695f", animation: "hzSpin .8s linear infinite" }} />
        Reading…
      </span>
    );
  }
  if (status === "done") return <span style={{ ...base, background: "#16695f", color: "#fff" }}>Done</span>;
  if (status === "error") return <span style={{ ...base, background: "#f8eaea", color: "#b23a3a" }}>Failed</span>;
  return <span style={{ ...base, background: "#eef0ec", color: "#767b6e" }}>{status === "queued" ? "Queued" : status}</span>;
}

/* Money formatter shared by the payment + line mappings below (matches the
   desktop RM→display shape). */
const fmtRm = (rm: number): string =>
  rm.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* Map ONE extracted slip's payment fields into the mobile payment shape, or
   null when the slip carries no payment. Delegates to the SHARED reconciler's
   reconcilePayment so method-folding + the One-Shot default resolve identically
   to desktop; the mobile row keeps only method/amount/approval (bank/plan/online
   are carried by the reconciler but the mobile payment row doesn't surface them
   yet — see report note). Shared by the front-slip extraction (payment #1) and
   every additional payment-slip extraction (payments #2..N). */
function extractPayment(ex: ExtractedSlip, catalogs: ReconcileCatalogs): MobileScanPayment | null {
  const p = reconcilePayment(ex, catalogs);
  if (!p) return null;
  return {
    method: p.methodValue,
    amount: p.depositRm > 0 ? fmtRm(p.depositRm) : "0.00",
    approval: p.approvalCode,
  };
}

/* Build the mobile New-SO handoff via the SAME shared reconciler desktop uses
   (reconcileScanPrefill) — so the OCR values are reconciled to the live catalog
   IDENTICALLY on both platforms (venue text resolved, customer/building type +
   state + payment method snapped to the maintained dropdowns) — then adapted to
   the mobile form's simpler state (free-text venue, national phone parts,
   free-text line name).

   `paymentSlips` is the per-slip payment + captured File for EVERY payment slip
   (one per /extract call, in capture order). The prefill's back-compat `payment`
   field is set to the first entry so the existing single-payment New SO seed
   keeps working; `payments` carries the full array. */
function buildPrefill(
  d: ExtractResp["data"],
  repName: string,
  paymentSlips: MobileScanPaymentSlip[],
  catalogs: ReconcileCatalogs,
): MobileScanPrefill {
  const ex = d.extracted;
  const rec = reconcileScanPrefill(ex, catalogs);

  // Canonical +60 E.164 phones (from the reconciler), then split off the
  // national part (the form's +60 prefix box owns the country code).
  const mainNational = rec.phones[0] ? splitE164(rec.phones[0]).national : "";
  const emergencyNational = rec.phones[1] ? splitE164(rec.phones[1]).national : "";

  return {
    name: rec.customerName,
    phone: mainNational,
    emergencyPhone: emergencyNational,
    address1: rec.address1,
    state: rec.addressState,
    city: rec.addressCity,
    postcode: rec.addressPostcode,
    custRef: rec.customerSoRef,
    note: rec.note,
    deliveryDate: rec.deliveryDate ?? "",
    processingDate: rec.processingDate ?? "",
    customerType: rec.customerType,
    buildingType: rec.buildingType,
    // Mobile venue is free text — seed the raw slip location (nothing lost).
    venue: rec.venueText,
    // Back-compat first payment = payments[0] (the existing single-payment New
    // SO seed reads this). Falls back to the front slip's own reconciled payment
    // when no payment-slip-specific extraction produced one.
    payment: paymentSlips[0]
      ? { method: paymentSlips[0].method, amount: paymentSlips[0].amount, approval: paymentSlips[0].approval }
      : extractPayment(ex, catalogs),
    // One payment per captured payment slip, each with its captured File.
    payments: paymentSlips,
    lines: rec.lines.map((l) => ({
      // Matched SKU name, else the raw slip text so the operator has the
      // handwriting to type the real item against (never lost).
      name: l.description || l.rawText || "",
      qty: String(l.qty),
      price: fmtRm(l.unitPriceRm),
      remark: "",
      rawText: l.rawText,
      suggestedCode: l.suggestedCode,
      confidence: l.confidence,
      itemCode: l.itemCode,
    })),
    sampleId: d.sampleId,
    salesperson: repName || rec.salesRep || null,
    aiOriginal: ex,
  };
}

export function MobileScan({
  onBack,
  onDrafted,
  onOpenSo,
}: {
  onBack: () => void;
  /* Called after the scan has FIRED the background draft-create(s). `count` =
     how many drafts are being created. The parent shows the toast + nudges the
     SO-list refetch — it must NOT navigate away any more (owner 2026-07-04):
     the operator STAYS here and watches the Recent-scans pills progress,
     leaving via Cancel/back whenever. */
  onDrafted: (count: number) => void;
  /* Navigate to one SO's detail — a finished job's "Done → SO-xxxx" row is
     tappable and opens the draft it created. Optional so the screen still
     renders if a host doesn't wire it (the row is then not tappable). */
  onOpenSo?: (docNo: string) => void;
}) {
  const { user } = useAuth();
  // The session is an ARRAY of orders. Each order = one front slip + N payment
  // slips. Start with a single empty order. `activeOrderId` is which order the
  // hidden camera inputs currently target (set right before .click()).
  const [orders, setOrders] = useState<OrderDraft[]>(() => [newOrder()]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per-order inline errors, keyed by OrderDraft.id — today only the /enqueue
  // 409 duplicate_slip refusal ("This slip was already uploaded — it created
  // <doc no>."). Rendered inside that order's card; cleared when the order's
  // photos change (a retake is a new attempt).
  const [orderErrors, setOrderErrors] = useState<Record<string, string>>({});
  // The order id currently being re-queued via "Create anyway" (force=1), so
  // its button shows a busy state without blocking the rest of the screen.
  const [forcingId, setForcingId] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  // ONE hidden front input + ONE hidden payment input, both re-targeted to the
  // active order right before each capture. capture="environment" opens the rear
  // camera each time.
  const frontInputRef = useRef<HTMLInputElement>(null);
  const payInputRef = useRef<HTMLInputElement>(null);
  const activeOrderIdRef = useRef<string | null>(null);

  // Revoke every object URL still held when the component unmounts so captured
  // previews don't leak. Latest orders are read via the setter so we never close
  // over a stale list.
  useEffect(() => {
    return () => {
      setOrders((cur) => {
        for (const o of cur) {
          if (o.front) URL.revokeObjectURL(o.front.url);
          for (const s of o.payShots) URL.revokeObjectURL(s.url);
        }
        return cur;
      });
    };
  }, []);

  // Pre-warm the catalog prompt-cache the moment the screen opens so the first
  // /extract pays less. Fire-and-forget — never blocks or errors the screen.
  useEffect(() => {
    authedFetch("/scan-so/warm", { method: "POST" }).catch(() => {});
  }, []);

  /* Live catalogs for the SHARED reconciler — the SAME masters MobileNewSO
     renders its dropdowns from, so a reconciled value always matches a live
     option (this is the fix: the mapping now snaps against the live catalog, not
     stale hardcoded lists). Venues stay a resolvable master even though mobile's
     venue field is free-text (venueText carries the raw location regardless).
     The per-order skus catalog is merged in at call time from each /extract
     response (d.catalog.skus). */
  const venuesQ = useVenues();
  const customerTypeOptsQ  = useSoDropdownOptions("customer_type");
  const buildingTypeOptsQ  = useSoDropdownOptions("building_type");
  const paymentMethodOptsQ = useSoDropdownOptions("payment_method");
  const paymentMerchantQ   = useSoDropdownOptions("payment_merchant");
  const onlineTypeOptsQ    = useSoDropdownOptions("online_type");
  const installmentPlanQ   = useSoDropdownOptions("installment_plan");
  const localitiesQ        = useLocalities();

  /* Catalogs sans skus — merged with each /extract response's catalog.skus at
     call time. Memoised on the resolved option lists. */
  const catalogsBase = useMemo(
    () => ({
      venues:          venuesQ.data ?? [],
      customerType:    optionsOrFallback("customer_type",    customerTypeOptsQ.data),
      buildingType:    optionsOrFallback("building_type",    buildingTypeOptsQ.data),
      paymentMethod:   optionsOrFallback("payment_method",   paymentMethodOptsQ.data),
      paymentMerchant: optionsOrFallback("payment_merchant", paymentMerchantQ.data),
      onlineType:      optionsOrFallback("online_type",      onlineTypeOptsQ.data),
      installmentPlan: optionsOrFallback("installment_plan", installmentPlanQ.data),
      states:          distinctStates(localitiesQ.data ?? []),
    }),
    [
      venuesQ.data, customerTypeOptsQ.data, buildingTypeOptsQ.data,
      paymentMethodOptsQ.data, paymentMerchantQ.data, onlineTypeOptsQ.data,
      installmentPlanQ.data, localitiesQ.data,
    ],
  );

  const salesperson = (user?.name || user?.email || "").trim();

  /* ── Recent scans — background-job status list ──────────────────────────
     Visit bookkeeping first: record this open, remembering the previous one
     (sticky rows are dismissed only once a full visit has passed since their
     terminal update). Ref-guarded so it runs once per mount; the 5s clamp
     absorbs StrictMode's dev double-mount. */
  const dismissBeforeRef = useRef<number | null>(null);
  if (dismissBeforeRef.current === null) {
    const nowOpen = Date.now();
    if (nowOpen - SCAN_VISIT.openedAt > 5000) {
      SCAN_VISIT = { openedAt: nowOpen, prevOpenedAt: SCAN_VISIT.openedAt };
    }
    dismissBeforeRef.current = SCAN_VISIT.prevOpenedAt;
  }
  const dismissBefore = dismissBeforeRef.current ?? 0;

  const { data: jobsData, refetch: refetchJobs } = useQuery({
    queryKey: ["mobile-scan-jobs", salesperson],
    queryFn: () =>
      authedFetch<ScanJobsResp>(
        salesperson ? `/scan-so/jobs?salesperson=${encodeURIComponent(salesperson)}` : "/scan-so/jobs",
      ),
    staleTime: 0,
    retry: false, // fail-soft — a jobs hiccup just hides the section, no dialog
    // Poll every 4s ONLY while a listed job is still queued/running; a settled
    // list stops the interval entirely (done-row expiry is a local timer).
    refetchInterval: (query) =>
      normalizeJobs(query.state.data).some(isActiveJob) ? 4000 : false,
  });
  const jobs = useMemo(() => normalizeJobs(jobsData), [jobsData]);

  const visibleJobs = useMemo(
    () =>
      jobs.filter((j) => {
        if (!isTodayTs(jobTs(j.createdAt))) return false; // today's jobs only
        if (isActiveJob(j)) return true;
        // Genuine system failures stay for the whole visit (dismissed once a
        // full later visit has shown them). DONE jobs never show here — they
        // are drafts in Orders, announced by the Orders-open toast.
        if (isStickyJob(j)) return jobTs(j.updatedAt ?? j.createdAt) > dismissBefore;
        return false;
      }),
    [jobs, dismissBefore],
  );

  /* "Clear" for failed rows — POST /scan-so/jobs/clear-failed deletes THIS
     salesperson's terminal error rows server-side (self-scoped by the
     caller's name on the backend; a wildcard admin clears all), then the list
     refetches. Shown while any error row is visible. Plain cleanup of rows
     already read. Fail-soft: on error the rows just stay; next tap retries. */
  const hasFailedRows = visibleJobs.some((j) => j.status === "error");
  const [clearingFailed, setClearingFailed] = useState(false);
  const clearFailedJobs = async () => {
    if (clearingFailed) return;
    setClearingFailed(true);
    try {
      await authedFetch("/scan-so/jobs/clear-failed", { method: "POST" });
      await refetchJobs();
    } catch {
      /* fail-soft — keep the rows; the button stays for another try */
    } finally {
      setClearingFailed(false);
    }
  };

  // The session is submittable once EVERY queued order has its front slip. The
  // payment slip is OPTIONAL — desktop parity (ScanOrderModal `ready` = slip
  // only): a slip alone submits and the payment can be recorded later; the
  // background /enqueue OCR reads zero-or-more receipts. (An order that's still
  // blank — no front slip — blocks submit; finish it or remove it.)
  const ready = orders.length > 0 && orders.every((o) => o.front !== null);
  const multiOrder = orders.length > 1;

  const pickFront = (orderId: string) => {
    if (submitting) return;
    activeOrderIdRef.current = orderId;
    frontInputRef.current?.click();
  };
  const pickPayment = (orderId: string) => {
    if (submitting) return;
    activeOrderIdRef.current = orderId;
    payInputRef.current?.click();
  };

  // Drop one order's inline error (its photos changed — new attempt).
  const clearOrderError = (orderId: string) =>
    setOrderErrors((cur) => {
      if (!cur[orderId]) return cur;
      const next = { ...cur };
      delete next[orderId];
      return next;
    });

  const onFrontFile = (file: File | undefined) => {
    if (!file) return;
    const orderId = activeOrderIdRef.current;
    if (!orderId) return;
    const url = URL.createObjectURL(file);
    setOrders((cur) =>
      cur.map((o) => {
        if (o.id !== orderId) return o;
        if (o.front) URL.revokeObjectURL(o.front.url);
        return { ...o, front: { file, url } };
      }),
    );
    setError(null);
    clearOrderError(orderId);
  };
  const clearFront = (orderId: string) => {
    if (submitting) return;
    setOrders((cur) =>
      cur.map((o) => {
        if (o.id !== orderId) return o;
        if (o.front) URL.revokeObjectURL(o.front.url);
        return { ...o, front: null };
      }),
    );
    clearOrderError(orderId);
  };

  // Append captured payment slips to the active order (each = one payment). The
  // input is `multiple`, so a single pick can carry a whole batch of slip photos
  // — EVERY selected file becomes its own payShot. No cap — an order can take as
  // many payments as slips.
  const addPayFiles = (files: FileList | null | undefined) => {
    if (!files || files.length === 0) return;
    const orderId = activeOrderIdRef.current;
    if (!orderId) return;
    const shots: Shot[] = Array.from(files).map((file) => ({ file, url: URL.createObjectURL(file) }));
    setOrders((cur) => cur.map((o) => (o.id === orderId ? { ...o, payShots: [...o.payShots, ...shots] } : o)));
    setError(null);
    clearOrderError(orderId);
  };
  const removePayShot = (orderId: string, i: number) => {
    if (submitting) return;
    setOrders((cur) =>
      cur.map((o) => {
        if (o.id !== orderId) return o;
        const gone = o.payShots[i];
        if (gone) URL.revokeObjectURL(gone.url);
        return { ...o, payShots: o.payShots.filter((_, k) => k !== i) };
      }),
    );
    clearOrderError(orderId);
  };

  const addOrder = () => {
    if (submitting) return;
    setOrders((cur) => [...cur, newOrder()]);
    setError(null);
  };
  // Remove a whole order (and revoke its previews). Never let the list go empty —
  // removing the last order resets it to a fresh blank one.
  const removeOrder = (orderId: string) => {
    if (submitting) return;
    setOrders((cur) => {
      const gone = cur.find((o) => o.id === orderId);
      if (gone) {
        if (gone.front) URL.revokeObjectURL(gone.front.url);
        for (const s of gone.payShots) URL.revokeObjectURL(s.url);
      }
      const next = cur.filter((o) => o.id !== orderId);
      return next.length ? next : [newOrder()];
    });
    clearOrderError(orderId);
  };

  // Clear the whole capture session back to one blank order (revoking every
  // preview URL). Used after a successful submit — the operator now STAYS on
  // this screen watching Recent scans, so the submitted photos must not linger
  // looking still-pending.
  const resetOrders = () => {
    setOrders((cur) => {
      for (const o of cur) {
        if (o.front) URL.revokeObjectURL(o.front.url);
        for (const s of o.payShots) URL.revokeObjectURL(s.url);
      }
      return [newOrder()];
    });
    setOrderErrors({});
  };

  // POST one order's front slip + ONE payment slip to /scan-so/extract. The
  // existing contract reads exactly one order slip + one payment receipt into a
  // single payment, so one call per payment slip yields one payment per slip. The
  // order's front slip rides EVERY call (order fields are read identically each
  // time; we keep the FIRST response's order + this call's single payment).
  const extractOne = async (front: Shot, payFile: File): Promise<ExtractResp> => {
    const form = new FormData();
    // Downscale first: the raw camera file can clear the backend's 20MB gate and
    // still exceed the model's per-image cap, which returns a NON-retryable 400.
    const [frontFile, slipFile] = await compressAllForOcr([front.file, payFile]);
    form.append("file", frontFile);
    form.append("file", slipFile);
    if (salesperson) form.append("salesperson", salesperson);
    // authedFetch handles the FormData content-type + bearer + long scan
    // timeout. A non-ok reason throws a plain-language message we catch below.
    return authedFetch<ExtractResp>("/scan-so/extract", { method: "POST", body: form });
  };

  // OCR one order into a prefill (front slip + all its payment slips → one
  // header + one payment per slip). Returns null when the first call fails.
  const extractOrder = async (order: OrderDraft): Promise<MobileScanPrefill | null> => {
    if (!order.front || order.payShots.length === 0) return null;
    const responses: ExtractResp[] = [];
    for (const shot of order.payShots) {
      responses.push(await extractOne(order.front, shot.file));
    }
    const first = responses[0];
    if (!first || !first.success || !first.data) return null;
    const repName = salesperson || (first.data.extracted.salesRep ?? "").trim();
    /* Full reconciler catalogs = the live option/venue/state masters + this
       order's SKU catalog (from the first extract response). */
    const catalogs: ReconcileCatalogs = { ...catalogsBase, skus: first.data.catalog.skus };
    // One MobileScanPaymentSlip per captured slip: the per-call OCR'd payment
    // (falling back to a blank-method / zeroed row when a call couldn't read a
    // payment, so the slip is never silently dropped — the operator picks the
    // method and fixes the amount) + the captured File for the New SO row's slip
    // upload.
    const paymentSlips: MobileScanPaymentSlip[] = order.payShots.map((shot, i) => {
      const res = responses[i];
      const pm = res && res.success && res.data ? extractPayment(res.data.extracted, catalogs) : null;
      return {
        method: pm?.method ?? "",
        amount: pm?.amount ?? "0.00",
        approval: pm?.approval ?? "",
        file: shot.file,
      };
    });
    return buildPrefill(first.data, repName, paymentSlips, catalogs);
  };

  // TRUE background path (owner 2026-07-04): POST /scan-so/enqueue uploads the
  // order's photos + queues a server-side job and returns 202 {job_id} BEFORE
  // any OCR — the phone can leave this screen (or close the app entirely); the
  // Worker's waitUntil finishes the OCR and mints the DRAFT SO on its own.
  const enqueueOne = async (order: OrderDraft, force = false): Promise<{ job_id: string; status: string }> => {
    const form = new FormData();
    // Downscale before the upload, not after: this POST is the whole point of
    // the background path (the phone may leave the screen the moment it
    // returns), so the bytes that ride it are the bytes the model will read.
    const files = await compressAllForOcr([order.front!.file, ...order.payShots.map((s) => s.file)]);
    for (const f of files) form.append("file", f);
    if (salesperson) form.append("salesperson", salesperson);
    // force=1 = the operator confirmed "create anyway" on a duplicate-slip
    // warning, so the backend skips its hard reject and queues the order.
    if (force) form.append("force", "1");
    return authedFetch<{ job_id: string; status: string }>("/scan-so/enqueue", { method: "POST", body: form });
  };

  // "Create anyway" — re-queue a duplicate-slip-warned order with force=1. Owner
  // 2026-07-15: a repeat slip only WARNS; whether to open again is the person's
  // call. On success the card drops off (like a normal queue) and its warning
  // clears; the background job still marks it as a soft duplicate for the trail.
  const createAnyway = async (orderId: string) => {
    const order = orders.find((o) => o.id === orderId);
    // Front slip is the only requirement — payment optional (desktop parity).
    if (!order || !order.front || forcingId) return;
    setForcingId(orderId);
    try {
      await enqueueOne(order, true);
    } catch {
      setForcingId(null);
      void serviceNotify({
        title: "Couldn't queue the order",
        body: "The order still couldn't be queued. Please try again.",
        tone: "error",
      });
      return;
    }
    setForcingId(null);
    setOrderErrors((cur) => {
      const next = { ...cur };
      delete next[orderId];
      return next;
    });
    setOrders((cur) => {
      const target = cur.find((o) => o.id === orderId);
      if (target?.front) URL.revokeObjectURL(target.front.url);
      if (target) for (const s of target.payShots) URL.revokeObjectURL(s.url);
      const keep = cur.filter((o) => o.id !== orderId);
      return keep.length ? keep : [newOrder()];
    });
    void refetchJobs();
    void serviceNotify({
      title: "Draft queued",
      body: "The order was queued despite the duplicate slip.",
      tone: "info",
    });
  };

  /* Legacy on-screen flow — kept VERBATIM as the fallback when /enqueue is not
     served yet (a 404 from a stale worker): OCR every order while the operator
     waits, then fire the client-side draft creates. */
  const submitLegacy = async () => {
    /* Carry each order's OWN key alongside its prefill — the prefill is derived
       data (re-OCR'd on every press), the OrderDraft is the intent, so the key
       belongs to the order and not to this loop.

       Honest scope: no double-fire is reachable here TODAY — submit() guards on
       `!ready || submitting` and resetOrders() clears the photos afterwards, and
       the primary /enqueue path is domain-idempotent anyway (it 409s
       duplicate_slip against a slip that already made an SO). This is the right
       OWNER for the key rather than a live fix: the bare POST it feeds is the
       same create the interactive form uses, and if a retry is ever added here
       the key is already on the object that means "one order". */
    const prefills: { prefill: MobileScanPrefill; idempotencyKey: string }[] = [];
    for (const order of orders) {
      const prefill = await extractOrder(order);
      if (prefill) prefills.push({ prefill, idempotencyKey: order.idempotencyKey });
    }
    if (prefills.length === 0) {
      setError("Couldn't read the slip — try again.");
      return;
    }
    for (const { prefill, idempotencyKey } of prefills) {
      void createDraftFromPrefill(prefill, idempotencyKey).catch(() => {
        void serviceNotify({
          title: "Couldn't save one scanned draft",
          body: "One of your scanned orders couldn't be saved. Scan it again.",
          tone: "error",
        });
      });
    }
    // The legacy path has no job rows to watch, but the post-submit contract is
    // the same: stay on this screen (the parent no longer navigates), clear the
    // submitted photos, toast + Orders-list nudge via onDrafted.
    resetOrders();
    onDrafted(prefills.length);
  };

  const submit = async () => {
    if (!ready || submitting) return;
    setSubmitting(true);
    setError(null);
    setUnavailable(false);
    setOrderErrors({});
    try {
      // Enqueue every queued order (upload-only — fast). Each order = one
      // background job = one DRAFT SO. The await here is just the photo upload,
      // not the OCR, so the operator leaves this screen in seconds.
      let queued = 0;
      const dupErrors: Record<string, string> = {};
      for (const order of orders) {
        // Slip-only orders enqueue too (payment optional — desktop parity). Only
        // a genuinely blank order (no front slip) is skipped.
        if (!order.front) continue;
        try {
          await enqueueOne(order);
          queued++;
        } catch (e) {
          const err = e as Error & { status?: number; body?: string };
          // 409 duplicate_slip = the backend refused THIS order at upload
          // because its slip photo already created an SO (hard reject, nothing
          // queued). Keep that order on screen with the reason — which names
          // the existing order number — inline on its card; the OTHER orders
          // in the batch still enqueue. NEVER falls through to the legacy
          // path (that would create the duplicate client-side anyway).
          if (err.status === 409 && typeof err.body === "string" && err.body.includes("duplicate_slip")) {
            let reason = "This slip was already uploaded.";
            try {
              const b = JSON.parse(err.body) as { reason?: string };
              if (typeof b.reason === "string" && b.reason.trim() !== "") reason = b.reason;
            } catch { /* body wasn't JSON — keep the fallback wording */ }
            dupErrors[order.id] = reason;
            continue;
          }
          // 404 = worker without /enqueue yet — do the WHOLE batch the legacy
          // way (mixing paths would double-create the already-queued orders,
          // and a duplicate-refused order must never be re-created either).
          if (err.status === 404 && queued === 0 && Object.keys(dupErrors).length === 0) {
            await submitLegacy();
            return;
          }
          throw e;
        }
      }
      if (Object.keys(dupErrors).length > 0) {
        // Stay on this screen so the operator SEES which order was refused:
        // keep only the refused order cards (with their inline reason); the
        // queued ones are already running server-side, so drop them here and
        // say so.
        setOrders((cur) => {
          for (const o of cur) {
            if (dupErrors[o.id]) continue;
            if (o.front) URL.revokeObjectURL(o.front.url);
            for (const s of o.payShots) URL.revokeObjectURL(s.url);
          }
          const keep = cur.filter((o) => dupErrors[o.id]);
          return keep.length ? keep : [newOrder()];
        });
        setOrderErrors(dupErrors);
        if (queued > 0) {
          // Surface the just-queued jobs in Recent scans right away.
          void refetchJobs();
          void serviceNotify({
            title: `${queued} draft${queued === 1 ? "" : "s"} queued`,
            body: "The other orders were queued. The slip below may be a duplicate — review it, then Create anyway if you want a new order.",
            tone: "info",
          });
        }
        return;
      }
      if (queued === 0) {
        setError("Couldn't read the slip — try again.");
        return;
      }
      // STAY on this screen (owner 2026-07-04): clear the submitted photos,
      // pull the new job rows into Recent scans immediately so the operator
      // sees their pills before doing anything else, and let the parent toast
      // + nudge the Orders list. He leaves via Cancel/back whenever.
      resetOrders();
      void refetchJobs();
      onDrafted(queued);
    } catch (e) {
      // Staging has no ANTHROPIC_API_KEY → /extract returns 503
      // anthropic_key_missing. Surface a clear "not available here" note instead
      // of the raw wrangler instruction humanApiError would otherwise pass
      // through. The error object carries the raw status/body for this check.
      const err = e as Error & { status?: number; body?: string };
      const keyMissing =
        err.status === 503 || (typeof err.body === "string" && err.body.includes("anthropic_key_missing"));
      if (keyMissing) {
        setUnavailable(true);
      } else {
        // Surface the server's OWN plain-language reason (authedFetch already
        // ran it through humanApiError, so err.message is a clean sentence —
        // "File too large…", "Unsupported file type…", "The photos could not be
        // uploaded…") instead of a blanket line that hides WHY it failed.
        setError(err.message || "Couldn't read the slip — try again.");
      }
    } finally {
      setSubmitting(false);
    }
  };


  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      {/* Spec #scan: back "Cancel" chevron, screen-title, helper sub-line. */}
      <header className="hdr">
        <div className="hdr-row">
          <button onClick={onBack} className="back" aria-label="Cancel">
            <span className="chev">{"‹"}</span> Cancel
          </button>
        </div>
        <div className="scr-title" style={{ marginTop: 2 }}>Scan order slip</div>
        <div style={{ fontSize: 11, color: "#767b6e", marginTop: 2 }}>Snap each slip — one front slip and its payment slips per order. Queue as many orders as you like.</div>
      </header>

      <div className="scroll" style={{ padding: 14, paddingBottom: 120 }}>
        {unavailable ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", padding: "34px 12px 8px" }}>
            <div style={{ width: 64, height: 64, borderRadius: "50%", background: "#f4ecdf", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 16 }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#a16a2e" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" /></svg>
            </div>
            <div style={{ fontSize: 17, fontWeight: 800, color: "#11140f", marginBottom: 8 }}>Scan isn't available yet</div>
            <div style={{ fontSize: 12.5, color: "#767b6e", lineHeight: 1.55, maxWidth: 280 }}>
              Slip scanning isn't switched on in this environment yet. You can still create the order by hand from the New Sales Order form.
            </div>
            <button onClick={() => setUnavailable(false)} style={{ marginTop: 26, height: 48, padding: "0 22px", borderRadius: 12, border: "1px solid #16695f", background: "#fff", color: "#16695f", fontFamily: "inherit", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>
              Back to capture
            </button>
          </div>
        ) : (
          <>
            {/* ── Recent scans — today's background jobs, top of the screen ──
                Queued/running always; done shows briefly (tappable → the SO it
                created) then drops (it lives in Orders now); failures and
                duplicate warnings stay for the whole visit. Hidden entirely
                when nothing is visible. */}
            {visibleJobs.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 6 }}>
                  <div className="ey" style={{ letterSpacing: ".14em", color: "#9aa093", fontSize: 10.5 }}>Recent scans</div>
                  {/* Clear failed rows — only while error/duplicate rows are on
                      screen; deletes the caller's own error rows server-side. */}
                  {hasFailedRows && (
                    <button
                      onClick={() => void clearFailedJobs()}
                      disabled={clearingFailed}
                      style={{ border: "none", background: "none", padding: "0 2px", fontFamily: "inherit", fontSize: 11.5, fontWeight: 700, color: "#16695f", cursor: "pointer", opacity: clearingFailed ? 0.5 : 1 }}
                    >
                      {clearingFailed ? "Clearing…" : "Clear"}
                    </button>
                  )}
                </div>
                <div style={{ border: "1px solid #e3e6e0", borderRadius: 14, background: "#fff", overflow: "hidden" }}>
                  {visibleJobs.map((j, i) => {
                    const createdAt = jobTs(j.createdAt);
                    const tappable = j.status === "done" && !!j.soDocNo && !!onOpenSo;
                    const rowStyle: CSSProperties = {
                      display: "flex", alignItems: "flex-start", gap: 9, width: "100%",
                      padding: "10px 12px", background: "none", border: "none",
                      borderTop: i === 0 ? "none" : "1px solid #eef0ec",
                      textAlign: "left", fontFamily: "inherit", cursor: tappable ? "pointer" : "default",
                    };
                    const body = (
                      <>
                        <JobPill status={j.status} />
                        <div style={{ flex: 1, minWidth: 0, paddingTop: 2 }}>
                          {j.status === "done" && (
                            <div style={{ fontSize: 12.5, fontWeight: 700, color: "#11140f", lineHeight: 1.35 }}>
                              {j.soDocNo ? `${j.soDocNo} — saved to Orders` : "Saved to Orders"}
                            </div>
                          )}
                          {j.status === "error" && (
                            <div style={{ fontSize: 12, color: "#b23a3a", lineHeight: 1.45 }}>
                              {j.error || "Couldn't read the slip."}
                            </div>
                          )}
                          {j.status === "done" && j.error && (
                            <div style={{ fontSize: 11, color: "#a16a2e", lineHeight: 1.45, marginTop: 2 }}>{j.error}</div>
                          )}
                          {j.duplicateOf && (
                            <div style={{ fontSize: 11, color: "#a16a2e", fontWeight: 700, lineHeight: 1.45, marginTop: 2 }}>
                              Duplicate of {j.duplicateOf}
                            </div>
                          )}
                        </div>
                        <span style={{ flex: "none", fontSize: 10.5, color: "#9aa093", paddingTop: 4 }}>
                          {createdAt ? hhmm(createdAt) : ""}
                        </span>
                        {tappable && (
                          <span style={{ flex: "none", color: "#c2c6bd", fontSize: 16, lineHeight: 1, paddingTop: 3 }}>{"›"}</span>
                        )}
                      </>
                    );
                    return tappable ? (
                      <button key={j.id} onClick={() => onOpenSo!(j.soDocNo!)} aria-label={`Open ${j.soDocNo}`} style={rowStyle}>
                        {body}
                      </button>
                    ) : (
                      <div key={j.id} style={rowStyle}>{body}</div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Hidden inputs: one for the front slip, one for payment slips. Both
                re-targeted to activeOrderIdRef before each capture. The front
                input keeps capture="environment" (single slip, rear camera); the
                payment input is `multiple` without capture so the picker offers
                gallery multi-select (capture would force a one-shot camera and
                drop `multiple`). */}
            <input
              ref={frontInputRef}
              type="file"
              /* Desktop parity — also accept a PDF slip (ScanOrderModal ACCEPT).
                 capture="environment" stays: the owner's mobile flow is snap-the-
                 slip with the rear camera; where a browser honours capture the
                 front stays camera-first, where it doesn't a PDF becomes pickable. */
              accept="image/*,application/pdf"
              capture="environment"
              style={{ display: "none" }}
              onChange={(e) => {
                onFrontFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <input
              ref={payInputRef}
              type="file"
              /* Desktop parity — accept a PDF e-receipt alongside images. No
                 capture here, so a PDF is fully pickable from Files. */
              accept="image/*,application/pdf"
              multiple
              style={{ display: "none" }}
              onChange={(e) => {
                addPayFiles(e.target.files);
                e.target.value = "";
              }}
            />

            {/* One grouped card per queued order — the front slip and its payment
                slips live under one "Order N" header so it's clear they belong to
                the same order. */}
            {orders.map((order, oi) => (
              <div
                key={order.id}
                style={{ border: "1px solid #e3e6e0", borderRadius: 14, padding: 12, marginBottom: 12, background: "#fff" }}
              >
                {/* Order header — "Order N" + a remove-order control (only when
                    more than one order is queued; the sole order can't be removed,
                    only its slips). */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 800, color: "#11140f" }}>Order {oi + 1}</span>
                  {multiOrder && !submitting && (
                    <button
                      onClick={() => removeOrder(order.id)}
                      style={{ display: "flex", alignItems: "center", gap: 4, height: 26, padding: "0 10px", borderRadius: 999, border: "1px solid #f0d4d4", background: "#fff", color: "#b23a3a", fontFamily: "inherit", fontSize: 11, fontWeight: 700, cursor: "pointer" }}
                    >
                      {"×"} Remove order
                    </button>
                  )}
                </div>

                {/* FRONT SLIP — single per order. */}
                <div className="ey" style={{ letterSpacing: ".14em", color: "#9aa093", fontSize: 10.5, marginBottom: 6 }}>{SLOT_LABELS[0]}</div>
                {order.front ? (
                  <div className="ph" style={{ position: "relative", height: 130, borderRadius: 12, overflow: "hidden", marginBottom: 4 }}>
                    <ShotPreview shot={order.front} alt={SLOT_LABELS[0]} />
                    <span style={{ position: "absolute", top: 6, left: 6, width: 20, height: 20, borderRadius: "50%", background: "#2f8a5b", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      {CHECK}
                    </span>
                    {!submitting && (
                      <>
                        {/* Delete the front slip. */}
                        <RemoveButton
                          label={`Remove ${SLOT_LABELS[0]} for order ${oi + 1}`}
                          onClick={() => clearFront(order.id)}
                          style={{ position: "absolute", top: 6, right: 6 }}
                        />
                        {/* Retake = delete then re-open camera in one tap. */}
                        <button
                          onClick={() => { clearFront(order.id); pickFront(order.id); }}
                          aria-label={`Retake ${SLOT_LABELS[0]} for order ${oi + 1}`}
                          style={{ position: "absolute", bottom: 6, right: 6, height: 24, padding: "0 9px", borderRadius: 999, border: "none", background: "rgba(17,20,15,.62)", color: "#fff", fontFamily: "inherit", fontSize: 10.5, fontWeight: 700, cursor: "pointer" }}
                        >
                          Retake
                        </button>
                      </>
                    )}
                  </div>
                ) : (
                  <button
                    onClick={() => pickFront(order.id)}
                    disabled={submitting}
                    style={{ height: 130, width: "100%", border: "1px dashed #c2c6bd", borderRadius: 12, background: "#f4f6f3", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, cursor: submitting ? "default" : "pointer", fontFamily: "inherit", opacity: submitting ? 0.5 : 1, marginBottom: 4 }}
                  >
                    {CAMERA}
                    <span style={{ fontSize: 11, fontWeight: 700, color: "#16695f" }}>{SLOT_LABELS[0]}</span>
                  </button>
                )}

                {/* PAYMENT SLIPS — one photo per payment, within this order. Add-
                    more tile + thumbnail list with a per-slip delete. Each slip
                    becomes its own payment on the draft SO. */}
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginTop: 14, marginBottom: 6 }}>
                  <span className="ey" style={{ letterSpacing: ".14em", color: "#9aa093", fontSize: 10.5 }}>Payment slips</span>
                  <span style={{ fontSize: 10.5, color: "#9aa093" }}>
                    {order.payShots.length === 0 ? "One photo per payment" : `${order.payShots.length} payment${order.payShots.length === 1 ? "" : "s"}`}
                  </span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                  {order.payShots.map((shot, i) => (
                    <div key={shot.url} className="ph" style={{ position: "relative", height: 96, borderRadius: 12, overflow: "hidden" }}>
                      <ShotPreview shot={shot} alt={`Order ${oi + 1} payment ${i + 1}`} />
                      <span style={{ position: "absolute", top: 5, left: 5, height: 18, minWidth: 18, padding: "0 5px", borderRadius: 999, background: "rgba(17,20,15,.62)", color: "#fff", fontSize: 10, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center" }}>
                        {i + 1}
                      </span>
                      {!submitting && (
                        <RemoveButton
                          label={`Remove order ${oi + 1} payment ${i + 1}`}
                          onClick={() => removePayShot(order.id, i)}
                          style={{ position: "absolute", top: 5, right: 5 }}
                        />
                      )}
                    </div>
                  ))}
                  <button
                    onClick={() => pickPayment(order.id)}
                    disabled={submitting}
                    aria-label={order.payShots.length === 0 ? `${SLOT_LABELS[1]} for order ${oi + 1}` : `Add another payment slip to order ${oi + 1}`}
                    style={{ height: 96, width: "100%", border: "1px dashed #c2c6bd", borderRadius: 12, background: "#f4f6f3", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 5, cursor: submitting ? "default" : "pointer", fontFamily: "inherit", opacity: submitting ? 0.5 : 1 }}
                  >
                    {CAMERA}
                    <span style={{ fontSize: 10.5, fontWeight: 700, color: "#16695f", textAlign: "center", lineHeight: 1.25 }}>
                      {order.payShots.length === 0 ? SLOT_LABELS[1] : "Add payment"}
                    </span>
                  </button>
                </div>
                <div style={{ fontSize: 10.5, color: "#9aa093", textAlign: "center", marginTop: 10 }}>
                  {order.payShots.length === 0
                    ? "1 front slip · payment slips optional (add later if you like)"
                    : `1 front slip + ${order.payShots.length} payment slip${order.payShots.length === 1 ? "" : "s"} · each payment slip = one payment`}
                </div>

                {/* Order-level duplicate-slip WARNING (409 duplicate_slip): this
                    order's slip already created an SO. Owner 2026-07-15: warn,
                    don't block — the operator decides. Names the existing order
                    number; "Create anyway" re-queues it (force=1); retaking or
                    removing a photo also clears it. */}
                {orderErrors[order.id] && (
                  <div style={{ marginTop: 10, background: "#f3ece0", border: "1px solid #e8dcc5", borderRadius: 11, padding: "10px 12px", fontSize: 12, color: "#6a4a1e", lineHeight: 1.5 }}>
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                      <svg width="15" height="15" style={{ flex: "none", marginTop: 1 }} viewBox="0 0 24 24" fill="none" stroke="#a16a2e" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" /></svg>
                      <span>{orderErrors[order.id]}</span>
                    </div>
                    <button
                      onClick={() => void createAnyway(order.id)}
                      disabled={forcingId === order.id}
                      style={{ marginTop: 9, height: 34, width: "100%", border: "1px solid #a16a2e", borderRadius: 9, background: forcingId === order.id ? "#efe6d6" : "#a16a2e", color: forcingId === order.id ? "#a16a2e" : "#fff", fontSize: 12, fontWeight: 700, fontFamily: "inherit", cursor: forcingId === order.id ? "default" : "pointer" }}
                    >
                      {forcingId === order.id ? "Creating…" : "Create anyway"}
                    </button>
                  </div>
                )}
              </div>
            ))}

            {/* + Add order — queue another order (its own front + payment slips). */}
            <button
              onClick={addOrder}
              disabled={submitting}
              style={{ height: 46, width: "100%", border: "1px dashed #16695f", borderRadius: 12, background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, cursor: submitting ? "default" : "pointer", fontFamily: "inherit", opacity: submitting ? 0.5 : 1, color: "#16695f", fontSize: 13, fontWeight: 700 }}
            >
              <span style={{ fontSize: 18, lineHeight: 1 }}>{"+"}</span> Add order
            </button>

            {/* Design #scan: amber helper note box (design's #f3ece0 / #e8dcc5 /
                #6a4a1e amber trio). Copy reflects the real flow — the scan reads
                the slip and creates a DRAFT order in the background; the operator
                opens it from Orders to review and finalise. */}
            <div style={{ display: "flex", alignItems: "flex-start", gap: 9, background: "#f3ece0", border: "1px solid #e8dcc5", borderRadius: 11, padding: 11, marginTop: 12, fontSize: 11, color: "#6a4a1e", lineHeight: 1.5 }}>
              {/* Spec #scan amber info glyph on the left of the note. */}
              <svg width="15" height="15" style={{ flex: "none", marginTop: 1 }} viewBox="0 0 24 24" fill="none" stroke="#a16a2e" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" /></svg>
              <span>
                We read {multiOrder ? "each slip" : "the slip"} and save {multiOrder ? "a draft order per slip" : "a draft order"} to Orders in the background. Open {multiOrder ? "each draft" : "the draft"} from Orders to review every field, correct anything the reader missed, then finalise.
              </span>
            </div>

            {salesperson && (
              <div style={{ marginTop: 16, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 11, color: "#767b6e" }}>
                <span className="ey" style={{ letterSpacing: ".14em", color: "#9aa093" }}>Salesperson</span>
                <span style={{ fontWeight: 700, color: "#414539" }}>{salesperson}</span>
              </div>
            )}

            {submitting && (
              <div style={{ marginTop: 16, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, fontSize: 12, color: "#767b6e" }}>
                <span style={{ width: 14, height: 14, borderRadius: "50%", border: "2px solid rgba(22,105,95,.3)", borderTopColor: "#16695f", animation: "hzSpin .8s linear infinite" }} />
                Uploading — the reading finishes in the background.
              </div>
            )}

            {error && (
              <div style={{ marginTop: 16, background: "#f8eaea", border: "1px solid #f0d4d4", borderRadius: 11, padding: "11px 13px", fontSize: 12, color: "#b23a3a", lineHeight: 1.5 }}>
                {error}
              </div>
            )}
          </>
        )}
      </div>

      {!unavailable && (
        <footer className="actbar">
          <button
            id="scan-submit"
            className="btn"
            onClick={submit}
            disabled={!ready || submitting}
            style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 9, cursor: !ready || submitting ? "default" : "pointer", opacity: !ready || submitting ? 0.5 : 1 }}
          >
            {submitting && (
              <span style={{ width: 16, height: 16, borderRadius: "50%", border: "2px solid rgba(255,255,255,.45)", borderTopColor: "#fff", animation: "hzSpin .8s linear infinite" }} />
            )}
            {submitting
              ? "Uploading…"
              : multiOrder ? `Scan & save ${orders.length} drafts` : "Scan & save draft"}
          </button>
        </footer>
      )}

      <style>{`@keyframes hzSpin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
