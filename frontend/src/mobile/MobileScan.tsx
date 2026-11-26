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
  normalizeScanSalespeople,
  jobTs,
  isTodayTs,
  hhmm,
  isActiveJob,
  SCAN_SALESPEOPLE_PATH,
  type ScanJob,
  type ScanJobsResp,
} from "../vendor/scm/lib/scan-jobs";
import "./mobile.css";

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
// Photos come from hidden <input type="file"> elements — the standard PWA
// pattern, no getUserMedia / live video. Each slot has TWO of them: one with
// capture="environment" (straight to the rear camera) and one without (the OS
// offers Photos and Files; the payment one is `multiple` so a whole batch of
// slips can be picked at once, which capture would forbid). Tapping a slot pops
// a small menu that chooses between them — see PickSourceMenu for why the
// choice cannot live on a single input.
//
// The multipart POST reuses authedFetch: it stamps the bearer from
// localStorage['auth:token'], leaves the multipart content-type to the browser
// (so the boundary is set correctly), and applies the long scan timeout for the
// /scan- path. A missing ANTHROPIC_API_KEY (staging) returns 503
// anthropic_key_missing, which we surface as a clear "not available here" note.

type Shot = { file: File; url: string };
type Slot = Shot | null;

const isPdfShot = (s: Shot): boolean =>
  s.file.type === "application/pdf" || /\.pdf$/i.test(s.file.name);

type OrderDraft = { id: string; idempotencyKey: string; front: Slot; payShots: Shot[] };

let ORDER_SEQ = 0;
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

let SCAN_VISIT = { openedAt: 0, prevOpenedAt: 0 };

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

export type MobileScanLine = {
  name: string;
  qty: string;
  price: string;
  remark: string;
  rawText: string;
  suggestedCode: string;
  confidence: number;
  itemCode: string;
  matchSource: import("../vendor/scm/lib/sku-nearest-match").SkuMatchSource | null;
};
export type MobileScanPayment = {
  method: string;
  amount: string;
  approval: string;
};
export type MobileScanPaymentSlip = MobileScanPayment & {
  file: File;
};
export type MobileScanPrefill = {
  name: string;
  phone: string;
  emergencyPhone: string;
  address1: string;
  state: string;
  city: string;
  postcode: string;
  custRef: string;
  note: string;
  deliveryDate: string;
  slipDate: string;
  customerType: string;
  buildingType: string;
  venue: string;
  payment: MobileScanPayment | null;
  payments: MobileScanPaymentSlip[];
  lines: MobileScanLine[];
  sampleId: string | null;
  salesperson: string | null;
  slipImageKey: string | null;
  receiptImageKey: string | null;
  aiOriginal: ExtractedSlip;
};


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

const CAMERA_SM = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" />
    <circle cx="12" cy="13" r="3" />
  </svg>
);

const UPLOAD_SM = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="M17 8l-5-5-5 5" />
    <path d="M12 3v13" />
  </svg>
);

type PickSource = "camera" | "library";

const MENU_W = 156;
const MENU_H = 88;

function PickSourceMenu({ at, onPick, onClose }: {
  at: { left: number; top: number };
  onPick: (from: PickSource) => void;
  onClose: () => void;
}) {
  const row: CSSProperties = {
    display: "flex", alignItems: "center", gap: 9, width: "100%", padding: "10px 12px",
    border: "none", background: "transparent", fontFamily: "inherit", cursor: "pointer", textAlign: "left",
  };
  const label: CSSProperties = { fontSize: 12.5, fontWeight: 700, color: "var(--hz-c-ink)" };
  const icon: CSSProperties = { display: "flex", width: 16, height: 16, flex: "none" };
  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 60 }} />
      <div
        style={{
          position: "fixed", left: at.left, top: at.top, width: MENU_W, zIndex: 61,
          background: "var(--hz-c-surface)", border: "1px solid var(--hz-c-border-subtle)", borderRadius: 12, overflow: "hidden",
          boxShadow: "0 10px 26px -10px rgba(17,24,16,.32)",
        }}
      >
        <button type="button" style={row} onClick={() => onPick("camera")}>
          <span style={icon}>{CAMERA_SM}</span>
          <span style={label}>Take photo</span>
        </button>
        <div style={{ height: 1, background: "var(--hz-dk-surface-2, #eceee9)" }} />
        <button type="button" style={row} onClick={() => onPick("library")}>
          <span style={icon}>{UPLOAD_SM}</span>
          <span style={label}>Upload</span>
        </button>
      </div>
    </>
  );
}

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

function ShotPreview({ shot, alt }: { shot: Shot; alt: string }) {
  if (isPdfShot(shot)) {
    return (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 5, background: "var(--hz-dk-surface-2, #eef1ec)", padding: 8, boxSizing: "border-box" }}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#5c6156" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>
        <span style={{ fontSize: 10, fontWeight: 700, color: "#5c6156", textAlign: "center", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" }}>{shot.file.name}</span>
        <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: ".1em", color: "var(--hz-c-ink-soft)" }}>PDF</span>
      </div>
    );
  }
  return <img src={shot.url} alt={alt} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />;
}

const SLOT_LABELS = ["Front slip", "Payment slip"];

function JobPill({ status }: { status: string }) {
  const base: CSSProperties = {
    display: "inline-flex", alignItems: "center", gap: 5, flex: "none",
    height: 22, padding: "0 9px", borderRadius: 999, fontSize: 10.5, fontWeight: 800,
  };
  if (status === "running") {
    return (
      <span style={{ ...base, background: "var(--hz-dk-primary-soft, #e3efed)", color: "var(--hz-c-primary)" }}>
        <span style={{ width: 10, height: 10, borderRadius: "50%", border: "2px solid rgba(22,105,95,.3)", borderTopColor: "#16695f", animation: "hzSpin .8s linear infinite" }} />
        Reading…
      </span>
    );
  }
  if (status === "done") return <span style={{ ...base, background: "var(--hz-c-primary)", color: "#fff" }}>Done</span>;
  if (status === "error") return <span style={{ ...base, background: "var(--hz-c-err-bg)", color: "var(--hz-c-err)" }}>Failed</span>;
  return <span style={{ ...base, background: "var(--hz-c-bg)", color: "var(--hz-c-ink-muted)" }}>{status === "queued" ? "Queued" : status}</span>;
}

const fmtRm = (rm: number): string =>
  rm.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function extractPayment(ex: ExtractedSlip, catalogs: ReconcileCatalogs): MobileScanPayment | null {
  const p = reconcilePayment(ex, catalogs);
  if (!p) return null;
  return {
    method: p.methodValue,
    amount: p.depositRm > 0 ? fmtRm(p.depositRm) : "0.00",
    approval: p.approvalCode,
  };
}

function buildPrefill(
  d: ExtractResp["data"],
  repName: string,
  paymentSlips: MobileScanPaymentSlip[],
  catalogs: ReconcileCatalogs,
): MobileScanPrefill {
  const ex = d.extracted;
  const rec = reconcileScanPrefill(ex, catalogs);

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
    slipDate: rec.slipDate ?? "",
    customerType: rec.customerType,
    buildingType: rec.buildingType,
    venue: rec.venueText,
    payment: paymentSlips[0]
      ? { method: paymentSlips[0].method, amount: paymentSlips[0].amount, approval: paymentSlips[0].approval }
      : extractPayment(ex, catalogs),
    payments: paymentSlips,
    lines: rec.lines.map((l) => ({
      name: l.description || l.rawText || "",
      qty: String(l.qty),
      price: fmtRm(l.unitPriceRm),
      remark: "",
      rawText: l.rawText,
      suggestedCode: l.suggestedCode,
      confidence: l.confidence,
      itemCode: l.itemCode,
      matchSource: l.matchSource,
    })),
    sampleId: d.sampleId,
    salesperson: repName || rec.salesRep || null,
    slipImageKey: d.imageKey ?? null,
    receiptImageKey: d.receiptImageKey ?? null,
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
  onOpenSo?: (docNo: string) => void;
}) {
  const { user } = useAuth();
  const [orders, setOrders] = useState<OrderDraft[]>(() => [newOrder()]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [orderErrors, setOrderErrors] = useState<Record<string, string>>({});
  const [forcingId, setForcingId] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const frontCamInputRef = useRef<HTMLInputElement>(null);
  const frontLibInputRef = useRef<HTMLInputElement>(null);
  const payCamInputRef = useRef<HTMLInputElement>(null);
  const payLibInputRef = useRef<HTMLInputElement>(null);
  const [pickMenu, setPickMenu] = useState<
    { orderId: string; slot: "front" | "payment"; replacing: boolean; left: number; top: number } | null
  >(null);
  const activeOrderIdRef = useRef<string | null>(null);

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

  useEffect(() => {
    authedFetch("/scan-so/warm", { method: "POST" }).catch(() => {});
  }, []);

  const venuesQ = useVenues();
  const customerTypeOptsQ  = useSoDropdownOptions("customer_type");
  const buildingTypeOptsQ  = useSoDropdownOptions("building_type");
  const paymentMethodOptsQ = useSoDropdownOptions("payment_method");
  const paymentMerchantQ   = useSoDropdownOptions("payment_merchant");
  const onlineTypeOptsQ    = useSoDropdownOptions("online_type");
  const installmentPlanQ   = useSoDropdownOptions("installment_plan");
  const localitiesQ        = useLocalities();

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

  const [salesperson, setSalesperson] = useState((user?.name || user?.email || "").trim());
  const [knownReps, setKnownReps] = useState<string[]>([]);
  const [repsUnavailable, setRepsUnavailable] = useState(false);
  useEffect(() => {
    let alive = true;
    authedFetch<unknown>(SCAN_SALESPEOPLE_PATH)
      .then((r) => { if (alive) { setKnownReps(normalizeScanSalespeople(r)); setRepsUnavailable(false); } })
      .catch((e: unknown) => {
        if (!alive) return;
        setRepsUnavailable(true);
        console.warn("[scan] salesperson list unavailable:", e instanceof Error ? e.message : e);
      });
    return () => { alive = false; };
  }, []);

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
    retry: false,
    refetchInterval: (query) =>
      normalizeJobs(query.state.data).some(isActiveJob) ? 4000 : false,
  });
  const jobs = useMemo(() => normalizeJobs(jobsData), [jobsData]);

  const visibleJobs = useMemo(
    () =>
      jobs.filter((j) => {
        if (!isTodayTs(jobTs(j.createdAt))) return false;
        if (isActiveJob(j)) return true;
        if (isStickyJob(j)) return jobTs(j.updatedAt ?? j.createdAt) > dismissBefore;
        return false;
      }),
    [jobs, dismissBefore],
  );

  const hasFailedRows = visibleJobs.some((j) => j.status === "error");
  const [clearingFailed, setClearingFailed] = useState(false);
  const clearFailedJobs = async () => {
    if (clearingFailed) return;
    setClearingFailed(true);
    try {
      await authedFetch("/scan-so/jobs/clear-failed", { method: "POST" });
      await refetchJobs();
    } catch {
      /* silent-write-ok: nothing is claimed. The failed rows stay on screen
         and the Clear button stays with them, so the screen still shows the
         truth and the operator can simply press it again. */
    } finally {
      setClearingFailed(false);
    }
  };

  const ready = orders.length > 0 && orders.every((o) => o.front !== null);
  const multiOrder = orders.length > 1;

  const openPicker = (
    e: React.MouseEvent<HTMLElement>,
    orderId: string,
    slot: "front" | "payment",
    replacing = false,
  ) => {
    if (submitting) return;
    const r = e.currentTarget.getBoundingClientRect();
    const left = Math.min(Math.max(8, r.left + r.width / 2 - MENU_W / 2), window.innerWidth - MENU_W - 8);
    const below = r.top + 44;
    const top = below + MENU_H > window.innerHeight - 12 ? Math.max(8, r.top - MENU_H - 6) : below;
    setPickMenu({ orderId, slot, replacing, left, top });
  };
  const runPick = (from: PickSource) => {
    const req = pickMenu;
    setPickMenu(null);
    if (!req || submitting) return;
    activeOrderIdRef.current = req.orderId;
    if (req.slot === "front") {
      if (req.replacing) clearFront(req.orderId);
      (from === "camera" ? frontCamInputRef : frontLibInputRef).current?.click();
    } else {
      (from === "camera" ? payCamInputRef : payLibInputRef).current?.click();
    }
  };

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

  const extractOne = async (front: Shot, payFile: File): Promise<ExtractResp> => {
    const form = new FormData();
    const [frontFile, slipFile] = await compressAllForOcr([front.file, payFile]);
    form.append("file", frontFile);
    form.append("file", slipFile);
    if (salesperson) form.append("salesperson", salesperson);
    return authedFetch<ExtractResp>("/scan-so/extract", { method: "POST", body: form });
  };

  const extractOrder = async (order: OrderDraft): Promise<MobileScanPrefill | null> => {
    if (!order.front || order.payShots.length === 0) return null;
    const responses: ExtractResp[] = [];
    for (const shot of order.payShots) {
      responses.push(await extractOne(order.front, shot.file));
    }
    const first = responses[0];
    if (!first || !first.success || !first.data) return null;
    const repName = salesperson || (first.data.extracted.salesRep ?? "").trim();
    const catalogs: ReconcileCatalogs = { ...catalogsBase, skus: first.data.catalog.skus };
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
    const files = await compressAllForOcr([order.front!.file, ...order.payShots.map((s) => s.file)]);
    for (const f of files) form.append("file", f);
    if (salesperson) form.append("salesperson", salesperson);
    if (force) form.append("force", "1");
    return authedFetch<{ job_id: string; status: string }>("/scan-so/enqueue", { method: "POST", body: form });
  };

  const createAnyway = async (orderId: string) => {
    const order = orders.find((o) => o.id === orderId);
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

  const submitLegacy = async () => {
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
      let queued = 0;
      const dupErrors: Record<string, string> = {};
      for (const order of orders) {
        if (!order.front) continue;
        try {
          await enqueueOne(order);
          queued++;
        } catch (e) {
          const err = e as Error & { status?: number; body?: string };
          if (err.status === 409 && typeof err.body === "string" && err.body.includes("duplicate_slip")) {
            let reason = "This slip was already uploaded.";
            try {
              const b = JSON.parse(err.body) as { reason?: string };
              if (typeof b.reason === "string" && b.reason.trim() !== "") reason = b.reason;
            } catch { }
            dupErrors[order.id] = reason;
            continue;
          }
          if (err.status === 404 && queued === 0 && Object.keys(dupErrors).length === 0) {
            await submitLegacy();
            return;
          }
          throw e;
        }
      }
      if (Object.keys(dupErrors).length > 0) {
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
      const err = e as Error & { status?: number; body?: string };
      const keyMissing =
        err.status === 503 || (typeof err.body === "string" && err.body.includes("anthropic_key_missing"));
      if (keyMissing) {
        setUnavailable(true);
      } else {
        setError(err.message || "Couldn't read the slip — try again.");
      }
    } finally {
      setSubmitting(false);
    }
  };


  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div className="hdr-row">
          <button onClick={onBack} className="back" aria-label="Cancel">
            <span className="chev">{"‹"}</span> Cancel
          </button>
        </div>
        <div className="scr-title" style={{ marginTop: 2 }}>Scan order slip</div>
        <div style={{ fontSize: 11, color: "var(--hz-c-ink-muted)", marginTop: 2 }}>Snap each slip — one front slip and its payment slips per order. Queue as many orders as you like.</div>
      </header>

      <div className="scroll" style={{ padding: 14, paddingBottom: 120 }}>
        {unavailable ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", padding: "34px 12px 8px" }}>
            <div style={{ width: 64, height: 64, borderRadius: "50%", background: "var(--hz-dk-warning-bg, #f4ecdf)", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 16 }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#a16a2e" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" /></svg>
            </div>
            <div style={{ fontSize: 17, fontWeight: 800, color: "var(--hz-c-ink)", marginBottom: 8 }}>Scan isn't available yet</div>
            <div style={{ fontSize: 12.5, color: "var(--hz-c-ink-muted)", lineHeight: 1.55, maxWidth: 280 }}>
              Slip scanning isn't switched on in this environment yet. You can still create the order by hand from the New Sales Order form.
            </div>
            <button onClick={() => setUnavailable(false)} style={{ marginTop: 26, height: 48, padding: "0 22px", borderRadius: 12, border: "1px solid var(--hz-c-primary)", background: "var(--hz-c-surface)", color: "var(--hz-c-primary)", fontFamily: "inherit", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>
              Back to capture
            </button>
          </div>
        ) : (
          <>
            {visibleJobs.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 6 }}>
                  <div className="ey" style={{ letterSpacing: ".14em", color: "var(--hz-c-ink-soft)", fontSize: 10.5 }}>Recent scans</div>
                  {hasFailedRows && (
                    <button
                      onClick={() => void clearFailedJobs()}
                      disabled={clearingFailed}
                      style={{ border: "none", background: "none", padding: "0 2px", fontFamily: "inherit", fontSize: 11.5, fontWeight: 700, color: "var(--hz-c-primary)", cursor: "pointer", opacity: clearingFailed ? 0.5 : 1 }}
                    >
                      {clearingFailed ? "Clearing…" : "Clear"}
                    </button>
                  )}
                </div>
                <div style={{ border: "1px solid var(--hz-c-border-subtle)", borderRadius: 14, background: "var(--hz-c-surface)", overflow: "hidden" }}>
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
                            <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--hz-c-ink)", lineHeight: 1.35 }}>
                              {j.soDocNo ? `${j.soDocNo} — saved to Orders` : "Saved to Orders"}
                            </div>
                          )}
                          {j.status === "error" && (
                            <div style={{ fontSize: 12, color: "var(--hz-c-err)", lineHeight: 1.45 }}>
                              {j.error || "Couldn't read the slip."}
                            </div>
                          )}
                          {j.status === "done" && j.error && (
                            <div style={{ fontSize: 11, color: "var(--hz-c-accent)", lineHeight: 1.45, marginTop: 2 }}>{j.error}</div>
                          )}
                          {j.duplicateOf && (
                            <div style={{ fontSize: 11, color: "var(--hz-c-accent)", fontWeight: 700, lineHeight: 1.45, marginTop: 2 }}>
                              Duplicate of {j.duplicateOf}
                            </div>
                          )}
                        </div>
                        <span style={{ flex: "none", fontSize: 10.5, color: "var(--hz-c-ink-soft)", paddingTop: 4 }}>
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

            <input
              ref={frontCamInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              style={{ display: "none" }}
              onChange={(e) => {
                onFrontFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <input
              ref={frontLibInputRef}
              type="file"
              accept="image/*,application/pdf"
              style={{ display: "none" }}
              onChange={(e) => {
                onFrontFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <input
              ref={payCamInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              style={{ display: "none" }}
              onChange={(e) => {
                addPayFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <input
              ref={payLibInputRef}
              type="file"
              accept="image/*,application/pdf"
              multiple
              style={{ display: "none" }}
              onChange={(e) => {
                addPayFiles(e.target.files);
                e.target.value = "";
              }}
            />

            {orders.map((order, oi) => (
              <div
                key={order.id}
                style={{ border: "1px solid var(--hz-c-border-subtle)", borderRadius: 14, padding: 12, marginBottom: 12, background: "var(--hz-c-surface)" }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 800, color: "var(--hz-c-ink)" }}>Order {oi + 1}</span>
                  {multiOrder && !submitting && (
                    <button
                      onClick={() => removeOrder(order.id)}
                      style={{ display: "flex", alignItems: "center", gap: 4, height: 26, padding: "0 10px", borderRadius: 999, border: "1px solid #f0d4d4", background: "var(--hz-c-surface)", color: "var(--hz-c-err)", fontFamily: "inherit", fontSize: 11, fontWeight: 700, cursor: "pointer" }}
                    >
                      {"×"} Remove order
                    </button>
                  )}
                </div>

                <div className="ey" style={{ letterSpacing: ".14em", color: "var(--hz-c-ink-soft)", fontSize: 10.5, marginBottom: 6 }}>{SLOT_LABELS[0]}</div>
                {order.front ? (
                  <div className="ph" style={{ position: "relative", height: 130, borderRadius: 12, overflow: "hidden", marginBottom: 4 }}>
                    <ShotPreview shot={order.front} alt={SLOT_LABELS[0]} />
                    <span style={{ position: "absolute", top: 6, left: 6, width: 20, height: 20, borderRadius: "50%", background: "#2f8a5b", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      {CHECK}
                    </span>
                    {!submitting && (
                      <>
                        <RemoveButton
                          label={`Remove ${SLOT_LABELS[0]} for order ${oi + 1}`}
                          onClick={() => clearFront(order.id)}
                          style={{ position: "absolute", top: 6, right: 6 }}
                        />
                        <button
                          onClick={(e) => openPicker(e, order.id, "front", true)}
                          aria-label={`Replace ${SLOT_LABELS[0]} for order ${oi + 1}`}
                          style={{ position: "absolute", bottom: 6, right: 6, height: 24, padding: "0 9px", borderRadius: 999, border: "none", background: "rgba(17,20,15,.62)", color: "#fff", fontFamily: "inherit", fontSize: 10.5, fontWeight: 700, cursor: "pointer" }}
                        >
                          Replace
                        </button>
                      </>
                    )}
                  </div>
                ) : (
                  <button
                    onClick={(e) => openPicker(e, order.id, "front")}
                    disabled={submitting}
                    style={{ height: 130, width: "100%", border: "1px dashed var(--hz-c-border-strong)", borderRadius: 12, background: "var(--hz-c-surface-2)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, cursor: submitting ? "default" : "pointer", fontFamily: "inherit", opacity: submitting ? 0.5 : 1, marginBottom: 4 }}
                  >
                    {CAMERA}
                    <span style={{ fontSize: 11, fontWeight: 700, color: "var(--hz-c-primary)" }}>{SLOT_LABELS[0]}</span>
                  </button>
                )}

                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginTop: 14, marginBottom: 6 }}>
                  <span className="ey" style={{ letterSpacing: ".14em", color: "var(--hz-c-ink-soft)", fontSize: 10.5 }}>Payment slips</span>
                  <span style={{ fontSize: 10.5, color: "var(--hz-c-ink-soft)" }}>
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
                    onClick={(e) => openPicker(e, order.id, "payment")}
                    disabled={submitting}
                    aria-label={order.payShots.length === 0 ? `${SLOT_LABELS[1]} for order ${oi + 1}` : `Add another payment slip to order ${oi + 1}`}
                    style={{ height: 96, width: "100%", border: "1px dashed var(--hz-c-border-strong)", borderRadius: 12, background: "var(--hz-c-surface-2)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 5, cursor: submitting ? "default" : "pointer", fontFamily: "inherit", opacity: submitting ? 0.5 : 1 }}
                  >
                    {CAMERA}
                    <span style={{ fontSize: 10.5, fontWeight: 700, color: "var(--hz-c-primary)", textAlign: "center", lineHeight: 1.25 }}>
                      {order.payShots.length === 0 ? SLOT_LABELS[1] : "Add payment"}
                    </span>
                  </button>
                </div>
                <div style={{ fontSize: 10.5, color: "var(--hz-c-ink-soft)", textAlign: "center", marginTop: 10 }}>
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
                  <div style={{ marginTop: 10, background: "var(--hz-c-accent-soft)", border: "1px solid #e8dcc5", borderRadius: 11, padding: "10px 12px", fontSize: 12, color: "#6a4a1e", lineHeight: 1.5 }}>
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                      <svg width="15" height="15" style={{ flex: "none", marginTop: 1 }} viewBox="0 0 24 24" fill="none" stroke="#a16a2e" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" /></svg>
                      <span>{orderErrors[order.id]}</span>
                    </div>
                    <button
                      onClick={() => void createAnyway(order.id)}
                      disabled={forcingId === order.id}
                      style={{ marginTop: 9, height: 34, width: "100%", border: "1px solid #a16a2e", borderRadius: 9, background: forcingId === order.id ? "var(--hz-dk-warning-bg, #efe6d6)" : "#a16a2e", color: forcingId === order.id ? "var(--hz-c-accent)" : "#fff", fontSize: 12, fontWeight: 700, fontFamily: "inherit", cursor: forcingId === order.id ? "default" : "pointer" }}
                    >
                      {forcingId === order.id ? "Creating…" : "Create anyway"}
                    </button>
                  </div>
                )}
              </div>
            ))}

            <button
              onClick={addOrder}
              disabled={submitting}
              style={{ height: 46, width: "100%", border: "1px dashed var(--hz-c-primary)", borderRadius: 12, background: "var(--hz-c-surface)", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, cursor: submitting ? "default" : "pointer", fontFamily: "inherit", opacity: submitting ? 0.5 : 1, color: "var(--hz-c-primary)", fontSize: 13, fontWeight: 700 }}
            >
              <span style={{ fontSize: 18, lineHeight: 1 }}>{"+"}</span> Add order
            </button>

            <div style={{ display: "flex", alignItems: "flex-start", gap: 9, background: "var(--hz-c-accent-soft)", border: "1px solid #e8dcc5", borderRadius: 11, padding: 11, marginTop: 12, fontSize: 11, color: "#6a4a1e", lineHeight: 1.5 }}>
              <svg width="15" height="15" style={{ flex: "none", marginTop: 1 }} viewBox="0 0 24 24" fill="none" stroke="#a16a2e" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" /></svg>
              <span>
                We read {multiOrder ? "each slip" : "the slip"} and save {multiOrder ? "a draft order per slip" : "a draft order"} to Orders in the background. Open {multiOrder ? "each draft" : "the draft"} from Orders to review every field, correct anything the reader missed, then finalise.
              </span>
            </div>

            <label style={{ marginTop: 16, display: "block" }}>
              <span className="ey" style={{ display: "block", letterSpacing: ".14em", color: "var(--hz-c-ink-soft)", fontSize: 9.5, fontWeight: 700, marginBottom: 5 }}>Salesperson</span>
              <input
                aria-label="Salesperson"
                list="mobile-scan-salespeople"
                value={salesperson}
                disabled={submitting}
                onChange={(e) => setSalesperson(e.target.value)}
                placeholder="Whose slip is this?"
                style={{ width: "100%", boxSizing: "border-box", height: 42, padding: "0 12px", borderRadius: 10, border: "1px solid var(--hz-c-border-subtle)", background: "var(--hz-c-surface)", fontFamily: "inherit", fontSize: 14, color: "var(--ink)" }}
              />
            </label>
            <datalist id="mobile-scan-salespeople">
              {knownReps.map((r) => <option key={r} value={r} />)}
            </datalist>
            {repsUnavailable && (
              <div style={{ marginTop: 5, fontSize: 11, color: "var(--hz-c-accent)" }}>
                Couldn&apos;t load the salesperson list — type the name instead.
              </div>
            )}

            {submitting && (
              <div style={{ marginTop: 16, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, fontSize: 12, color: "var(--hz-c-ink-muted)" }}>
                <span style={{ width: 14, height: 14, borderRadius: "50%", border: "2px solid rgba(22,105,95,.3)", borderTopColor: "#16695f", animation: "hzSpin .8s linear infinite" }} />
                Uploading — the reading finishes in the background.
              </div>
            )}

            {error && (
              <div style={{ marginTop: 16, background: "var(--hz-c-err-bg)", border: "1px solid #f0d4d4", borderRadius: 11, padding: "11px 13px", fontSize: 12, color: "var(--hz-c-err)", lineHeight: 1.5 }}>
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

      {pickMenu && (
        <PickSourceMenu at={pickMenu} onPick={runPick} onClose={() => setPickMenu(null)} />
      )}

      <style>{`@keyframes hzSpin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
