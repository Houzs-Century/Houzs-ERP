// ----------------------------------------------------------------------------
// PaymentInfoBlock — the ONE presentation of a recorded (persisted) payment's
// details (the left-hand info column of a ledger row).
//
// Owner 2026-07-13: a "Recorded" payment used to render DIFFERENTLY in the
// draft-edit view (a thin "date · raw-enum · amount" box) versus the confirmed
// SO detail (method label + account + collected-by + bank/tenure + online type
// + approval code). This component is the single source for that left-hand info
// block so the two surfaces can never drift again.
//
// Owner 2026-07-16: converging only the INFO half was not enough — the two
// screens still owned their own row chrome, and the draft-edit copy shipped
// WITHOUT the edit/delete affordances, so entering "Edit Draft" REMOVED the
// pencil + trash the previous screen offered. The whole row (this block + slip +
// amount + edit + delete + the edit sheet) now lives in RecordedPayments.tsx,
// which is the only caller of this component. Render a payment through
// <RecordedPaymentsList>, never by hand — a second row renderer is what inverted
// editability in the first place.
//
// Uses the shared `.hz-m` theme CSS vars (mobile.css), available under both
// screens' `.hz-m` root, so the block looks identical in either context.
// ----------------------------------------------------------------------------

import { formatDate } from "../lib/utils";

/** A recorded payment as either surface holds it. Fields are optional so the
 *  draft-edit view's reduced fetch and the detail view's full fetch both fit;
 *  camelCase aliases cover the postgres.js / PostgREST casing drift. */
export type RecordedPaymentLike = {
  method: string | null;
  paid_at: string | null;
  account_sheet?: string | null;
  collected_by_name?: string | null;
  approval_code?: string | null;
  merchant_provider?: string | null;
  installment_months?: number | null;
  online_type?: string | null;
  merchantProvider?: string | null;
  installmentMonths?: number | null;
  onlineType?: string | null;
  /* Money moved from a cancelled order (docs/bugs/0933): the order it came from. */
  converted_from_so_doc_no?: string | null;
  convertedFromSoDocNo?: string | null;
  /* A negative converted row is money that LEFT this order (owner 2026-09-16). */
  amount_sen?: number | null;
  converted_to_so_doc_no?: string | null;
  refund_pv_id?: string | null;
};

const METHOD_LABELS: Record<string, string> = {
  cash: 'Cash', transfer: 'Online', merchant: 'Merchant', installment: 'Installment', converted: 'Convert from another SO',
};
const methodLabel = (m: string | null): string => (m ? METHOD_LABELS[m] ?? m : '—');

/** Numeric DD/MM/YYYY (owner-locked date format), TZ-aware via the shared helper
 *  so a date-only string renders in Asia/Kuala_Lumpur without an off-by-one on an
 *  off-zone device; em-dash when empty/unparseable. */
const dm = (d: string | null | undefined): string => formatDate(d);

export function PaymentInfoBlock({ payment }: { payment: RecordedPaymentLike }) {
  const p = payment;
  const bank = p.merchantProvider ?? p.merchant_provider;
  const months = p.installmentMonths ?? p.installment_months;
  const online = p.onlineType ?? p.online_type;
  const meta = [dm(p.paid_at), p.account_sheet, p.collected_by_name]
    .filter((x) => x && String(x).trim())
    .join(' · ');
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--ink)' }}>{Number(p.amount_sen) < 0 ? (p.refund_pv_id ? 'Refund' : 'Moved out') : methodLabel(p.method)}</div>
      <div className="money" style={{ fontSize: 10.5, color: 'var(--mut)', marginTop: 2 }}>{meta}</div>
      {/* Bank + tenure (Merchant + Installment) / online type (Transfer) —
          parity with desktop PaymentsTable. Installment carries a bank too since
          2026-07-19 (owner: it drives the EPP fee). Dual-read camelCase ?? snake_case. */}
      {(p.method === 'merchant' || p.method === 'installment') && (
        <div className="money" style={{ fontSize: 10, color: 'var(--mut2)' }}>
          {[bank, typeof months === 'number' ? `${months} month${months === 1 ? '' : 's'}` : 'One shot']
            .filter((x) => x && String(x).trim())
            .join(' · ')}
        </div>
      )}
      {p.method === 'converted' && Number(p.amount_sen) < 0 ? (
        <div className="money" style={{ fontSize: 10, color: 'var(--mut2)' }}>{p.converted_to_so_doc_no ? `to ${p.converted_to_so_doc_no}` : 'money that left this order'}</div>
      ) : p.method === 'converted' ? (
        <div className="money" style={{ fontSize: 10, color: 'var(--mut2)' }}>from {p.convertedFromSoDocNo ?? p.converted_from_so_doc_no ?? '—'}</div>
      ) : null}
      {p.method === 'transfer' && online ? (
        <div className="money" style={{ fontSize: 10, color: 'var(--mut2)' }}>{online}</div>
      ) : null}
      {p.approval_code ? (
        <div className="money" style={{ fontSize: 10, color: 'var(--mut2)' }}>Approval {p.approval_code}</div>
      ) : null}
    </div>
  );
}
