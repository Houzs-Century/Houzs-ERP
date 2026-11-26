
import { isMissingRpc } from './rpc-missing';
import { fmtSen } from '../shared/format';
import { readOrderDeposit } from './si-order-deposit';

export type CreditSourceType =
  | 'SI_CANCEL_REFUND'
  | 'SI_REOPEN_CONTRA'
  | 'SO_CANCEL_REFUND'
  | 'SO_REOPEN_CONTRA'
  | 'OVERPAY'
  | 'APPLIED_TO_SI'
  | 'MANUAL_ADJUST'
  | 'CUSTOMER_REFUND'
  | 'CUSTOMER_REFUND_REVERSAL';

export type AddCreditInput = {
  debtorCode: string;
  debtorName?: string | null;
  amountSen: number;
  sourceType: CreditSourceType;
  sourceDocNo?: string | null;
  sourceDocId?: string | null;
  notes?: string | null;
  createdBy?: string | null;
  companyId: number | null;
};

/** Insert one ledger row. Idempotency note: callers that need it (cancel /
 *  apply) check existence first via the (sourceType, sourceDocNo) pair before
 *  calling addCustomerCredit. */
export async function addCustomerCredit(sb: any, args: AddCreditInput): Promise<{ ok: boolean; id?: string; reason?: string }> {
  if (!args.debtorCode || !args.debtorCode.trim()) return { ok: false, reason: 'debtor_code_required' };
  if (!Number.isFinite(args.amountSen) || args.amountSen === 0) return { ok: false, reason: 'amount_zero' };
  const { data, error } = await sb.from('customer_credits').insert({
    ...(args.companyId != null ? { company_id: args.companyId } : {}),
    debtor_code:   args.debtorCode,
    debtor_name:   args.debtorName ?? null,
    amount_sen:  Math.round(args.amountSen),
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
    .select('amount_sen')
    .eq('debtor_code', debtorCode);
  if (companyId != null) q = q.eq('company_id', companyId);
  const { data, error } = await q;
  if (error) throw new Error(`getCustomerCreditBalance read failed: ${error.message}`);
  let sum = 0;
  for (const r of (data ?? []) as Array<{ amount_sen: number }>) sum += Number(r.amount_sen ?? 0);
  return sum;
}

type ApplyCreditArgs = {
  debtorCode: string;
  debtorName?: string | null;
  siId: string;
  siNumber: string;
  remainingDueSen: number;
  createdBy?: string | null;
};


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
 * path, so behaviour is unchanged pre-apply. paid_sen is not touched here: it
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
  if (!(args.remainingDueSen > 0)) return { applied: 0, reason: 'no_due' };

  const { data: siRow, error: siErr } = await sb
    .from('sales_invoices')
    .select('migrated_no_stock, so_doc_no, company_id')
    .eq('id', args.siId)
    .maybeSingle();
  if (siErr) return { applied: 0, reason: `migrated_check_failed: ${siErr.message}` };
  const si = siRow as { migrated_no_stock?: boolean | null; so_doc_no?: string | null; company_id?: number | null } | null;
  if (si?.migrated_no_stock === true) {
    return { applied: 0, reason: 'migrated_source' };
  }

  let dueSen = args.remainingDueSen;
  if (si?.so_doc_no) {
    const dep = await readOrderDeposit(sb, si.so_doc_no, si.company_id ?? null);
    if (!dep.ok) return { applied: 0, reason: `order_money_read_failed: ${dep.reason}` };
    if (!dep.credits) return { applied: 0, reason: 'order_money_read_failed: credit notes' };
    dueSen -= (dep.slices.get(args.siId) ?? 0) + (dep.credits.get(args.siId) ?? 0);
    if (!(dueSen > 0)) return { applied: 0, reason: 'settled_by_order' };
  }

  const { data, error } = await sb.rpc('apply_customer_credit_to_si', {
    p_debtor_code: args.debtorCode,
    p_si_id: args.siId,
    p_si_number: args.siNumber,
    p_remaining_due_sen: Math.round(dueSen),
    p_debtor_name: args.debtorName ?? null,
    p_created_by: args.createdBy ?? null,
  });
  if (!error) {
    const row = (Array.isArray(data) ? data[0] : data) as { applied_sen?: number; reason?: string } | undefined;
    const applied = Number(row?.applied_sen ?? 0);
    return applied > 0 ? { applied } : { applied: 0, reason: row?.reason ?? 'no_apply' };
  }
  if (!isMissingRpc(error)) {
    /* eslint-disable-next-line no-console */
    console.error('[customer-credit] atomic apply RPC failed — credit NOT applied:', args.siNumber, error.message);
    return { applied: 0, reason: error.message };
  }

  return applyCustomerCreditToSiLegacy(sb, { ...args, remainingDueSen: dueSen });
}

async function applyCustomerCreditToSiLegacy(
  sb: any,
  args: ApplyCreditArgs,
): Promise<{ applied: number; reason?: string }> {
  const { data: existing, error: existErr } = await sb
    .from('sales_invoice_payments')
    .select('id, amount_sen')
    .eq('sales_invoice_id', args.siId)
    .eq('method', 'credit')
    .limit(1);
  if (existErr) {
    /* eslint-disable-next-line no-console */
    console.error('[customer-credit] idempotency read failed — credit NOT applied:', args.siNumber, existErr.message);
    return { applied: 0, reason: 'guard_read_failed' };
  }
  if (existing && existing.length > 0) {
    return { applied: 0, reason: 'already_applied' };
  }

  const { data: siCo, error: siCoErr } = await sb.from('sales_invoices').select('company_id').eq('id', args.siId).maybeSingle();
  if (siCoErr) {
    /* eslint-disable-next-line no-console */
    console.error('[customer-credit] company read failed — credit NOT applied:', args.siNumber, siCoErr.message);
    return { applied: 0, reason: 'company_read_failed' };
  }
  const companyId = (siCo as { company_id?: number | null } | null)?.company_id ?? null;

  const balance = await getCustomerCreditBalance(sb, args.debtorCode, companyId);
  if (balance <= 0) return { applied: 0, reason: 'no_balance' };
  const apply = Math.min(balance, args.remainingDueSen);
  if (apply <= 0) return { applied: 0, reason: 'no_due' };

  const { error: payErr } = await sb.from('sales_invoice_payments').insert({
    ...(companyId != null ? { company_id: companyId } : {}),
    sales_invoice_id: args.siId,
    method: 'credit',
    amount_sen: apply,
    note: `Applied customer credit balance toward ${args.siNumber}`,
    created_by: args.createdBy ?? null,
  });
  if (payErr) return { applied: 0, reason: payErr.message };

  const ledger = await addCustomerCredit(sb, {
    debtorCode: args.debtorCode,
    debtorName: args.debtorName ?? null,
    amountSen: -apply,
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

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const { data: cur } = await sb.from('sales_invoices').select('paid_sen').eq('id', args.siId).maybeSingle();
    const prev = Number((cur as { paid_sen: number } | null)?.paid_sen ?? 0);
    const { data: upd } = await sb.from('sales_invoices')
      .update({ paid_sen: prev + apply })
      .eq('id', args.siId)
      .eq('paid_sen', prev)
      .select('id');
    if (upd && upd.length > 0) break;
  }

  return { applied: apply };
}

/**
 * Reconcile the OVERPAY ledger entry for one Sales Invoice. After any change
 * to paid_sen (payment add / delete), the customer's credit balance must
 * match (paid_sen − total_sen) clamped at zero. Edge #A.
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
    .select('invoice_number, total_sen, paid_sen, debtor_code, debtor_name, status, company_id')
    .eq('id', siId)
    .maybeSingle();
  if (siErr) {
    /* eslint-disable-next-line no-console */
    console.error('[customer-credit] overpay header read failed — overpay NOT reconciled:', siId, siErr.message);
    return { delta: 0, reason: 'header_read_failed' };
  }
  if (!si) return { delta: 0, reason: 'not_found' };
  const s = si as { invoice_number: string; total_sen: number | null; paid_sen: number | null; debtor_code: string | null; debtor_name: string | null; status: string | null; company_id: number | null };
  if (!s.debtor_code) return { delta: 0, reason: 'no_debtor' };
  if ((s.status ?? '').toUpperCase() === 'CANCELLED') return { delta: 0, reason: 'cancelled' };

  const paid  = Number(s.paid_sen ?? 0);
  const total = Number(s.total_sen ?? 0);
  const target = Math.max(0, paid - total);

  const { data: existing, error: existErr } = await sb
    .from('customer_credits')
    .select('amount_sen')
    .eq('source_type', 'OVERPAY')
    .eq('source_doc_no', s.invoice_number);
  if (existErr) {
    /* eslint-disable-next-line no-console */
    console.error('[customer-credit] overpay Σ read failed — overpay NOT reconciled:', s.invoice_number, existErr.message);
    return { delta: 0, reason: 'existing_read_failed' };
  }
  const existingTotal = ((existing ?? []) as Array<{ amount_sen: number }>)
    .reduce((acc, r) => acc + Number(r.amount_sen ?? 0), 0);

  const delta = target - existingTotal;
  if (delta === 0) return { delta: 0 };

  const r = await addCustomerCredit(sb, {
    debtorCode: s.debtor_code,
    debtorName: s.debtor_name,
    amountSen: delta,
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
 * paid_sen > 0 → writes a positive credit row for the customer (idempotent
 * on source_doc_no, so a second cancel-PATCH no-ops).
 */
export async function creditFromCancelledSi(
  sb: any,
  args: { siId: string; siNumber: string; debtorCode: string | null; debtorName: string | null; paidSen: number; createdBy?: string | null },
): Promise<{ credited: number; reason?: string }> {
  if (!args.debtorCode || !args.debtorCode.trim()) return { credited: 0, reason: 'no_debtor' };
  if (!(args.paidSen > 0)) return { credited: 0, reason: 'no_paid' };

  const { data: priorRows, error: priorErr } = await sb
    .from('customer_credits')
    .select('amount_sen')
    .eq('source_doc_no', args.siNumber)
    .in('source_type', ['SI_CANCEL_REFUND', 'SI_REOPEN_CONTRA']);
  if (priorErr) {
    /* eslint-disable-next-line no-console */
    console.error('[customer-credit] cancel-refund guard read failed — NOT credited:', args.siNumber, priorErr.message);
    return { credited: 0, reason: 'guard_read_failed' };
  }
  const standing = ((priorRows ?? []) as Array<{ amount_sen: number }>)
    .reduce((s, r) => s + Number(r.amount_sen ?? 0), 0);
  if (standing > 0) {
    return { credited: 0, reason: 'already_credited' };
  }

  const { data: overRows, error: overErr } = await sb
    .from('customer_credits')
    .select('amount_sen')
    .eq('source_type', 'OVERPAY')
    .eq('source_doc_no', args.siNumber);
  if (overErr) {
    /* eslint-disable-next-line no-console */
    console.error('[customer-credit] live-overpay read failed — NOT credited:', args.siNumber, overErr.message);
    return { credited: 0, reason: 'overpay_read_failed' };
  }
  const liveOverpay = ((overRows ?? []) as Array<{ amount_sen: number }>)
    .reduce((s, r) => s + Number(r.amount_sen ?? 0), 0);
  const creditSen = Math.max(0, args.paidSen - Math.max(0, liveOverpay));
  if (creditSen <= 0) return { credited: 0, reason: 'covered_by_overpay' };

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
    amountSen: creditSen,
    sourceType: 'SI_CANCEL_REFUND',
    sourceDocNo: args.siNumber,
    sourceDocId: args.siId,
    notes: `Cancelled invoice ${args.siNumber} carried ${fmtSen(creditSen)} as customer credit.`,
    createdBy: args.createdBy ?? null,
    companyId,
  });
  return r.ok ? { credited: creditSen } : { credited: 0, reason: r.reason };
}

/**
 * Reverse the SI_CANCEL_REFUND credit when a cancelled Sales Invoice is REOPENED.
 * On reopen the invoice goes live again and its payments ledger restores
 * paid_sen — so the credit handed out at cancel must be clawed back, or the
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
    .select('amount_sen')
    .eq('source_doc_no', args.siNumber)
    .in('source_type', ['SI_CANCEL_REFUND', 'SI_REOPEN_CONTRA']);
  if (rowsErr) {
    /* eslint-disable-next-line no-console */
    console.error('[customer-credit] standing-credit read failed — cancel refund NOT clawed back on reopen:', args.siNumber, rowsErr.message);
    return { reversed: 0, reason: 'standing_read_failed' };
  }
  const standing = ((rows ?? []) as Array<{ amount_sen: number }>)
    .reduce((s, r) => s + Number(r.amount_sen ?? 0), 0);
  if (standing <= 0) return { reversed: 0, reason: 'nothing_to_reverse' };

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
    amountSen: -standing,
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

  const { data: existing, error: existErr } = await sb
    .from('customer_credits')
    .select('amount_sen')
    .eq('source_doc_no', args.docNo)
    .in('source_type', ['SO_CANCEL_REFUND', 'SO_REOPEN_CONTRA']);
  if (existErr) {
    /* eslint-disable-next-line no-console */
    console.error('[customer-credit] SO cancel-refund guard read failed — NOT credited:', args.docNo, existErr.message);
    return { credited: 0, reason: 'guard_read_failed' };
  }
  const standingCredit = ((existing ?? []) as Array<{ amount_sen: number }>)
    .reduce((s, r) => s + Number(r.amount_sen ?? 0), 0);
  if (standingCredit > 0) {
    return { credited: 0, reason: 'already_credited' };
  }

  const { data: pays, error: paysErr } = await sb
    .from('mfg_sales_order_payments')
    .select('amount_sen, company_id')
    .eq('so_doc_no', args.docNo);
  if (paysErr) {
    /* eslint-disable-next-line no-console */
    console.error('[customer-credit] SO deposit read failed — cancel refund NOT credited:', args.docNo, paysErr.message);
    return { credited: 0, reason: 'deposits_read_failed' };
  }
  const payRows = (pays ?? []) as Array<{ amount_sen: number; company_id?: number | null }>;
  const total = payRows.reduce((s, p) => s + Number(p.amount_sen ?? 0), 0);
  if (total <= 0) return { credited: 0, reason: 'no_paid' };
  const companyId = payRows.find((p) => p.company_id != null)?.company_id ?? null;

  const r = await addCustomerCredit(sb, {
    debtorCode: args.debtorCode,
    debtorName: args.debtorName ?? null,
    amountSen: total,
    sourceType: 'SO_CANCEL_REFUND',
    sourceDocNo: args.docNo,
    notes: `Cancelled Sales Order ${args.docNo} carried deposit ${total / 100} as customer credit.`,
    createdBy: args.createdBy ?? null,
    companyId,
  });
  return r.ok ? { credited: total } : { credited: 0, reason: r.reason };
}

/**
 * Reverse the SO_CANCEL_REFUND credit when a cancelled Sales Order is REOPENED.
 * On reopen the order goes live again and its deposit payments count against it
 * once more — so the credit handed out at cancel must be clawed back, or the
 * customer's money is counted twice. Writes a NEGATIVE contra row
 * (SO_REOPEN_CONTRA) of the net standing cancel-refund. Idempotent: once
 * net ≤ 0 (never credited, or already reversed) it is a no-op. Mirrors
 * reverseCancelledSiCredit on the invoice side.
 */
export async function reverseCancelledSoCredit(
  sb: any,
  args: { docNo: string; debtorCode: string | null; debtorName: string | null; createdBy?: string | null },
): Promise<{ reversed: number; reason?: string }> {
  if (!args.debtorCode || !args.debtorCode.trim()) return { reversed: 0, reason: 'no_debtor' };
  const { data: rows, error: rowsErr } = await sb
    .from('customer_credits')
    .select('amount_sen, company_id')
    .eq('source_doc_no', args.docNo)
    .in('source_type', ['SO_CANCEL_REFUND', 'SO_REOPEN_CONTRA']);
  if (rowsErr) {
    /* eslint-disable-next-line no-console */
    console.error('[customer-credit] standing-credit read failed — SO cancel refund NOT clawed back on reopen:', args.docNo, rowsErr.message);
    return { reversed: 0, reason: 'standing_read_failed' };
  }
  const creditRows = (rows ?? []) as Array<{ amount_sen: number; company_id?: number | null }>;
  const standing = creditRows.reduce((s, r) => s + Number(r.amount_sen ?? 0), 0);
  if (standing <= 0) return { reversed: 0, reason: 'nothing_to_reverse' };

  const companyId = creditRows.find((r) => r.company_id != null)?.company_id ?? null;

  const r = await addCustomerCredit(sb, {
    debtorCode: args.debtorCode,
    debtorName: args.debtorName ?? null,
    amountSen: -standing,
    sourceType: 'SO_REOPEN_CONTRA',
    sourceDocNo: args.docNo,
    notes: `Reopened Sales Order ${args.docNo} — cancel-refund credit (${standing / 100}) reversed.`,
    createdBy: args.createdBy ?? null,
    companyId,
  });
  return r.ok ? { reversed: standing } : { reversed: 0, reason: r.reason };
}
