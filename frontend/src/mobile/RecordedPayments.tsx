// ----------------------------------------------------------------------------
// RecordedPayments — the ONE mobile presentation of a PERSISTED payment ledger.
//
// Owner 2026-07-16 ("為什麼那麼奇怪 我還沒有點 edit draft 可以 edit payment,
// 反而點了 edit draft 不給 edit"): editability was INVERTED. The scan-draft
// review screen (MobileSODetail) rendered each recorded payment WITH a pencil +
// trash, but entering "Edit Draft" (MobileNewSO edit mode) re-rendered the SAME
// rows through a hardcoded read-only box with NO affordances — so the edit view
// could do LESS than the view it was launched from.
//
// The cause was two renderers, not a gate: MobileSODetail owned the editable
// row (pencil/trash/slip/amount) inline, and MobileNewSO owned a second,
// read-only copy. PaymentInfoBlock had already converged the *info* half for the
// same reason (2026-07-13); this module extends that seam to the WHOLE row —
// info + slip + amount + edit + delete + the edit sheet — so the two surfaces
// cannot drift again. Both screens now render <RecordedPaymentsList>; neither
// owns payment-row markup. Standing owner rule: ONE logic layer, desktop=mobile.
//
// Desktop equivalent = vendor/scm/components/PaymentsTable (SalesOrderDetail
// renders it with locked={!isDraftSo && (isLocked || !isEditing)} +
// draftUnlocked={isDraftSo}). Desktop was never inverted — it has ONE page for
// view+edit — so the gates here mirror it exactly:
//   canEdit       = isDraftSo || !isLocked   (a DRAFT is never confirmed ⇒ always
//                   adjustable; owner: "payment draft著的時候為什麼還是不能edit")
//   draftUnlocked = isDraftSo                (lifts the per-row same-day lock)
// ----------------------------------------------------------------------------

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useConfirm } from "../vendor/scm/components/ConfirmDialog";
import { useNotify } from "../vendor/scm/components/NotifyDialog";
import { fetchPaymentSlipUrl, uploadSlipFull } from "../vendor/scm/lib/slip";
import {
  useAddSalesOrderPayment,
  useEditSalesOrderPayment,
  useAttachSalesOrderPaymentSlip,
  useDeleteSalesOrderPayment,
} from "../vendor/scm/lib/sales-order-queries";
import { todayMyt, mytDayOf } from "../vendor/scm/lib/dates";
/* The SHARED payment-window predicate — the same function the server and the
   desktop PaymentsTable call, so no surface can disagree about whether the
   same-day window is still open (Owner 2026-07-19). */
import { paymentRowMutable } from "../vendor/scm/lib/so-field-policy";
import {
  useSoDropdownOptions,
  optionsOrFallback,
  FALLBACK_OPTIONS,
  type SoDropdownOption,
} from "../vendor/scm/lib/so-dropdown-options-queries";
import { paymentMethodCodeForValue } from "../vendor/scm/lib/payment-methods";
import { missingMethodSubField } from "../vendor/scm/components/PaymentsTable";
import { fmtCenti } from "../lib/scm";
import { useIdempotencyKey } from "../lib/idempotency";
import { PaymentInfoBlock, type RecordedPaymentLike } from "./PaymentInfoBlock";

/* A persisted payment as either mobile surface holds it. Superset of
   RecordedPaymentLike; the casing pairs cover the postgres.js / PostgREST drift
   (dual-read camelCase ?? snake_case — the historical #1 bug on this stack). */
export type RecordedPayment = RecordedPaymentLike & {
  id: string;
  version: number;
  amount_centi: number | null;
  collected_by?: string | null;
  slip_key?: string | null;
  slipKey?: string | null;
  /* Row creation instant (UTC) — drives the same-day EDIT affordance (a payment
     may be corrected only on the MY calendar day it was recorded, unless the SO
     is still a DRAFT). */
  created_at?: string | null;
  createdAt?: string | null;
};

const slipKeyOf = (p: RecordedPayment) => p.slipKey ?? p.slip_key ?? null;
const createdAtOf = (p: RecordedPayment) => p.createdAt ?? p.created_at ?? null;

export const PAY_METHODS = ["Cash", "Merchant", "Online", "Installment"] as const;
export type PayMethodLabel = (typeof PAY_METHODS)[number];

/* Offline fallback + parsing seed only; the rendered dropdowns read the LIVE
   maintenance catalog via useSoDropdownOptions. Single-sourced from
   FALLBACK_OPTIONS so it can't drift ("Maybank" -> "MBB", "One Shot" -> "One-off"). */
const PLAN_OPTS = FALLBACK_OPTIONS.installment_plan.map((o) => o.value);

/* 'One Shot' → null (no installment term); 'N months' → N. */
const planToMonths = (label: string): number | null => {
  const m = /^(\d+)\s*month/i.exec(String(label).trim());
  return m ? Number(m[1]) : null;
};
/* installment_months (int|null) → the Plan option label to rehydrate the select
   when editing. null / unmatched → the first plan ("One-off"). */
const monthsToPlan = (months: number | null | undefined): string => {
  if (!months) return PLAN_OPTS[0];
  return PLAN_OPTS.find((p) => planToMonths(p) === months) ?? `${months} months`;
};
/* Reverse of the shared method map (backend enum → sheet label). */
const CODE_TO_PAY_METHOD: Record<string, PayMethodLabel> = {
  cash: "Cash", transfer: "Online", merchant: "Merchant", installment: "Installment",
};
const toCenti = (s: string) => Math.round((parseFloat(String(s).replace(/,/g, "")) || 0) * 100);

type Opt = { value: string; label: string };
/* Owner 2026-07-16 ("Acc sheet 亂填?") — DESKTOP PARITY, was missing on mobile.
   A controlled <select> whose `value` matches no <option> does NOT render blank:
   the browser shows the FIRST option while React state keeps the real value. So
   a payment stored with a bank the live catalog doesn't list (e.g. "PBB" — the
   seeded catalog has "Public", not "PBB") rendered as "MBB" (BANK_OPTS[0]) next
   to its true, correctly-derived Account Sheet of "PBB" — the form contradicting
   the row it was editing. Desktop's PaymentsTable already grandfathers the
   stored value back in as an option; mobile never did. Keep the stored value so
   the select can only ever display what is actually persisted. */
const withStoredOption = (opts: readonly SoDropdownOption[], value: string): Opt[] => {
  const base = opts.map((o) => ({ value: o.value, label: o.label }));
  return !value || base.some((o) => o.value === value) ? base : [...base, { value, label: value }];
};

/* Slip on a persisted payment row — blob-fetches the slip (GET
   /:docNo/payments/:id/slip-url, Worker-proxied) and shows it as an actual
   THUMBNAIL the operator taps to open full-size.

   Owner 2026-07-19: the slip must be legible. This row previously rendered a
   14px camera GLYPH and nothing else — strictly worse than desktop, which at
   least had a (too small) 34px crop. You could not tell from the row whether a
   slip was even readable, or which of two payments it belonged to, without
   tapping through one at a time.

   The thumbnail is 56px square with object-fit:contain, sized to the mobile
   row's existing control rhythm (the pencil/trash buttons beside it are 14px
   glyphs in ~22px hit areas, so 56 reads as a deliberate content tile rather
   than an oversized icon) and matching the 120px-tall preview the Edit sheet
   already uses. Non-image slips (PDF) keep the glyph — there is nothing to
   thumbnail. The fetch stays lazy and per-row, exactly as before. */
function SlipLink({ docNo, paymentId }: { docNo: string; paymentId: string }) {
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [isImage, setIsImage] = useState(false);
  const notify = useNotify();

  /* Resolve the slip once per row so the thumbnail can render inline. A failure
     here is NOT surfaced as a dialog — an unreachable thumbnail on a list row
     is not something the operator asked for. It falls back to the glyph, and
     the tap path below still reports a real failure loudly. */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchPaymentSlipUrl(docNo, paymentId);
        if (cancelled) return;
        setUrl(res.url);
        setIsImage((res.contentType ?? "").startsWith("image/"));
      } catch {
        if (!cancelled) { setUrl(null); setIsImage(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [docNo, paymentId]);

  const open = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const resolved = url ?? (await fetchPaymentSlipUrl(docNo, paymentId)).url;
      window.open(resolved, "_blank", "noopener");
    } catch (e) {
      void notify({ title: "Couldn't open slip", body: e instanceof Error ? e.message : "Something went wrong.", tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={open}
      title="Open payment slip full size"
      aria-label="Open payment slip full size"
      style={{ border: "none", background: "transparent", cursor: "pointer", padding: "0 6px", display: "flex", alignItems: "center", opacity: busy ? 0.5 : 1 }}
    >
      {isImage && url ? (
        <img
          src={url}
          alt="Payment slip"
          style={{
            width: 56, height: 56, objectFit: "contain", display: "block",
            borderRadius: 6, border: "1px solid var(--line2)", background: "#fff",
          }}
        />
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" /><circle cx="12" cy="13" r="3" /></svg>
      )}
    </button>
  );
}

/* Existing-slip preview for the Edit Payment sheet — blob-fetches the persisted
   payment's slip (same GET /:docNo/payments/:id/slip-url the read-view SlipLink
   uses) and shows it as a thumbnail the operator taps to open full-size, so they
   SEE which slip is attached while editing. PDFs (no <img> render) fall back to a
   "View slip" link. The slip itself is never changed by an edit. */
function PaymentSlipPreview({ docNo, paymentId }: { docNo: string; paymentId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [contentType, setContentType] = useState<string>("");
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  useEffect(() => {
    let live = true;
    let objUrl: string | null = null;
    (async () => {
      try {
        const res = await fetchPaymentSlipUrl(docNo, paymentId);
        if (!live) { URL.revokeObjectURL(res.url); return; }
        objUrl = res.url;
        setUrl(res.url);
        setContentType(res.contentType);
        setState("ready");
      } catch {
        if (live) setState("error");
      }
    })();
    return () => { live = false; if (objUrl) URL.revokeObjectURL(objUrl); };
  }, [docNo, paymentId]);
  const isPdf = contentType.includes("pdf");
  return (
    <div className="fld">
      <span className="fld-l">Attached slip</span>
      {state === "loading" ? (
        <div style={{ fontSize: 11.5, color: "var(--mut)", padding: "6px 0" }}>Loading slip…</div>
      ) : state === "error" || !url ? (
        <div style={{ fontSize: 11.5, color: "var(--mut)", padding: "6px 0" }}>Couldn't load the attached slip.</div>
      ) : isPdf ? (
        <button
          type="button"
          onClick={() => window.open(url, "_blank", "noopener")}
          style={{ width: "100%", boxSizing: "border-box", height: 40, borderRadius: 9, cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 700, border: "1px solid #bcdcd7", background: "#e1efed", color: "#16695f" }}
        >
          View attached slip (PDF)
        </button>
      ) : (
        <button
          type="button"
          onClick={() => window.open(url, "_blank", "noopener")}
          title="Open slip full-size"
          style={{ padding: 0, border: "1px solid #d6d9d2", borderRadius: 9, background: "#f4f6f3", cursor: "pointer", overflow: "hidden", display: "block", width: "fit-content" }}
        >
          <img src={url} alt="Payment slip" style={{ display: "block", maxHeight: 120, maxWidth: "100%", objectFit: "contain" }} />
        </button>
      )}
    </div>
  );
}

/* ── Add / Edit Payment sheet ────────────────────────────────────────────────
   Records ONE payment through POST /:docNo/payments — the SAME endpoint + body
   shape MobileNewSO.recordSlipBackedPayments uses — or PATCHes an existing row
   (edit mode). Slip is OPTIONAL (owner 2026-07-13). No pricing logic lives here;
   the backend recomputes the balance and derives the Account Sheet. Design = the
   shared .hz-m bottom sheet + fld / fld-i / fld-l classes. */
export function AddPaymentSheet({
  docNo,
  staff,
  defaultCollectedBy = "",
  editPayment = null,
  onClose,
  onSaved,
}: {
  docNo: string;
  staff: Array<{ id: string; name: string }>;
  /* Collected By default for a NEW payment = logged-in user's staff id. */
  defaultCollectedBy?: string;
  /* When set, the sheet EDITS this persisted payment (PATCH) instead of adding
     a new one (POST). Same fields, seeded from the row. */
  editPayment?: RecordedPayment | null;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const notify = useNotify();
  const addPaymentMut = useAddSalesOrderPayment();
  const editPaymentMut = useEditSalesOrderPayment();
  const isEdit = Boolean(editPayment);
  /* One key for the one payment this sheet is open to record (lib/idempotency.ts).
     The sheet's MOUNT is the intent: both parents render it behind `payOpen` /
     `editPay` and close it in onSaved, so re-opening always starts a new intent
     with a new key, while every retry of THIS submit reuses this one. */
  const idemKey = useIdempotencyKey();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [method, setMethod] = useState<PayMethodLabel>(
    () => (editPayment ? CODE_TO_PAY_METHOD[editPayment.method ?? "cash"] ?? "Cash" : "Cash"),
  );
  const [date, setDate] = useState<string>(
    () => (editPayment?.paid_at ?? "").slice(0, 10) || todayMyt(),
  );
  const [amount, setAmount] = useState(
    () => (editPayment ? ((editPayment.amount_centi ?? 0) / 100).toFixed(2) : "0.00"),
  );
  const [account, setAccount] = useState(editPayment?.account_sheet ?? "");
  const [approval, setApproval] = useState(editPayment?.approval_code ?? "");
  const [collectedBy, setCollectedBy] = useState(editPayment?.collected_by ?? defaultCollectedBy);
  /* Owner 2026-07-16 — seed the L2 picks from the ROW ONLY (desktop parity:
     beginEditPersisted uses `p.merchant_provider ?? ''`). These were
     `editPayment?.merchant_provider || BANK_OPTS[0]`, which invented a bank:
     a row whose bank was NULL (or unreadable) silently seeded "MBB" into state,
     and saving then WROTE "MBB" onto a payment nobody had assigned a bank to.
     A blank falls to the "— Bank —" placeholder and the save gate below. */
  const [bank, setBank] = useState(
    editPayment ? (editPayment.merchantProvider ?? editPayment.merchant_provider ?? "") : "",
  );
  const [plan, setPlan] = useState(() => (
    editPayment ? monthsToPlan(editPayment.installmentMonths ?? editPayment.installment_months) : PLAN_OPTS[0]
  ));
  const [online, setOnline] = useState(
    editPayment ? (editPayment.onlineType ?? editPayment.online_type ?? "") : "",
  );
  /* Account Sheet ("where the money landed") is DERIVED server-side from the
     payment's own method + bank / online sub-type (deriveAccountSheet,
     mfg-sales-orders.ts); a hand-typed value wins. Send it verbatim exactly as
     desktop's PaymentsTable does — the server owns the re-derive when the Bank
     changes (2026-07-16), so the rule lives in ONE place and both platforms get
     the same answer. Do NOT add a client-side derive here. */
  /* Live payment dropdowns from the maintenance catalog (same API as desktop) —
     each keeps the row's stored value selectable even when the catalog dropped
     it (withStoredOption), so the select can never display a different bank
     than the one on the row. */
  const bankOpts = withStoredOption(optionsOrFallback("payment_merchant", useSoDropdownOptions("payment_merchant").data), bank);
  const planOpts = withStoredOption(optionsOrFallback("installment_plan", useSoDropdownOptions("installment_plan").data), plan);
  const onlineOpts = withStoredOption(optionsOrFallback("online_type", useSoDropdownOptions("online_type").data), online);
  const [slipName, setSlipName] = useState("");
  const [slipSession, setSlipSession] = useState("");
  const [slipPhase, setSlipPhase] = useState<"" | "uploading" | "done" | "error">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onPickSlip = async (f: File | null) => {
    if (!f) return;
    setSlipName(f.name); setSlipSession(""); setSlipPhase("uploading");
    try {
      const { uploadSessionId } = await uploadSlipFull({ file: f });
      setSlipSession(uploadSessionId); setSlipPhase("done");
    } catch {
      setSlipPhase("error");
    }
  };

  const amtOk = toCenti(amount) > 0;
  /* Method ⇒ sub-field cascade, via the SHARED desktop rule (missingMethodSubField,
     PaymentsTable) rather than a mobile re-implementation: Merchant needs a Bank
     + Plan, Online needs a Sub-Type. The server enforces the same on write
     (payment_method_field_required, 2026-07-16) — this surfaces it before the
     round-trip instead of as a 400. */
  const missingSubField = amtOk
    ? missingMethodSubField({
        methodLabel: method,
        merchantProvider: bank,
        installmentMonthsLabel: plan,
        onlineType: online,
      })
    : null;
  /* Owner 2026-07-13 — the slip is OPTIONAL now; recording needs only an
     amount > 0 (+ method/date + the method's own sub-fields). The slip upload
     stays available for when one IS on hand. */
  const canSave = amtOk && !missingSubField && !busy && slipPhase !== "uploading";

  const save = async () => {
    if (!canSave) return;
    setError(null);
    setBusy(true);
    /* Same body MobileNewSO.recordSlipBackedPayments POSTs — do NOT reimplement
       pricing; the backend recomputes the balance. In EDIT mode the same fields
       PATCH the existing row (slip untouched). */
    const code = paymentMethodCodeForValue(method) ?? "cash";
    const body: Record<string, unknown> = {
      paidAt: date,
      method: code,
      amountCenti: toCenti(amount),
      accountSheet: account.trim() || null,
      approvalCode: approval.trim() || null,
      collectedBy: collectedBy || null,
    };
    // Slip is optional — only send the session when one was actually uploaded.
    if (!isEdit && slipSession) body.uploadSessionId = slipSession;
    if (code === "merchant") { body.merchantProvider = bank || null; body.installmentMonths = planToMonths(plan); }
    else if (code === "installment") { body.merchantProvider = bank || null; body.installmentMonths = planToMonths(plan); }
    else if (code === "transfer") { body.onlineType = online || null; }
    try {
      /* The shared vendored mutations — mobile shares the desktop payment write
         path (they invalidate the payments ledger key useSalesOrderPayments reads). */
      if (isEdit && editPayment) {
        /* No key on the EDIT path, deliberately: a PATCH sets named fields on ONE
           row addressed by id, so firing it twice writes the same row the same
           way. It cannot duplicate money; only the POST below creates a row. */
        await editPaymentMut.mutateAsync({ docNo, id: editPayment.id, version: editPayment.version, ...body });
      } else {
        await addPaymentMut.mutateAsync({ docNo, ...body, idempotencyKey: idemKey });
      }
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't record the payment. Please try again.");
      void notify({ title: isEdit ? "Changes not saved" : "Payment not recorded", body: e instanceof Error ? e.message : "Something went wrong.", tone: "error" });
      setBusy(false);
    }
  };

  return (
    <div className="hz-m sheet-bd" onClick={() => { if (!busy) onClose(); }}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="grab" />
        <div className="sheet-head">
          <div>
            <div className="card-t" style={{ fontSize: 15 }}>{isEdit ? "Edit payment" : "Add payment"}</div>
            <div style={{ fontSize: 11, color: "var(--mut)", marginTop: 2 }}>{docNo}</div>
          </div>
          <button type="button" className="sheet-x" onClick={() => { if (!busy) onClose(); }} aria-label="Close">{"✕"}</button>
        </div>
        <div className="sheet-scroll">
          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            <div className="fld">
              <span className="fld-l">Method</span>
              <select className="fld-i" value={method} onChange={(e) => setMethod(e.target.value as PayMethodLabel)}>
                {PAY_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div style={{ display: "flex", gap: 9 }}>
              <label className="fld" style={{ flex: 1.1 }}>
                <span className="fld-l">Date</span>
                <input className="fld-i" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </label>
              <label className="fld" style={{ flex: 1.1 }}>
                <span className="fld-l">Amount</span>
                <input className="fld-i money" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
              </label>
            </div>
            {method === "Merchant" && (
              <div style={{ display: "flex", gap: 9 }}>
                <div className="fld" style={{ flex: 1 }}>
                  <span className="fld-l">Bank</span>
                  <select className="fld-i" value={bank} onChange={(e) => setBank(e.target.value)}>
                    <option value="">— Bank —</option>
                    {bankOpts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div className="fld" style={{ flex: 1 }}>
                  <span className="fld-l">Plan</span>
                  <select className="fld-i" value={plan} onChange={(e) => setPlan(e.target.value)}>
                    <option value="">— Plan —</option>
                    {planOpts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
              </div>
            )}
            {/* Installment — Bank + Plan (owner 2026-07-19 "Installment 要能选银行的").
                Bank drives the EPP fee; same picker/source as Merchant. Optional
                (no save gate), matching desktop + the server. */}
            {method === "Installment" && (
              <div style={{ display: "flex", gap: 9 }}>
                <div className="fld" style={{ flex: 1 }}>
                  <span className="fld-l">Bank</span>
                  <select className="fld-i" value={bank} onChange={(e) => setBank(e.target.value)}>
                    <option value="">— Bank —</option>
                    {bankOpts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div className="fld" style={{ flex: 1 }}>
                  <span className="fld-l">Plan</span>
                  <select className="fld-i" value={plan} onChange={(e) => setPlan(e.target.value)}>
                    <option value="">— Plan —</option>
                    {planOpts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
              </div>
            )}
            {method === "Online" && (
              <div className="fld">
                <span className="fld-l">Sub-type</span>
                <select className="fld-i" value={online} onChange={(e) => setOnline(e.target.value)}>
                  <option value="">— Sub-type —</option>
                  {onlineOpts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
            )}
            <div style={{ display: "flex", gap: 9 }}>
              <label className="fld" style={{ flex: 1 }}>
                <span className="fld-l">Account Sheet</span>
                <input
                  className="fld-i"
                  value={account}
                  onChange={(e) => setAccount(e.target.value)}
                  placeholder="Auto from method"
                />
              </label>
              <label className="fld" style={{ flex: 1 }}>
                <span className="fld-l">Approval Code</span>
                <input className="fld-i" value={approval} onChange={(e) => setApproval(e.target.value)} placeholder="Terminal no" />
              </label>
            </div>
            <div className="fld">
              <span className="fld-l">Collected By</span>
              <select className="fld-i" value={collectedBy} onChange={(e) => setCollectedBy(e.target.value)}>
                <option value="">—</option>
                {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            {/* Edit mode — show the EXISTING attached slip so the operator can
                see what's on the row while editing (owner request). The slip is
                not changed by an edit; this is view-only. */}
            {isEdit && editPayment && slipKeyOf(editPayment) && (
              <PaymentSlipPreview docNo={docNo} paymentId={editPayment.id} />
            )}
            {/* Owner 2026-07-13 — slip is OPTIONAL. Uploader stays available for
                when a receipt IS on hand; no "required" gate. Hidden in edit
                mode (the slip isn't changed by an edit). */}
            {!isEdit && (
              <div className="fld">
                <span className="fld-l" style={{ color: "#9aa093" }}>Slip (optional)</span>
                <input ref={fileRef} type="file" accept="image/*,application/pdf" style={{ display: "none" }} onChange={(e) => { void onPickSlip(e.target.files?.[0] ?? null); e.target.value = ""; }} />
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  disabled={slipPhase === "uploading" || busy}
                  title={slipName || "Attach a payment slip"}
                  style={{
                    width: "100%", boxSizing: "border-box", height: 40, borderRadius: 9, cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 700,
                    border: slipPhase === "done" ? "1px solid #bcdcd7" : "1px solid #d6d9d2",
                    background: slipPhase === "done" ? "#e1efed" : "#f4f6f3",
                    color: slipPhase === "done" ? "#16695f" : "#414539",
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 6, overflow: "hidden",
                  }}
                >
                  {slipPhase === "uploading" ? "Uploading…"
                    : slipPhase === "done" ? "Slip attached ✓"
                    : slipPhase === "error" ? "Retry upload"
                    : "Upload slip"}
                </button>
              </div>
            )}
            {/* Plain-language block reason (owner standing rule) — say what is
                missing instead of only greying Save out. */}
            {missingSubField && (
              <div style={{ fontSize: 11.5, color: "#a16a2e", textAlign: "center" }}>
                Choose the {missingSubField} for this {method.toLowerCase()} payment.
              </div>
            )}
            {error && <div style={{ fontSize: 11.5, color: "var(--red)", textAlign: "center" }}>{error}</div>}
          </div>
        </div>
        <div className="sheet-foot">
          <button type="button" className="btn-ghost" style={{ flex: 1, opacity: busy ? 0.55 : 1 }} disabled={busy} onClick={() => onClose()}>Cancel</button>
          <button type="button" className="btn" style={{ flex: 1.3, opacity: canSave ? 1 : 0.5 }} disabled={!canSave} onClick={() => void save()}>{busy ? (isEdit ? "Saving…" : "Recording…") : (isEdit ? "Save changes" : "Record Payment")}</button>
        </div>
      </div>
    </div>
  );
}

/* ── RecordedPaymentsList — the shared persisted-payment ledger ───────────────
   Renders every recorded payment as info (PaymentInfoBlock) + slip + amount +
   edit + delete, and owns the delete flow and the edit sheet. This is the ONE
   payments card the owner asked for: the scan-draft review screen and the Edit
   Sales Order sheet both mount it, so entering Edit can never offer LESS than
   the screen it was opened from. */
export function RecordedPaymentsList({
  docNo,
  payments,
  staff,
  defaultCollectedBy = "",
  canEdit,
  draftUnlocked = false,
  busy = false,
  inset = false,
  emptyText = "No payments recorded.",
  onChanged,
}: {
  docNo: string;
  payments: RecordedPayment[];
  staff: Array<{ id: string; name: string }>;
  defaultCollectedBy?: string;
  /** Payments are add/edit/delete-able. Desktop parity (SalesOrderDetail):
   *  isDraftSo || !isLocked — i.e. a DRAFT is ALWAYS editable. */
  canEdit: boolean;
  /** Parent SO is a DRAFT — lifts the per-row same-day EDIT lock. */
  draftUnlocked?: boolean;
  /** Parent has an action in flight — dims the row affordances. */
  busy?: boolean;
  /** Rows sit inside a padded card body (MobileNewSO) rather than directly in a
   *  card (MobileSODetail). Layout only — no behaviour differs. */
  inset?: boolean;
  emptyText?: string;
  /** Refresh the caller's payments + any derived KPI after a write. */
  onChanged: () => void | Promise<void>;
}) {
  const confirm = useConfirm();
  const deletePaymentMut = useDeleteSalesOrderPayment();
  const attachSlipMut = useAttachSalesOrderPaymentSlip();
  const [editPay, setEditPay] = useState<RecordedPayment | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disabled = busy || working;

  /* Attach the proof to an ALREADY-RECORDED payment (owner 2026-08-07). One
     hidden input, re-targeted per row — `attachTarget` holds the row the picker
     was opened for, `attaching` its id while the upload is in flight.

     Deliberately NOT behind rowMutable, unlike the pencil and the trash beside
     it: the same-day window guards the MONEY, and this changes none of it. The
     proof for a balance collected on delivery routinely reaches the office days
     later — gating it the same way would leave that payment permanently without
     its slip, which is the gap this exists to close. The server agrees (the
     /slip route is un-gated where PATCH and DELETE are not). */
  const attachInputRef = useRef<HTMLInputElement | null>(null);
  const attachTargetRef = useRef<RecordedPayment | null>(null);
  const [attaching, setAttaching] = useState<string | null>(null);

  const openAttachPicker = (p: RecordedPayment) => {
    if (disabled || attaching) return;
    attachTargetRef.current = p;
    attachInputRef.current?.click();
  };

  const onAttachFilePicked = async (file: File | null) => {
    const target = attachTargetRef.current;
    attachTargetRef.current = null;
    if (attachInputRef.current) attachInputRef.current.value = "";
    if (!file || !target) return;
    if (slipKeyOf(target) && !(await confirm({
      title: "Replace the proof on this payment?",
      body: "The slip currently attached will be swapped for the one you just picked. The change is recorded in the order history.",
      confirmLabel: "Replace",
    }))) return;
    setError(null);
    setAttaching(target.id);
    try {
      const { uploadSessionId } = await uploadSlipFull({ file });
      await attachSlipMut.mutateAsync({ docNo, id: target.id, uploadSessionId });
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't attach the proof. Please try again.");
    } finally {
      setAttaching(null);
    }
  };

  /* SAME-DAY WINDOW (owner 2026-07-19) — "删除只有在当天才行". A payment row may
     be edited or deleted only on the MY calendar day it was KEYED IN
     (created_at, never the document's payment date — otherwise editing an old
     payment's date to today would unlock its own deletion).

     Routed through the shared paymentRowMutable() so this screen, the desktop
     table and the server all read one rule. An unreadable created_at denies the
     control rather than defaulting it open. */
  const rowMutable = (p: RecordedPayment): boolean => {
    const day = mytDayOf(createdAtOf(p));
    if (day === null) return false;
    return paymentRowMutable(day, todayMyt(), draftUnlocked).mutable;
  };

  /* Delete a persisted payment — parity with the desktop PaymentsTable trash
     action. In-app confirm (no-naked-edits), then the shared mutation. */
  const deletePayment = async (paymentId: string) => {
    if (disabled) return;
    if (!(await confirm({
      title: "Delete this payment?",
      body: "This removes the recorded payment and re-opens the balance.",
      confirmLabel: "Delete",
      danger: true,
    }))) return;
    setError(null);
    setWorking(true);
    try {
      const row = payments.find((p) => p.id === paymentId);
      if (!row) throw new Error("Payment is no longer loaded. Refresh before deleting it.");
      await deletePaymentMut.mutateAsync({ docNo, id: paymentId, version: row.version });
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't delete the payment. Please try again.");
    } finally {
      setWorking(false);
    }
  };

  /* Row chrome is the SO detail's verbatim (hairline between rows, none above
     the first — the card header already separates it). `inset` only drops the
     horizontal padding for a caller that already pads its card body. */
  const rowStyle = (i: number): CSSProperties => ({
    display: "flex",
    justifyContent: "space-between",
    gap: 10,
    alignItems: "center",
    padding: inset ? "9px 0" : "11px 13px",
    borderTop: i ? "1px solid var(--line2)" : "none",
  });

  return (
    <>
      {/* One picker for every row — `attachTargetRef` says which. Accepts the
          same mimes as the desktop SlipUploadField; `capture` is deliberately
          omitted so the phone offers Camera / Photos / Files rather than forcing
          a live shot (the slip is usually already in the camera roll). */}
      <input
        ref={attachInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,application/pdf"
        style={{ display: "none" }}
        onChange={(e) => void onAttachFilePicked(e.target.files?.[0] ?? null)}
      />
      {payments.length ? payments.map((p, i) => (
        <div key={p.id} style={rowStyle(i)}>
          <PaymentInfoBlock payment={p} />
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {slipKeyOf(p) ? <SlipLink docNo={docNo} paymentId={p.id} /> : null}
            <span className="money" style={{ fontSize: 12.5, fontWeight: 700, color: "#0c3f39" }}>{fmtCenti(p.amount_centi)}</span>
            {/* Attach / replace the proof — see openAttachPicker: gated by
                `canEdit` only, never by the same-day window. */}
            {canEdit && (
              <button
                type="button"
                onClick={() => openAttachPicker(p)}
                disabled={disabled || attaching !== null}
                title={slipKeyOf(p) ? "Replace payment proof" : "Attach payment proof"}
                aria-label={slipKeyOf(p) ? "Replace payment proof" : "Attach payment proof"}
                style={{ border: "none", background: "transparent", cursor: "pointer", padding: "0 4px", display: "flex", alignItems: "center", opacity: (disabled || attaching !== null) ? 0.4 : 1 }}
              >
                {attaching === p.id ? (
                  <span style={{ fontSize: 10.5, color: "var(--mut)" }}>…</span>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2f5d4f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>
                )}
              </button>
            )}
            {/* Same-day EDIT (owner 2026-07-13) — the pencil needs edit rights
                AND, for a submitted SO, that the row was recorded today (after
                MYT midnight it locks). A DRAFT's rows are never same-day-locked
                (draftUnlocked), matching the server, which exempts DRAFT from the
                same-day PATCH lock. */}
            {canEdit && rowMutable(p) && (
              <button
                type="button"
                onClick={() => setEditPay(p)}
                disabled={disabled}
                title="Edit payment (same-day only)"
                aria-label="Edit payment"
                style={{ border: "none", background: "transparent", cursor: "pointer", padding: "0 4px", display: "flex", alignItems: "center", opacity: disabled ? 0.4 : 1 }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2f5d4f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
              </button>
            )}
            {/* Delete payment — parity with desktop PaymentsTable, INCLUDING the
                same-day window (owner 2026-07-19). The trash is genuinely ABSENT
                once the window closes, not disabled and not CSS-hidden. Before
                this it was gated on canEdit alone, so a months-old payment could
                be deleted from the phone while the pencil beside it was already
                locked — and the server had no gate on delete either. */}
            {canEdit && rowMutable(p) && (
              <button
                type="button"
                onClick={() => void deletePayment(p.id)}
                disabled={disabled}
                title="Delete payment"
                aria-label="Delete payment"
                style={{ border: "none", background: "transparent", cursor: "pointer", padding: "0 4px", display: "flex", alignItems: "center", opacity: disabled ? 0.4 : 1 }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#b23a3a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></svg>
              </button>
            )}
          </div>
        </div>
      )) : (
        <div style={{ padding: inset ? "9px 0" : "11px 13px", borderTop: inset ? "none" : "1px solid var(--line2)", fontSize: 11.5, color: "var(--mut2)" }}>{emptyText}</div>
      )}
      {error && <div style={{ padding: inset ? "4px 0" : "0 13px 9px", fontSize: 11.5, color: "var(--red)" }}>{error}</div>}
      {editPay && (
        <AddPaymentSheet
          docNo={docNo}
          staff={staff}
          defaultCollectedBy={defaultCollectedBy}
          editPayment={editPay}
          onClose={() => setEditPay(null)}
          onSaved={async () => { setEditPay(null); await onChanged(); }}
        />
      )}
    </>
  );
}
