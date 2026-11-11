/* The phone Sales Order form's pre-create payment row (method, date, amount,
   sub-fields, slip). Moved out of MobileNewSO.tsx unchanged, to free room under
   its size ceiling. The recorded-payment ledger is RecordedPaymentsList; this is
   the only OTHER payment editor on the phone, so the shared method / slip rules
   below are imported, never re-implemented. */
import { useRef } from "react";
import { useAuth as useHouzsAuth } from "../auth/AuthContext";
import { uploadSlipFull } from "../vendor/scm/lib/slip";
import { todayMyt } from "../vendor/scm/lib/dates";
import { optionsOrFallback, useSoDropdownOptions } from "../vendor/scm/lib/so-dropdown-options-queries";
import { slipDateProblem } from "../vendor/scm/components/PaymentsTable";
import { SLIP_REQUIRED_REASON, slipMissingProblem } from "../vendor/scm/lib/payment-slip-gate";
import { paymentSlipDateWindow } from "../vendor/scm/lib/payment-slip-date";
import { REQUEST_HINT, isBackdateRequestRow } from "../vendor/scm/lib/new-so-backdate";
import { ConvertSourceField, rmInput, withConvertOption } from "./MobileOrderMoney";
import { CONVERT_LABEL, type ConvertSource } from "../vendor/scm/lib/so-money-queries";
import { DateField } from "../vendor/scm/components/DateField";
import { Field, SpecSel } from "./mobile-fields";

/* Same parse as MobileNewSO's num/toSen: RM as typed, commas allowed. */
const toSen = (s: string) => Math.round((parseFloat(String(s).replace(/,/g, "")) || 0) * 100);

export type Payment = {
  /** React list key. NOT usable as an idempotency key: uid() is 8 base36
   *  chars and carries no money semantics. */
  key: string;
  /** Money idempotency key — minted ONCE per payment row and reused by every
   *  retry of that row, so a re-submitted create cannot book it twice.
   *  recordNewPayments has two call sites and the rows survive a failed
   *  submit, which is exactly the double-fire this closes. */
  idempotencyKey: string;
  method: string; // Cash / Merchant / Online / Installment / Convert from another SO
  convertedFromDocNo?: string; // the cancelled order a converted row draws on
  date: string;
  amount: string; // RM as typed
  account: string; // account sheet ref
  approval: string; // approval code
  collectedBy: string; // staff.id (uuid) | ""
  // Method-aware sub-fields
  bank: string; // Merchant provider
  plan: string; // Merchant / Installment plan
  online: string; // Online sub-type
  // Slip capture
  slipName: string;
  slipSession: string;
  slipPhase: "" | "uploading" | "done" | "error";
};

export function PayCard({ pay, staff, convertSources, onChange, onRemove }: { pay: Payment; staff: Array<{ id: string; name: string }>; convertSources: ConvertSource[]; onChange: (patch: Partial<Payment>) => void; onRemove: () => void }) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  /* Live payment dropdowns from the maintenance catalog (same API the desktop
     SalesOrderNew uses); FALLBACK_OPTIONS only backs an offline load. Was
     hardcoded ("Maybank"/"One Shot") and never hit the API — that was the drift. */
  /* "Convert from another SO" joins the list while the customer has an order with money to give (docs/bugs/0933). */
  const methodOpts = withConvertOption(optionsOrFallback("payment_method", useSoDropdownOptions("payment_method").data), convertSources.length > 0 || pay.method === CONVERT_LABEL);
  const bankOpts = optionsOrFallback("payment_merchant", useSoDropdownOptions("payment_merchant").data);
  const planOpts = optionsOrFallback("installment_plan", useSoDropdownOptions("installment_plan").data);
  const onlineOpts = optionsOrFallback("online_type", useSoDropdownOptions("online_type").data);
  /* Slip-date window (owner 2026-09-23) — the same rule, sentence and exception
     as the desktop panel and the payments sheet. The row is bounded here so the
     order is not created before the money's date is refused. */
  const { can: canPay } = useHouzsAuth();
  const mayBackdateSlip = canPay("scm.payment.backdate");
  const slipWindow = paymentSlipDateWindow(todayMyt());
  const slipProblem = slipDateProblem({ paidAt: pay.date, methodLabel: pay.method }, todayMyt(), mayBackdateSlip);
  const onPickSlip = async (f: File | null) => {
    if (!f) return;
    onChange({ slipName: f.name, slipSession: "", slipPhase: "uploading" });
    try {
      const { uploadSessionId } = await uploadSlipFull({ file: f });
      onChange({ slipSession: uploadSessionId, slipPhase: "done" });
    } catch {
      onChange({ slipPhase: "error" });
    }
  };
  return (
    /* Owner 2026-07-04 — hairline borders, matching the LineCard. */
    <div style={{ border: "1px solid var(--hz-dk-border-subtle, #eceee9)", borderRadius: 11, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", background: "var(--hz-c-surface-2)", borderBottom: "1px solid #eceee9" }}>
        <span style={{ fontSize: 9, fontWeight: 700, color: "var(--hz-c-ink-muted)", textTransform: "uppercase", letterSpacing: ".06em" }}>Method</span>
        <select className="fld-i" style={{ flex: 1, fontWeight: 600 }} value={pay.method} onChange={(e) => onChange({ method: e.target.value })}>
          {methodOpts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <span onClick={onRemove} style={{ fontSize: 14, color: "var(--hz-c-ink-soft)", cursor: "pointer", padding: "0 2px" }}>{"✕"}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 7, padding: 10 }}>
        <div style={{ display: "flex", gap: 9, alignItems: "flex-end" }}>
          <Field label="Date" style={{ flex: 1.1 }} onClear={pay.date ? () => onChange({ date: "" }) : undefined}>
            <DateField
              fullWidth
              className="fld-i"
              value={pay.date}
              max={mayBackdateSlip ? undefined : slipWindow.max}
              invalid={slipProblem !== null}
              onChange={(iso) => onChange({ date: iso })}
            />
            {slipProblem && (
              <span style={{ fontSize: 11, lineHeight: 1.3, color: "var(--red)" }}>{isBackdateRequestRow({ paidAt: pay.date, methodLabel: pay.method, receiptBacked: false }, mayBackdateSlip) ? REQUEST_HINT : slipProblem}</span>
            )}
          </Field>
          <Field label="Amount" style={{ flex: 1.1 }}>
            <input className="fld-i money" inputMode="decimal" value={pay.amount} onChange={(e) => onChange({ amount: e.target.value })} />
          </Field>
        </div>
        {/* Merchant needs BOTH (missingMethodSubField); marked required now that
            they seed blank instead of inventing "MBB" / "One-off". */}
        {pay.method === "Merchant" && (
          <div style={{ display: "flex", gap: 9 }}>
            <SpecSel label="Bank" required value={pay.bank} opts={bankOpts} onChange={(vv) => onChange({ bank: vv })} />
            <SpecSel label="Plan" required value={pay.plan} opts={planOpts} onChange={(vv) => onChange({ plan: vv })} />
          </div>
        )}
        {/* Installment — Bank + Plan (owner 2026-07-19 "Installment 要能选银行的").
            Bank drives the EPP fee; same picker/source as Merchant. Optional (no
            required gate), matching desktop + the server. */}
        {pay.method === "Installment" && (
          <div style={{ display: "flex", gap: 9 }}>
            <SpecSel label="Bank" value={pay.bank} opts={bankOpts} onChange={(vv) => onChange({ bank: vv })} />
            <SpecSel label="Plan" value={pay.plan} opts={planOpts} onChange={(vv) => onChange({ plan: vv })} />
          </div>
        )}
        {pay.method === "Online" && (
          <SpecSel label="Sub-type" required value={pay.online} opts={onlineOpts} onChange={(vv) => onChange({ online: vv })} />
        )}
        {/* Which cancelled order the money comes from; picking one fills an empty amount with what is left there. */}
        {pay.method === CONVERT_LABEL && (
          <ConvertSourceField sources={convertSources} value={pay.convertedFromDocNo ?? ""}
            onChange={(d, left) => onChange({ convertedFromDocNo: d, ...(toSen(pay.amount) > 0 ? {} : { amount: rmInput(left) }) })} />
        )}
        <div style={{ display: "flex", gap: 9 }}>
          <Field label="Account Sheet" style={{ flex: 1 }}>
            <input className="fld-i" value={pay.account} onChange={(e) => onChange({ account: e.target.value })} placeholder="Sheet ref" />
          </Field>
          <Field label="Approval Code" style={{ flex: 1 }}>
            <input className="fld-i" value={pay.approval} onChange={(e) => onChange({ approval: e.target.value })} placeholder="Terminal no" />
          </Field>
        </div>
        <div style={{ display: "flex", gap: 9, alignItems: "flex-end" }}>
          <Field label="Collected By" style={{ flex: 1 }}>
            <select className="fld-i" value={pay.collectedBy} onChange={(e) => onChange({ collectedBy: e.target.value })}>
              <option value="">—</option>
              {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <div style={{ flex: 1 }}>
            <div className="fld-l" style={{ color: "var(--hz-c-ink-soft)" }}>{pay.method === CONVERT_LABEL ? "Slip" : "Slip (required)"}</div>
            <input ref={fileRef} type="file" accept="image/*,application/pdf" style={{ display: "none" }} onChange={(e) => { void onPickSlip(e.target.files?.[0] ?? null); e.target.value = ""; }} />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={pay.slipPhase === "uploading"}
              title={pay.slipName || "Attach a payment slip"}
              style={{
                width: "100%", boxSizing: "border-box", height: 38, borderRadius: 9, cursor: "pointer", fontFamily: "inherit", fontSize: 11.5, fontWeight: 700,
                border: pay.slipPhase === "done" ? "1px solid #bcdcd7" : "1px solid #d6d9d2",
                background: pay.slipPhase === "done" ? "#e1efed" : "#f4f6f3",
                color: pay.slipPhase === "done" ? "#16695f" : "#414539",
                display: "flex", alignItems: "center", justifyContent: "center", gap: 6, overflow: "hidden",
              }}
            >
              {pay.slipPhase === "uploading" ? "Uploading…"
                : pay.slipPhase === "done" ? "Slip attached ✓"
                : pay.slipPhase === "error" ? "Retry upload"
                : "Upload slip"}
            </button>
          </div>
        </div>
        {/* The proof is required (owner 2026-10-13, lib/payment-slip-required):
            the save is blocked until this row carries its slip, and the line
            says so in the shared sentence. The row is still RECORDED on its
            amount alone once saved — the writer never filters on the slip. */}
        {pay.slipPhase !== "uploading" && toSen(pay.amount) > 0 && slipMissingProblem({ methodLabel: pay.method, slipUploadSessionId: pay.slipSession || null }) && (
          <div style={{ fontSize: 11, lineHeight: 1.3, color: "var(--red)" }}>{SLIP_REQUIRED_REASON}</div>
        )}
      </div>
    </div>
  );
}
