// ----------------------------------------------------------------------------
// so-payment-row — the ONE writer of scm.mfg_sales_order_payments' insert path,
// with the Account Sheet rule and the column list that belong to it.
//
// WHY IT IS ITS OWN MODULE. Two writers reach this code and only one of them is
// an HTTP request: POST /:docNo/payments, and scan-so.ts's background receipt
// booking, which has no request context. Everything that must be true of a
// payment ROW therefore has to live below the route layer or it applies to
// whichever writer somebody remembered — the AutoCount enqueue at the bottom is
// exactly that rule, and it was missing for both until 2026-08-15.
//
// Lifted out of mfg-sales-orders.ts unchanged apart from the imports. That file
// is over its size ceiling and may only shrink; this is the split the ratchet
// asks for, not a redesign.
// ----------------------------------------------------------------------------
import { enqueueEdit } from './autocount-outbox';
import { recordSoAudit, type FieldChange } from './so-audit';
import { postSoPayment, reverseSoPayment } from '../../acc/payments';
import { createReceiptForPayment } from '../../acc/receipts';
import { companyCodeById } from './doc-no';
import { recomputeSiPaidForOrder } from './si-order-deposit';

/* Account Sheet auto-fill (Loo 2026-06-07) — "where did the money land".
   Derived from the payment's own method fields whenever the operator didn't
   type one, so the Detail Listing column stops rendering dashes:
     merchant / installment → the acquiring bank (merchant_provider)
     transfer               → the online sub-type (DuitNow / TNG / …)
     cash                   → 'Cash'
   A hand-typed value (Finance, backend PaymentsTable) ALWAYS wins — this is
   a default, not an overwrite. Hoisted `function` so the SO-create deposit
   paths above can call it too. */
export function deriveAccountSheet(
  method: string,
  merchantProvider?: string | null,
  onlineType?: string | null,
): string {
  if (method === 'merchant' || method === 'installment') {
    return merchantProvider?.trim() || 'Card terminal';
  }
  if (method === 'transfer') return onlineType?.trim() || 'Bank transfer';
  return 'Cash';
}

// merchant_provider, installment_months, approval_code, payment_date,
// paid_sen) are NOT touched here — those columns are scheduled for
// drop in a follow-up migration once live data is migrated.
export const PAYMENT_COLS =
  'id, so_doc_no, paid_at, method, merchant_provider, installment_months, ' +
  'online_type, approval_code, amount_sen, account_sheet, slip_key, collected_by, note, ' +
  'created_at, created_by, version, updated_at';

/* ── recordSoPaymentRow — the factored insert+audit core of
   POST /:docNo/payments (same pattern as createSalesOrderCore). ONE place
   derives the method-scoped fields (merchant/installment vs transfer vs cash),
   auto-fills the Account Sheet, inserts the mfg_sales_order_payments row and
   appends the ADD_PAYMENT audit entry. The HTTP route keeps its own guards
   (self-scope, SO existence, overpayment, slip-session resolution + promote)
   and calls this for the write; the background scan job (scan-so.ts) calls it
   directly with an R2 key it already owns (scan-jobs/{jobId}/{n}) — payment
   field derivation is never reimplemented outside this function. */
export type SoPaymentRowInput = {
  docNo: string;
  paidAt: string;
  method: 'merchant' | 'transfer' | 'cash' | 'installment';
  merchantProvider?: string | null;
  installmentMonths?: number | null;
  onlineType?: string | null;
  approvalCode?: string | null;
  amountSen: number;
  accountSheet?: string | null;
  slipKey: string | null;
  collectedBy?: string | null;
  note?: string | null;
  createdBy: string;
  actorName?: string | null;
  /* First-deposit marker — the list/detail paid-rollup adds the header
     deposit_sen on top of the ledger UNLESS an is_deposit row marks the
     deposit as already booked (migration 0155 semantics). The scan job's
     first receipt row IS the header deposit, so it sets this. */
  isDeposit?: boolean;
  auditSource?: string;
  auditNote?: string;
};

export async function recordSoPaymentRow(
  sb: any,
  p: SoPaymentRowInput,
): Promise<{ payment: Record<string, unknown> | null; errorMessage: string | null }> {
  // Method-scoped fields per the cascade:
  //   merchant    → merchant_provider + installment_months (0 / null = One-off)
  //   installment → merchant_provider + installment_months (merchant-like —
  //                 mirrors the SO-create deposit path, which keeps both)
  //   transfer    → online_type
  //   cash        → no extras
  const merchantLike      = p.method === 'merchant' || p.method === 'installment';
  const merchantProvider  = merchantLike ? (p.merchantProvider ?? null) : null;
  // 0 = "One-off" — store as NULL so the integer column carries semantic
  // "no installment". Anything > 0 is the term in months.
  const installmentMonths = merchantLike
    ? (typeof p.installmentMonths === 'number' && p.installmentMonths > 0 ? p.installmentMonths : null)
    : null;
  const onlineType        = p.method === 'transfer' ? (p.onlineType ?? null) : null;

  // Multi-company (mig 0061): the payment inherits the SO's company (resolved by
  // doc_no — this factored writer has no request context). No-op when unresolved.
  const { data: soCo, error: soCoErr } = await sb.from('mfg_sales_orders').select('company_id').eq('doc_no', p.docNo).maybeSingle();
  /* REFUSE on a failed read rather than carrying on with a null company.
     supabase-js does not throw, so the old `const { data }` could not tell "this
     order is in company 1" from "the database blipped" — and the next statement
     inserts the money either way. The SCM client is service-role, so the
     company_id predicate is the entire tenant boundary; a company-less payment
     row is invisible and unscoped, and it would also make the AutoCount enqueue
     below no-op silently. A refusal the operator can retry is the better
     failure. A row that is genuinely ABSENT still yields null, unchanged. */
  if (soCoErr) {
    return { payment: null, errorMessage: `could not resolve the order's company: ${soCoErr.message}` };
  }
  const companyId = (soCo as { company_id?: number | null } | null)?.company_id ?? null;

  const { data, error } = await sb.from('mfg_sales_order_payments').insert({
    ...(companyId != null ? { company_id: companyId } : {}),
    so_doc_no:          p.docNo,
    paid_at:            p.paidAt,
    method:             p.method,
    merchant_provider:  merchantProvider,
    installment_months: installmentMonths,
    online_type:        onlineType,
    approval_code:      p.approvalCode ?? null,
    amount_sen:       p.amountSen,
    /* Account Sheet auto-fill (Loo 2026-06-07) — a hand-typed value wins;
       blank/whitespace falls back to the method-derived default. */
    account_sheet:      p.accountSheet?.trim() || deriveAccountSheet(p.method, merchantProvider, onlineType),
    slip_key:           p.slipKey,
    collected_by:       p.collectedBy ?? null,
    note:               p.note ?? null,
    created_by:         p.createdBy,
    /* Only set when explicitly asked — the manual route's rows are balance
       payments and keep the column default (false). */
    ...(p.isDeposit === true ? { is_deposit: true } : {}),
  }).select(PAYMENT_COLS).single();
  if (error) return { payment: null, errorMessage: error.message };

  /* The Official Receipt is born with the payment (GL redesign item 9) —
     DRAFT for card/transfer, formal at once for cash. BEST-EFFORT: the money
     is recorded; a receipt hiccup must never un-record it, and
     ensureReceiptForPayment heals the gap at the next print. */
  try {
    const paymentId = String((data as { id?: unknown } | null)?.id ?? '');
    const code = companyId != null ? await companyCodeById(sb, companyId) : null;
    if (paymentId && companyId != null && code) {
      await createReceiptForPayment(sb, {
        source: 'SOPAY', paymentId, companyId, companyCode: code,
        docNo: p.docNo, method: p.method, amountSen: p.amountSen,
        paidAt: String(p.paidAt ?? '').slice(0, 10) || null, createdBy: p.createdBy ?? null,
      });
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[receipts] draft OR not created for SO payment:', e);
  }

  /* Post-merge stitch — wire ADD_PAYMENT into the PR-D audit ledger.
     Field-changes list mirrors what the user typed so the History panel
     can render a readable diff. Best-effort inside recordSoAudit. */
  await recordSoAudit(sb, {
    docNo: p.docNo,
    action: 'ADD_PAYMENT',
    actorId: p.createdBy,
    actorName: p.actorName ?? null,
    ...(p.auditSource ? { source: p.auditSource } : {}),
    ...(p.auditNote ? { note: p.auditNote } : {}),
    fieldChanges: [
      { field: 'paidAt',             from: null, to: p.paidAt },
      { field: 'method',             from: null, to: p.method },
      { field: 'amountSen',        from: null, to: p.amountSen },
      ...(merchantProvider  ? [{ field: 'merchantProvider',  from: null, to: merchantProvider  } satisfies FieldChange] : []),
      ...(installmentMonths ? [{ field: 'installmentMonths', from: null, to: installmentMonths } satisfies FieldChange] : []),
      ...(onlineType        ? [{ field: 'onlineType',        from: null, to: onlineType        } satisfies FieldChange] : []),
      ...(p.approvalCode    ? [{ field: 'approvalCode',      from: null, to: p.approvalCode    } satisfies FieldChange] : []),
      ...(p.accountSheet    ? [{ field: 'accountSheet',      from: null, to: p.accountSheet    } satisfies FieldChange] : []),
    ],
  });

  /* AutoCount's BALANCE UDF is what the order still owes, so a payment CHANGES
     a value the account book holds — and no other path re-sends it. Without
     this the figure in the book stays whatever it was at the last line or
     header save, which for a fully-settled order reads as still outstanding.

     Queued from the CORE and not from the HTTP route because scan-so.ts inserts
     through here too, with no request context. A rule written into the route
     would cover the payments a human typed and silently miss every receipt the
     scan job books — this module's recurring shape.

     enqueueEdit never throws and returns false when the write-back is off or
     the order has no AutoCount counterpart, so the payment's own success does
     not depend on it. */
  await enqueueEdit(sb, {
    companyId,
    docType: 'SO',
    docNo: p.docNo,
    /* p.createdBy is a Supabase auth uuid; the outbox's created_by is the
       numeric houzs user id, and there is no mapping to hand here. Provenance
       for this row lives in the ADD_PAYMENT audit entry above. */
    createdBy: null,
  });

  /* Accounting-module hook (需求书 §6.3, owner approved 2026-08-16): book the
     payment through the one posting gate. Best-effort like the enqueue above —
     a booking failure never fails the operator's save; the accounting
     backfill endpoint is the self-heal. */
  const booked = await postSoPayment(sb, data as never);
  if (!booked.ok) {
    /* eslint-disable-next-line no-console */
    console.error('[acc] SO payment not booked:', (data as { id?: string }).id, booked.status, booked.reason);
  }

  /* The invoices raised off this order settle partly out of THIS money
     (lib/si-order-deposit), so their status has to be re-rolled here. Without
     it the invoice DETAIL would read correctly the moment you opened it while
     the invoice LIST — which reads the persisted status — kept telling the
     office to chase a customer who had just paid. Queued from the CORE for the
     same reason the AutoCount enqueue above is: scan-so.ts books receipts
     through here with no request context. Best-effort; a failure leaves a stale
     status the next roll self-heals. */
  await recomputeSiPaidForOrder(sb, p.docNo, companyId);

  return { payment: data as Record<string, unknown>, errorMessage: null };
}

/**
 * Everything that must happen AFTER an order's payment row is deleted.
 *
 * Here rather than in the route for this module's standing reason: a rule
 * written into `DELETE /:docNo/payments/:id` covers the payments a human
 * deleted and nothing else. Both halves are best-effort — the operator's delete
 * has already committed and neither a ledger nor a status roll may turn it into
 * a 500 they would retry.
 */
export async function afterSoPaymentRemoved(
  sb: any,
  p: { paymentId: string; docNo: string; companyId: number | null },
): Promise<void> {
  /* Accounting-module hook (需求书 §6.3, owner approved 2026-08-16): void the
     deleted payment's ledger entry. A row that never booked no-ops. */
  const unbooked = await reverseSoPayment(sb, p.paymentId, p.docNo);
  if (!unbooked.ok) {
    /* eslint-disable-next-line no-console */
    console.error('[acc] SO payment reversal failed:', p.paymentId, unbooked.status, unbooked.reason);
  }
  /* The deposit just shrank, so an invoice it was settling may owe money again.
     This is the direction that matters: an invoice left reading PAID after the
     payment behind it was reversed tells the office to collect nothing. */
  await recomputeSiPaidForOrder(sb, p.docNo, p.companyId);
}
