// ----------------------------------------------------------------------------
// customer-credits — append-only ledger of customer credit balances
// (Commander 2026-05-30, Edge #11).
//
// When a customer overpays, or when a paid Sales Invoice is cancelled, the
// excess turns into a CREDIT BALANCE the customer can spend on future invoices.
// Each event = one row in customer_credits. Sum of amount_centi per
// debtor_code = current credit balance. Apply-to-SI writes a NEGATIVE entry
// AND a payment row on the new SI, so paid_centi advances naturally and the
// SI shows as "covered by previous credit".
//
// This also handles Edge #9: when an SI with paid_centi > 0 is cancelled, the
// cash on the books stays put — the customer just carries the equivalent as a
// credit. No automatic refund.
// ----------------------------------------------------------------------------

import { isMissingRpc } from './rpc-missing';

export type CreditSourceType =
  | 'SI_CANCEL_REFUND'   // SI was cancelled with paid_centi > 0 → credit equal to paid_centi
  | 'SI_REOPEN_CONTRA'   // a cancelled SI was reopened → reverse the SI_CANCEL_REFUND credit
  | 'SO_CANCEL_REFUND'   // SO was cancelled with paid deposit > 0 → credit equal to paid deposit
  | 'OVERPAY'            // payment recorded > remaining due → excess turned into credit
  | 'APPLIED_TO_SI'      // negative entry — credit applied to a new invoice
  | 'MANUAL_ADJUST';     // operator-entered adjustment

export type AddCreditInput = {
  debtorCode: string;
  debtorName?: string | null;
  amountCenti: number;                    // signed: + adds, − applies
  sourceType: CreditSourceType;
  sourceDocNo?: string | null;
  sourceDocId?: string | null;
  notes?: string | null;
  createdBy?: string | null;
  // Multi-company (mig 0061): the ledger row's company (from the source SI/SO).
  companyId?: number | null;
};

/** Insert one ledger row. Idempotency note: callers that need it (cancel /
 *  apply) check existence first via the (sourceType, sourceDocNo) pair before
 *  calling addCustomerCredit. */
export async function addCustomerCredit(sb: any, args: AddCreditInput): Promise<{ ok: boolean; id?: string; reason?: string }> {
  if (!args.debtorCode || !args.debtorCode.trim()) return { ok: false, reason: 'debtor_code_required' };
  if (!Number.isFinite(args.amountCenti) || args.amountCenti === 0) return { ok: false, reason: 'amount_zero' };
  const { data, error } = await sb.from('customer_credits').insert({
    ...(args.companyId != null ? { company_id: args.companyId } : {}),
    debtor_code:   args.debtorCode,
    debtor_name:   args.debtorName ?? null,
    amount_centi:  Math.round(args.amountCenti),
    source_type:   args.sourceType,
    source_doc_no: args.sourceDocNo ?? null,
    source_doc_id: args.sourceDocId ?? null,
    notes:         args.notes ?? null,
    created_by:    args.createdBy ?? null,
  }).select('id').single();
  if (error) return { ok: false, reason: error.message };
  return { ok: true, id: (data as { id: string }).id };
}

/** Sum the live credit balance for a customer, within ONE company.
 *
 *  `companyId` is REQUIRED, and required for the reason `pwp-claim-single.ts`
 *  states for its own company argument: `debtor_code` is NOT globally unique.
 *  Mig 0123 re-keyed `scm.customers` on `(customer_code, company_id)`, so the
 *  same customer code legitimately names a DIFFERENT customer in each company,
 *  while `scm.customer_credits.company_id` is NOT NULL (mig 0083). Summing on
 *  `debtor_code` alone therefore pooled both companies' ledgers into one
 *  balance — and the callers that SPEND it stamp the invoice's company on the
 *  debit, so the stamp is what made the divergence silent (the same shape the
 *  "A STAMP IS NOT A PREDICATE" note in check-company-scope.mjs describes).
 *  An optional parameter would have defaulted every caller back to the pooled
 *  read with no compile error, so it is positional and required.
 *
 *  `null` DEGRADES to no predicate, matching the three-state sentinel in
 *  companyScope.ts: an unresolved company must not blank a single-company
 *  install. Pass an explicit `null` only where that is the intent. */
export async function getCustomerCreditBalance(
  sb: any,
  debtorCode: string,
  companyId: number | null,
): Promise<number> {
  if (!debtorCode || !debtorCode.trim()) return 0;
  let q = sb
    .from('customer_credits')
    .select('amount_centi')
    .eq('debtor_code', debtorCode);
  if (companyId != null) q = q.eq('company_id', companyId);
  const { data } = await q;
  let sum = 0;
  for (const r of (data ?? []) as Array<{ amount_centi: number }>) sum += Number(r.amount_centi ?? 0);
  return sum;
}

type ApplyCreditArgs = {
  debtorCode: string;
  debtorName?: string | null;
  siId: string;
  siNumber: string;
  remainingDueCenti: number;
  createdBy?: string | null;
};

/* The "has the atomic function been applied to this database yet?" predicate now
   lives in lib/rpc-missing, shared with the audit-sink pre-flight, which needs
   exactly the same fallback decision. Two copies would eventually disagree about
   which errors mean "absent". */

/**
 * Apply available customer credit toward a new Sales Invoice.
 *
 * ATOMIC PATH — the credit payment row on the SI and the negative APPLIED_TO_SI
 * ledger row are TWO writes in different tables that must move together, or the
 * invoice ends up paid from a credit that was never debited (customer keeps the
 * balance and spends it twice — a silent half-application). PostgREST's
 * sb.from() cannot span two statements in one transaction, so the write is done
 * by scm.apply_customer_credit_to_si — a function whose body is a single
 * implicit transaction (both inserts commit or neither does), with its
 * idempotency guard INSIDE that transaction. See
 * scripts/scm-schema/customer-credit-atomic-apply.sql.
 *
 * FALLBACK — until that function is applied to a given database, the RPC is
 * absent; we detect that (and ONLY that) and fall back to the legacy two-write
 * path, so behaviour is unchanged pre-apply. paid_centi is not touched here: it
 * is a cache the callers re-derive from the payments table via recomputePaid.
 *
 * No-op when balance ≤ 0. Idempotent: if a credit-payment for this SI already
 * exists, we don't re-apply.
 */
export async function applyCustomerCreditToSi(
  sb: any,
  args: ApplyCreditArgs,
): Promise<{ applied: number; reason?: string }> {
  if (!args.debtorCode || !args.debtorCode.trim()) return { applied: 0, reason: 'no_debtor' };
  if (!(args.remainingDueCenti > 0)) return { applied: 0, reason: 'no_due' };

  /* MIGRATED PAPERWORK SPENDS NO CREDIT (migration 0280). A migrated SI mirrors
     an invoice AutoCount already raised and already settled in its own book.
     Paying it here out of the customer's ERP credit balance would spend a real
     balance a second time — the customer loses money that is still owed to them,
     and nothing downstream can tell it from a genuine application.

     Guarded HERE rather than at the call sites for the same reason postSiRevenue
     is: every caller is then covered by construction. Today the three reachable
     callers all happen to miss migrated invoices anyway — create refuses a
     migrated source, and confirm requires DRAFT while the converter writes SENT
     — but all three are ACCIDENTS of the current shape, not rules. Migration
     0276 shipped a comment saying "never post movements for it" that nothing
     enforced; this is that comment's promise, enforced.

     A FAILED READ REFUSES. Fail-closed leaves the credit standing and the
     invoice merely unpaid, which an operator can see and re-drive; fail-open
     spends a balance that cannot be un-spent. Same direction the RPC-error
     branch below already chose, and for the same reason. */
  const { data: siRow, error: siErr } = await sb
    .from('sales_invoices')
    .select('migrated_no_stock')
    .eq('id', args.siId)
    .maybeSingle();
  if (siErr) return { applied: 0, reason: `migrated_check_failed: ${siErr.message}` };
  if ((siRow as { migrated_no_stock?: boolean | null } | null)?.migrated_no_stock === true) {
    return { applied: 0, reason: 'migrated_source' };
  }

  // Preferred path: one atomic transaction in the DB.
  const { data, error } = await sb.rpc('apply_customer_credit_to_si', {
    p_debtor_code: args.debtorCode,
    p_si_id: args.siId,
    p_si_number: args.siNumber,
    p_remaining_due_centi: Math.round(args.remainingDueCenti),
    p_debtor_name: args.debtorName ?? null,
    p_created_by: args.createdBy ?? null,
  });
  if (!error) {
    // RETURNS TABLE(...) → PostgREST hands back an array of one row.
    const row = (Array.isArray(data) ? data[0] : data) as { applied_centi?: number; reason?: string } | undefined;
    const applied = Number(row?.applied_centi ?? 0);
    return applied > 0 ? { applied } : { applied: 0, reason: row?.reason ?? 'no_apply' };
  }
  if (!isMissingRpc(error)) {
    /* A real DB error — the function ran and rolled back (no partial state), or
       never started. Do NOT fall through to the non-atomic path on a live error;
       report it so the credit stays standing and the SI merely unpaid, both of
       which an operator can see and re-drive. */
    /* eslint-disable-next-line no-console */
    console.error('[customer-credit] atomic apply RPC failed — credit NOT applied:', args.siNumber, error.message);
    return { applied: 0, reason: error.message };
  }

  // The atomic function is not present on this database yet — legacy fallback.
  return applyCustomerCreditToSiLegacy(sb, args);
}

/**
 * LEGACY two-write fallback, used only when scm.apply_customer_credit_to_si has
 * not been applied. Non-atomic by construction (see the NOT-ATOMIC note on the
 * ledger insert below); kept unchanged so pre-apply behaviour does not regress.
 */
async function applyCustomerCreditToSiLegacy(
  sb: any,
  args: ApplyCreditArgs,
): Promise<{ applied: number; reason?: string }> {
  // Idempotency — already applied to this SI?
  const { data: existing, error: existErr } = await sb
    .from('sales_invoice_payments')
    .select('id, amount_centi')
    .eq('sales_invoice_id', args.siId)
    .eq('method', 'credit')
    .limit(1);
  /* A failed READ is not "no credit has been applied yet". supabase-js resolves a
     failed select to { data: null, error } and does NOT throw, so a transient blip
     (Hyperdrive cold-start) used to leave `existing` null, fall straight through
     this guard, and apply the customer's credit a SECOND time — a duplicate
     payment row, a duplicate APPLIED_TO_SI debit, and paid_centi bumped twice, all
     reported as success. Unlike a stale roll-up this is not recoverable by the next
     write: the money has already moved twice.
     Aborting is safe HERE and nowhere later — this guard runs before this function
     writes anything, so returning leaves the credit standing in the ledger and the
     SI merely unpaid. Both are true states an operator can see and act on, and the
     next successful call applies the credit normally. The ERROR is the signal,
     never the emptiness: a customer whose credit has genuinely never been applied
     resolves error === null with data === [] and MUST still fall through and
     apply. */
  if (existErr) {
    /* eslint-disable-next-line no-console */
    console.error('[customer-credit] idempotency read failed — credit NOT applied:', args.siNumber, existErr.message);
    return { applied: 0, reason: 'guard_read_failed' };
  }
  if (existing && existing.length > 0) {
    return { applied: 0, reason: 'already_applied' };
  }

  // Multi-company (mig 0061): the payment + ledger rows inherit the SI's company.
  /* `?? null` does NOT fail closed here, which is the whole reason this aborts.
     company_id is NOT NULL (mig 0083) but mig 0091 also gave every scm/public
     table carrying the column a DEFAULT of the HOUZS company id — so an insert
     that OMITS company_id (which is exactly what the `companyId != null` spreads
     below do when this read fails) does not raise; Postgres silently stamps HOUZS.
     A 2990 customer's credit and its payment row would be booked to Houzs's
     accounts with no error anywhere. Nothing is written at this point, so
     returning is free. */
  /* READ BEFORE THE BALANCE, not after. This read used to sit BELOW the balance
     sum, which meant the balance was necessarily computed without a company and
     pooled both ledgers — the SI's company then stamped the debit, so a company-1
     invoice could consume a company-2 credit row and only the debit carried a
     company. The order is the fix; keep it. */
  const { data: siCo, error: siCoErr } = await sb.from('sales_invoices').select('company_id').eq('id', args.siId).maybeSingle();
  if (siCoErr) {
    /* eslint-disable-next-line no-console */
    console.error('[customer-credit] company read failed — credit NOT applied:', args.siNumber, siCoErr.message);
    return { applied: 0, reason: 'company_read_failed' };
  }
  const companyId = (siCo as { company_id?: number | null } | null)?.company_id ?? null;

  const balance = await getCustomerCreditBalance(sb, args.debtorCode, companyId);
  if (balance <= 0) return { applied: 0, reason: 'no_balance' };
  const apply = Math.min(balance, args.remainingDueCenti);
  if (apply <= 0) return { applied: 0, reason: 'no_due' };

  // 1. Payment row on the SI — marks the SI as (partly) paid.
  const { error: payErr } = await sb.from('sales_invoice_payments').insert({
    ...(companyId != null ? { company_id: companyId } : {}),
    sales_invoice_id: args.siId,
    method: 'credit',
    amount_centi: apply,
    note: `Applied customer credit balance toward ${args.siNumber}`,
    created_by: args.createdBy ?? null,
  });
  if (payErr) return { applied: 0, reason: payErr.message };

  // 2. Ledger entry — negative (credit consumed).
  /* NOT-ATOMIC — this fallback runs ONLY when scm.apply_customer_credit_to_si is
     absent. Steps 1-3 are separate HTTP calls (no BEGIN/COMMIT in this path), so
     if THIS insert fails the payment row from step 1 is already committed and the
     invoice is paid from a credit that was never debited — the customer keeps the
     balance and can spend it again. Neither branch fixes that: returning early
     strands the committed payment row AND lets the guard above read it as
     'already_applied' forever; continuing bumps paid_centi on a debit that does
     not exist. Only a transaction makes this right — which is exactly what the
     atomic RPC in applyCustomerCreditToSi does when present. The reason is
     recorded, not swallowed. See BUG-HISTORY 2026-07-18 (fix/credit-ledger-atomic)
     and 2026-07-17 (fix/silent-money-reads). */
  const ledger = await addCustomerCredit(sb, {
    debtorCode: args.debtorCode,
    debtorName: args.debtorName ?? null,
    amountCenti: -apply,
    sourceType: 'APPLIED_TO_SI',
    sourceDocNo: args.siNumber,
    sourceDocId: args.siId,
    notes: `Auto-applied to ${args.siNumber}`,
    createdBy: args.createdBy ?? null,
    companyId,
  });
  if (!ledger.ok) {
    /* eslint-disable-next-line no-console */
    console.error('[customer-credit] HALF-APPLIED — payment row committed but the ledger debit did NOT:', args.siNumber, ledger.reason);
  }

  // 3. Bump SI's paid_centi — optimistic-concurrency loop (Bug#5 class, ported
  //    from 2990 ce04e468). The old read-modify-write lost a concurrent SI
  //    payment; gate the UPDATE on the value we read and retry on a 0-row
  //    (concurrent) result.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const { data: cur } = await sb.from('sales_invoices').select('paid_centi').eq('id', args.siId).maybeSingle();
    const prev = Number((cur as { paid_centi: number } | null)?.paid_centi ?? 0);
    const { data: upd } = await sb.from('sales_invoices')
      .update({ paid_centi: prev + apply })
      .eq('id', args.siId)
      .eq('paid_centi', prev)
      .select('id');
    if (upd && upd.length > 0) break; // applied; else a concurrent change → re-read + retry
  }

  return { applied: apply };
}

/**
 * Reconcile the OVERPAY ledger entry for one Sales Invoice. After any change
 * to paid_centi (payment add / delete), the customer's credit balance must
 * match (paid_centi − total_centi) clamped at zero. Edge #A.
 *
 *   target_overpay = max(0, paid − total)
 *   existing_overpay = Σ OVERPAY entries for this SI
 *   delta = target − existing
 *
 * If delta > 0: write a positive OVERPAY entry for the new excess.
 * If delta < 0: write a negative entry (correction — operator removed a
 *               payment, the overpay is partially or fully reversed).
 * Skips when delta is 0 (no change). Skips CANCELLED invoices — cancel-credit
 * is handled by creditFromCancelledSi instead.
 */
export async function reconcileSiOverpay(
  sb: any,
  siId: string,
): Promise<{ delta: number; reason?: string }> {
  const { data: si, error: siErr } = await sb
    .from('sales_invoices')
    .select('invoice_number, total_centi, paid_centi, debtor_code, debtor_name, status, company_id')
    .eq('id', siId)
    .maybeSingle();
  /* Distinct from `!si` below: that is a genuinely missing invoice (error null,
     data null) and skipping is correct. This is "we could not find out", which
     took the same branch and reported it as 'not_found' — a false statement about
     an invoice that is sitting right there. */
  if (siErr) {
    /* eslint-disable-next-line no-console */
    console.error('[customer-credit] overpay header read failed — overpay NOT reconciled:', siId, siErr.message);
    return { delta: 0, reason: 'header_read_failed' };
  }
  if (!si) return { delta: 0, reason: 'not_found' };
  const s = si as { invoice_number: string; total_centi: number | null; paid_centi: number | null; debtor_code: string | null; debtor_name: string | null; status: string | null; company_id: number | null };
  if (!s.debtor_code) return { delta: 0, reason: 'no_debtor' };
  if ((s.status ?? '').toUpperCase() === 'CANCELLED') return { delta: 0, reason: 'cancelled' };

  const paid  = Number(s.paid_centi ?? 0);
  const total = Number(s.total_centi ?? 0);
  const target = Math.max(0, paid - total);

  // Σ existing OVERPAY entries already booked for this SI (signed).
  /* This Σ IS the idempotency of this function — `delta = target - existingTotal`
     is what makes a re-run a no-op. A failed read folded to existingTotal = 0 via
     `?? []`, which does not merely understate it: it makes delta = target, so the
     FULL overpay is written again as a second OVERPAY row and the customer is
     credited the same excess twice, on every retry. An invoice that genuinely has
     no OVERPAY row yet resolves error === null with data === [] and MUST still
     fall through — that is the first, correct booking. Nothing is written above
     this point, so returning strands nothing. */
  const { data: existing, error: existErr } = await sb
    .from('customer_credits')
    .select('amount_centi')
    .eq('source_type', 'OVERPAY')
    .eq('source_doc_no', s.invoice_number);
  if (existErr) {
    /* eslint-disable-next-line no-console */
    console.error('[customer-credit] overpay Σ read failed — overpay NOT reconciled:', s.invoice_number, existErr.message);
    return { delta: 0, reason: 'existing_read_failed' };
  }
  const existingTotal = ((existing ?? []) as Array<{ amount_centi: number }>)
    .reduce((acc, r) => acc + Number(r.amount_centi ?? 0), 0);

  const delta = target - existingTotal;
  if (delta === 0) return { delta: 0 };

  const r = await addCustomerCredit(sb, {
    debtorCode: s.debtor_code,
    debtorName: s.debtor_name,
    amountCenti: delta,
    sourceType: 'OVERPAY',
    sourceDocNo: s.invoice_number,
    sourceDocId: siId,
    notes: delta > 0
      ? `Overpayment recorded on ${s.invoice_number} (received ${paid / 100}, due ${total / 100}).`
      : `Overpayment corrected on ${s.invoice_number} after payment removal.`,
    companyId: s.company_id,
  });
  return r.ok ? { delta } : { delta: 0, reason: r.reason };
}

/**
 * Record a refund-as-credit when a paid Sales Invoice is cancelled. Looks at
 * paid_centi > 0 → writes a positive credit row for the customer (idempotent
 * on source_doc_no, so a second cancel-PATCH no-ops).
 */
export async function creditFromCancelledSi(
  sb: any,
  args: { siId: string; siNumber: string; debtorCode: string | null; debtorName: string | null; paidCenti: number; createdBy?: string | null },
): Promise<{ credited: number; reason?: string }> {
  if (!args.debtorCode || !args.debtorCode.trim()) return { credited: 0, reason: 'no_debtor' };
  if (!(args.paidCenti > 0)) return { credited: 0, reason: 'no_paid' };

  // Idempotency — is a cancel-refund credit for this invoice STILL STANDING?
  // We net SI_CANCEL_REFUND against any SI_REOPEN_CONTRA (written when the
  // invoice was reopened): net > 0 means a live credit already exists → no-op.
  // net ≤ 0 means it was never credited OR was reversed on a prior reopen, so a
  // fresh cancel after reopen correctly credits again. (Wei Siang 2026-06-03)
  const { data: priorRows, error: priorErr } = await sb
    .from('customer_credits')
    .select('amount_centi')
    .eq('source_doc_no', args.siNumber)
    .in('source_type', ['SI_CANCEL_REFUND', 'SI_REOPEN_CONTRA']);
  /* A failed read folded to standing = 0, which reads as "never credited" and
     hands the customer the cancel refund a SECOND time. `standing > 0` is the only
     thing stopping a re-cancel from re-crediting, and a net of 0 from a genuinely
     un-credited (or reversed-on-reopen) invoice is the case that MUST fall
     through — so the emptiness cannot be the signal here, only the error. */
  if (priorErr) {
    /* eslint-disable-next-line no-console */
    console.error('[customer-credit] cancel-refund guard read failed — NOT credited:', args.siNumber, priorErr.message);
    return { credited: 0, reason: 'guard_read_failed' };
  }
  const standing = ((priorRows ?? []) as Array<{ amount_centi: number }>)
    .reduce((s, r) => s + Number(r.amount_centi ?? 0), 0);
  if (standing > 0) {
    return { credited: 0, reason: 'already_credited' };
  }

  /* Audit 2026-06-11 H2 — an over-paid SI already booked its excess as a live
     OVERPAY credit (reconcileSiOverpay, which skips CANCELLED invoices and so
     never corrects it). Crediting the full paid_centi here would hand the
     excess out twice, so the cancel credit is paid − Σ live OVERPAY entries
     for this SI (net, never negative). */
  const { data: overRows, error: overErr } = await sb
    .from('customer_credits')
    .select('amount_centi')
    .eq('source_type', 'OVERPAY')
    .eq('source_doc_no', args.siNumber);
  /* The H2 note above is exactly what a failed read undoes: `?? []` folds to
     liveOverpay = 0, the subtraction becomes a no-op, and the full paid_centi is
     credited — handing out the already-booked excess twice, the precise double
     that this block exists to prevent. An SI with no OVERPAY row resolves
     error === null with data === [] and correctly credits the full paid amount. */
  if (overErr) {
    /* eslint-disable-next-line no-console */
    console.error('[customer-credit] live-overpay read failed — NOT credited:', args.siNumber, overErr.message);
    return { credited: 0, reason: 'overpay_read_failed' };
  }
  const liveOverpay = ((overRows ?? []) as Array<{ amount_centi: number }>)
    .reduce((s, r) => s + Number(r.amount_centi ?? 0), 0);
  const creditCenti = Math.max(0, args.paidCenti - Math.max(0, liveOverpay));
  if (creditCenti <= 0) return { credited: 0, reason: 'covered_by_overpay' };

  // Multi-company (mig 0061): the ledger row inherits the SI's company.
  // Aborts on a read error — an omitted company_id defaults to HOUZS (mig 0091),
  // silently booking another company's credit to Houzs. Nothing written yet.
  const { data: siCo, error: siCoErr } = await sb.from('sales_invoices').select('company_id').eq('id', args.siId).maybeSingle();
  if (siCoErr) {
    /* eslint-disable-next-line no-console */
    console.error('[customer-credit] company read failed — cancel refund NOT credited:', args.siNumber, siCoErr.message);
    return { credited: 0, reason: 'company_read_failed' };
  }
  const companyId = (siCo as { company_id?: number | null } | null)?.company_id ?? null;

  const r = await addCustomerCredit(sb, {
    debtorCode: args.debtorCode,
    debtorName: args.debtorName ?? null,
    amountCenti: creditCenti,
    sourceType: 'SI_CANCEL_REFUND',
    sourceDocNo: args.siNumber,
    sourceDocId: args.siId,
    notes: `Cancelled invoice ${args.siNumber} carried ${creditCenti / 100} as customer credit.`,
    createdBy: args.createdBy ?? null,
    companyId,
  });
  return r.ok ? { credited: creditCenti } : { credited: 0, reason: r.reason };
}

/**
 * Reverse the SI_CANCEL_REFUND credit when a cancelled Sales Invoice is REOPENED.
 * On reopen the invoice goes live again and its payments ledger restores
 * paid_centi — so the credit handed out at cancel must be clawed back, or the
 * customer is credited twice. Writes a NEGATIVE contra row (SI_REOPEN_CONTRA) of
 * the net standing cancel-refund. Idempotent: once net ≤ 0, no-op. (2026-06-03)
 */
export async function reverseCancelledSiCredit(
  sb: any,
  args: { siId: string; siNumber: string; debtorCode: string | null; debtorName: string | null; createdBy?: string | null },
): Promise<{ reversed: number; reason?: string }> {
  if (!args.debtorCode || !args.debtorCode.trim()) return { reversed: 0, reason: 'no_debtor' };
  const { data: rows, error: rowsErr } = await sb
    .from('customer_credits')
    .select('amount_centi')
    .eq('source_doc_no', args.siNumber)
    .in('source_type', ['SI_CANCEL_REFUND', 'SI_REOPEN_CONTRA']);
  /* This one leans the other way and is still wrong: a failed read folds to
     standing = 0, takes the `nothing_to_reverse` branch and reports ok — so the
     reopened invoice goes live again while the customer KEEPS the cancel refund,
     and the company is out that amount with no error anywhere. The outcome of
     aborting is the same (no contra row), but it is now findable instead of
     reported as a clean no-op. */
  if (rowsErr) {
    /* eslint-disable-next-line no-console */
    console.error('[customer-credit] standing-credit read failed — cancel refund NOT clawed back on reopen:', args.siNumber, rowsErr.message);
    return { reversed: 0, reason: 'standing_read_failed' };
  }
  const standing = ((rows ?? []) as Array<{ amount_centi: number }>)
    .reduce((s, r) => s + Number(r.amount_centi ?? 0), 0);
  if (standing <= 0) return { reversed: 0, reason: 'nothing_to_reverse' };

  // Multi-company (mig 0061): the contra row inherits the SI's company.
  // Aborts on a read error — an omitted company_id defaults to HOUZS (mig 0091).
  const { data: siCo, error: siCoErr } = await sb.from('sales_invoices').select('company_id').eq('id', args.siId).maybeSingle();
  if (siCoErr) {
    /* eslint-disable-next-line no-console */
    console.error('[customer-credit] company read failed — contra NOT written:', args.siNumber, siCoErr.message);
    return { reversed: 0, reason: 'company_read_failed' };
  }
  const companyId = (siCo as { company_id?: number | null } | null)?.company_id ?? null;

  const r = await addCustomerCredit(sb, {
    debtorCode: args.debtorCode,
    debtorName: args.debtorName ?? null,
    amountCenti: -standing,
    sourceType: 'SI_REOPEN_CONTRA',
    sourceDocNo: args.siNumber,
    sourceDocId: args.siId,
    notes: `Reopened invoice ${args.siNumber} — cancel-refund credit (${standing / 100}) reversed.`,
    createdBy: args.createdBy ?? null,
    companyId,
  });
  return r.ok ? { reversed: standing } : { reversed: 0, reason: r.reason };
}

/**
 * Record a refund-as-credit when a Sales Order with deposit payments is
 * cancelled. Reads mfg_sales_order_payments to sum what was paid, then writes
 * one positive credit entry (SO_CANCEL_REFUND). Idempotent on
 * (source_type, source_doc_no=docNo) so re-cancel no-ops. Edge #B.
 */
export async function creditFromCancelledSo(
  sb: any,
  args: { docNo: string; debtorCode: string | null; debtorName: string | null; createdBy?: string | null },
): Promise<{ credited: number; reason?: string }> {
  if (!args.debtorCode || !args.debtorCode.trim()) return { credited: 0, reason: 'no_debtor' };

  // Idempotency — already credited?
  /* Same defeat as applyCustomerCreditToSi's guard: a failed read leaves `existing`
     null, falls through, and credits the cancelled SO's deposit to the customer a
     SECOND time. An SO that has genuinely never been credited resolves
     error === null with data === [] and must still fall through. */
  const { data: existing, error: existErr } = await sb
    .from('customer_credits')
    .select('id')
    .eq('source_type', 'SO_CANCEL_REFUND')
    .eq('source_doc_no', args.docNo)
    .limit(1);
  if (existErr) {
    /* eslint-disable-next-line no-console */
    console.error('[customer-credit] SO cancel-refund guard read failed — NOT credited:', args.docNo, existErr.message);
    return { credited: 0, reason: 'guard_read_failed' };
  }
  if (existing && existing.length > 0) {
    return { credited: 0, reason: 'already_credited' };
  }

  // Sum deposits on the SO. The payments table keys on so_doc_no
  // (mfg_sales_order_payments — migration 0073).
  /* A failed read folds to total = 0 and returns 'no_paid' — indistinguishable
     from a deposit-free SO, so a customer who HAS paid a deposit on a cancelled
     order silently gets no credit for it. The outcome of aborting is the same (no
     credit row) but it is reported honestly instead of as "nothing was paid". */
  const { data: pays, error: paysErr } = await sb
    .from('mfg_sales_order_payments')
    .select('amount_centi, company_id')
    .eq('so_doc_no', args.docNo);
  if (paysErr) {
    /* eslint-disable-next-line no-console */
    console.error('[customer-credit] SO deposit read failed — cancel refund NOT credited:', args.docNo, paysErr.message);
    return { credited: 0, reason: 'deposits_read_failed' };
  }
  const payRows = (pays ?? []) as Array<{ amount_centi: number; company_id?: number | null }>;
  const total = payRows.reduce((s, p) => s + Number(p.amount_centi ?? 0), 0);
  if (total <= 0) return { credited: 0, reason: 'no_paid' };
  // Multi-company (mig 0061): the ledger row inherits the SO's company (via its payments).
  const companyId = payRows.find((p) => p.company_id != null)?.company_id ?? null;

  const r = await addCustomerCredit(sb, {
    debtorCode: args.debtorCode,
    debtorName: args.debtorName ?? null,
    amountCenti: total,
    sourceType: 'SO_CANCEL_REFUND',
    sourceDocNo: args.docNo,
    notes: `Cancelled Sales Order ${args.docNo} carried deposit ${total / 100} as customer credit.`,
    createdBy: args.createdBy ?? null,
    companyId,
  });
  return r.ok ? { credited: total } : { credited: 0, reason: r.reason };
}
