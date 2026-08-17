// ----------------------------------------------------------------------------
// acc/settlement — acquirer settlement reconciliation, the part that touches
// the database (brief §3.5 layer 3).
//
// The rule this whole layer exists for: **对账确认的那一刻就产生分录.** 系统3
// reconciled on screen and left the booking "for next phase"; that next phase
// never came, so its card fees never reached the P&L and its bank balance
// could never agree with its books. Here, confirming a match posts through the
// one gate before the row is allowed to call itself confirmed.
//
// TWO EVENTS, TWO ENTRIES (owner, 2026-08-17: "全部卡机都是隔几天收到的。应该
// 是先对卡机报告，然后 match 了就会去 match bank statement"). Reconciling the
// card machine and receiving the money are days apart, so the ledger keeps them
// apart:
//
//   confirm a statement line   Dr Merchant charges  fee   Cr in-transit  fee
//   the payout reaches the bank Dr Bank             net   Cr in-transit  net
//
// Between the two, settlement-in-transit holds the net — which is not a gap in
// the books but the true answer to "how much do the acquirers still owe me":
// the fee is already lost and is no longer receivable, so it leaves first.
//
// Reconciliation IS the emptying of 320-0000. Whatever is left in it is money
// swiped but not yet received — and layer 1's control self-check reads the same
// account, so the two can never tell different stories.
//
// Parsing lives in settlement-parse.ts, matching in settlement-match.ts. Both
// are pure. This file is the only one here that reads or writes.
// ----------------------------------------------------------------------------

import { postJournal } from './engine';
import { resolveRoles, settlementLines, settlementReceiptLines, statementChargeLines } from './rules';
import type { PaymentCandidate } from './settlement-match';

export type AcquirerRow = {
  company_id: number;
  code: string;
  display_name: string;
  transit_account_code: string;
  fee_account_code: string;
  bank_account_code: string | null;
  statement_format: string | null;
  has_unique_ref: boolean | null;
  fee_method: string | null;
  date_tolerance_days: number;
  column_map: Record<string, string> | null;
  /** Row label on which the statement states what it is actually paying. */
  total_net_label?: string | null;
  /** For a statement whose fee is stated once, in its own summary table. */
  summary_totals?: { rowLabel: string; fee?: string; net?: string } | null;
  is_active: boolean;
};

/** One acquirer as this company uses it: global config joined to the company's
    own accounts (the scm.acc_acquirers view built by migration 0301). */
export async function loadAcquirer(
  sb: any,
  companyId: number,
  code: string,
): Promise<{ ok: true; acquirer: AcquirerRow } | { ok: false; reason: string }> {
  const { data, error } = await sb
    .from('acc_acquirers')
    .select('company_id, code, display_name, transit_account_code, fee_account_code, bank_account_code, statement_format, has_unique_ref, fee_method, date_tolerance_days, column_map, total_net_label, summary_totals, is_active')
    .eq('company_id', companyId)
    .eq('code', code)
    .maybeSingle();
  if (error) return { ok: false, reason: error.message };
  if (!data) return { ok: false, reason: `${code} is not set up for this company.` };
  return { ok: true, acquirer: data as AcquirerRow };
}

const isoDay = (v: unknown): string => String(v ?? '').slice(0, 10);

const shiftDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * Every card payment this company recorded for this acquirer in the window —
 * from BOTH sales panels, because the money is one stream even though the ERP
 * records it in two places.
 *
 * The window is widened by the acquirer's own tolerance on each side: a
 * statement line dated the 3rd can legitimately be a swipe from the 1st.
 * `method` is restricted the same way acc/payments.ts books it — merchant and
 * installment are the card methods; cash and transfer never settle through an
 * acquirer, and `imported` is migration-era money AutoCount already owns.
 */
export async function loadPaymentCandidates(
  sb: any,
  companyId: number,
  acquirer: Pick<AcquirerRow, 'display_name' | 'date_tolerance_days'>,
  from: string,
  to: string,
): Promise<{ ok: true; payments: PaymentCandidate[] } | { ok: false; reason: string }> {
  const lo = shiftDays(from, -Math.max(0, acquirer.date_tolerance_days));
  const hi = `${shiftDays(to, Math.max(0, acquirer.date_tolerance_days))}T23:59:59.999`;
  const name = acquirer.display_name.trim();

  const { data: soRaw, error: soErr } = await sb
    .from('mfg_sales_order_payments')
    .select('id, so_doc_no, paid_at, amount_centi, approval_code, method, merchant_provider, collected_by, created_by')
    .eq('company_id', companyId)
    .eq('merchant_provider', name)
    .gte('paid_at', lo)
    .lte('paid_at', hi);
  if (soErr) return { ok: false, reason: `SO payments: ${soErr.message}` };

  const { data: siRaw, error: siErr } = await sb
    .from('sales_invoice_payments')
    .select('id, sales_invoice_id, paid_at, amount_centi, approval_code, method, merchant_provider, collected_by, created_by')
    .eq('company_id', companyId)
    .eq('merchant_provider', name)
    .gte('paid_at', lo)
    .lte('paid_at', hi);
  if (siErr) return { ok: false, reason: `SI payments: ${siErr.message}` };

  const isCard = (m: string) => m === 'merchant' || m === 'installment';
  const payments: PaymentCandidate[] = [];
  for (const r of (soRaw ?? []) as Array<Record<string, any>>) {
    if (!isCard(String(r.method))) continue;
    payments.push({
      source: 'SOPAY',
      id: String(r.id),
      docNo: String(r.so_doc_no ?? ''),
      paidOn: isoDay(r.paid_at),
      amountSen: Number(r.amount_centi ?? 0),
      approvalCode: r.approval_code ?? null,
      customerName: null,
      recordedById: (r.collected_by ?? r.created_by ?? null) as string | null,
    });
  }
  for (const r of (siRaw ?? []) as Array<Record<string, any>>) {
    if (!isCard(String(r.method))) continue;
    payments.push({
      source: 'SIPAY',
      id: String(r.id),
      docNo: String(r.sales_invoice_id ?? ''),
      paidOn: isoDay(r.paid_at),
      amountSen: Number(r.amount_centi ?? 0),
      approvalCode: r.approval_code ?? null,
      customerName: null,
      recordedById: (r.collected_by ?? r.created_by ?? null) as string | null,
    });
  }
  return { ok: true, payments };
}

/** `${source}:${id}` for every payment a settlement line already claimed. The
    read FAILS CLOSED: if it cannot answer, matching must not proceed, because
    an empty answer here would offer already-cleared money as a candidate. */
export async function loadSettledKeys(
  sb: any,
  companyId: number,
): Promise<{ ok: true; keys: Set<string> } | { ok: false; reason: string }> {
  const { data, error } = await sb
    .from('acc_settlement_matches')
    .select('payment_source, payment_id')
    .eq('company_id', companyId);
  if (error) return { ok: false, reason: error.message };
  const keys = new Set<string>();
  for (const r of (data ?? []) as Array<{ payment_source: string; payment_id: string }>) {
    keys.add(`${r.payment_source}:${r.payment_id}`);
  }
  return { ok: true, keys };
}

/**
 * Book the charge a STATEMENT makes that none of its transactions explain.
 *
 * Idempotent through the gate (source SETTLEADJ, keyed on the batch), so
 * confirming a batch repeatedly books it once. A zero adjustment books nothing
 * — the ordinary case, since most acquirers pay exactly what their lines say.
 */
export async function postStatementCharge(
  sb: any,
  companyId: number,
  batchId: number,
): Promise<{ ok: true; status: 'posted' | 'already_posted' | 'nothing_to_post'; jeNo?: string } | { ok: false; status: string; reason: string }> {
  const { data: batchRaw, error } = await sb
    .from('acc_settlement_batches')
    .select('id, acquirer_code, period_to, adjustment_sen, adjustment_je_no')
    .eq('id', batchId).eq('company_id', companyId).maybeSingle();
  if (error) return { ok: false, status: 'load_failed', reason: error.message };
  if (!batchRaw) return { ok: false, status: 'not_found', reason: `batch ${batchId} not found` };
  const batch = batchRaw as { acquirer_code: string; period_to: string | null; adjustment_sen: number | null; adjustment_je_no: string | null };

  const adjustment = Number(batch.adjustment_sen ?? 0);
  if (adjustment === 0) return { ok: true, status: 'nothing_to_post' };
  if (batch.adjustment_je_no) return { ok: true, status: 'already_posted', jeNo: batch.adjustment_je_no };

  const acq = await loadAcquirer(sb, companyId, batch.acquirer_code);
  if (!acq.ok) return { ok: false, status: 'acquirer_unavailable', reason: acq.reason };

  const posted = await postJournal(sb, {
    companyId,
    /* Dated by the statement, because the statement is the document that makes
       the charge (§2.5: the document's own date, not today's). It is not dated
       by a payout — the payout is a separate event this batch may not have had
       yet, and the charge is real the moment the acquirer states it. */
    entryDate: isoDay(batch.period_to) || isoDay(new Date().toISOString()),
    sourceType: 'SETTLEADJ',
    sourceDocNo: `SETTLEADJ-${batchId}`,
    narration: `${batch.acquirer_code} statement charge with no transaction behind it — ${(Math.abs(adjustment) / 100).toFixed(2)}`,
    lines: statementChargeLines(
      { transitAccountCode: acq.acquirer.transit_account_code, feeAccountCode: acq.acquirer.fee_account_code },
      { acquirerCode: batch.acquirer_code, statementDate: isoDay(batch.period_to), adjustmentSen: adjustment },
    ),
  });
  if (!posted.ok) return { ok: false, status: posted.status, reason: posted.reason ?? 'the posting gate refused the entry' };

  const { error: upErr } = await sb.from('acc_settlement_batches').update({
    adjustment_je_no: posted.jeNo,
    adjustment_je_id: posted.jeId,
    adjustment_posted_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', batchId);
  if (upErr) {
    return { ok: false, status: 'stamp_failed', reason: `${upErr.message} (entry ${posted.jeNo} DID post — try again to finish stamping the batch)` };
  }
  return { ok: true, status: posted.status === 'already_posted' ? 'already_posted' : 'posted', jeNo: posted.jeNo };
}

export type ConfirmInput = {
  companyId: number;
  rowId: number;
  /** The payments this settlement line covers. One line may cover several. */
  payments: Array<{ source: 'SOPAY' | 'SIPAY'; id: string; docNo: string | null; amountSen: number }>;
  matchReason: 'ref' | 'amount+date' | 'manual';
  userName: string | null;
};

export type ConfirmResult =
  | { ok: true; status: 'confirmed' | 'already_confirmed'; jeNo?: string }
  | { ok: false; status: string; reason: string };

/**
 * Confirm ONE settlement line: link the payments it covers, post the entry,
 * and only then mark the row confirmed.
 *
 * Order matters. The links go in first, because their UNIQUE index
 * (acc_settlement_payment_once) is the database's own refusal to settle the
 * same payment twice — discovering that AFTER posting would leave a journal
 * entry for money another line already cleared. The row is stamped last, so a
 * failure anywhere leaves it unconfirmed and retryable rather than "confirmed"
 * with nothing in the ledger, which is precisely 系统3's failure.
 */
export async function confirmSettlementRow(sb: any, input: ConfirmInput): Promise<ConfirmResult> {
  const { companyId, rowId } = input;

  const { data: rowRaw, error: rowErr } = await sb
    .from('acc_settlement_rows')
    .select('id, batch_id, company_id, acquirer_code, txn_date, ref, gross_sen, fee_sen, net_sen, bucket, confirmed_at, posted_je_no')
    .eq('id', rowId)
    .eq('company_id', companyId)
    .maybeSingle();
  if (rowErr) return { ok: false, status: 'load_failed', reason: rowErr.message };
  if (!rowRaw) return { ok: false, status: 'not_found', reason: `settlement line ${rowId} not found` };
  const row = rowRaw as {
    id: number; batch_id: number; acquirer_code: string; txn_date: string; ref: string | null;
    gross_sen: number; fee_sen: number; net_sen: number; bucket: string;
    confirmed_at: string | null; posted_je_no: string | null;
  };
  if (row.confirmed_at) {
    return { ok: true, status: 'already_confirmed', ...(row.posted_je_no ? { jeNo: row.posted_je_no } : {}) };
  }
  if (row.bucket === 'IGNORED') {
    return { ok: false, status: 'ignored', reason: 'This line was set aside. Put it back in the list before confirming it.' };
  }

  const chosen = input.payments ?? [];
  if (chosen.length === 0) {
    return {
      ok: false,
      status: 'no_payments',
      reason: 'Nothing to confirm: this settlement has no matching payment in the ERP. Record the sale first — money that arrived without a sale behind it must not be cleared out of the in-transit account.',
    };
  }
  /* The sum must be the gross, to the sen. A difference here IS the thing this
     layer exists to catch, so it is named and refused, never absorbed. */
  const chosenTotal = chosen.reduce((s, p) => s + Number(p.amountSen || 0), 0);
  if (chosenTotal !== Number(row.gross_sen)) {
    const diff = (chosenTotal - Number(row.gross_sen)) / 100;
    return {
      ok: false,
      status: 'amount_mismatch',
      reason: `The selected payments add up to ${(chosenTotal / 100).toFixed(2)}, but the statement line is ${(Number(row.gross_sen) / 100).toFixed(2)} — a difference of ${diff.toFixed(2)}. Fix the selection, or correct the payment record; do not clear a difference you cannot explain.`,
    };
  }

  const acq = await loadAcquirer(sb, companyId, row.acquirer_code);
  if (!acq.ok) return { ok: false, status: 'acquirer_unavailable', reason: acq.reason };

  /* A previous attempt may have linked and posted but failed on the final
     stamp. Resuming must not read its own links as "someone else already
     settled this money" — so the links are written only if this row has none. */
  const { data: existingLinks, error: exErr } = await sb
    .from('acc_settlement_matches')
    .select('id')
    .eq('settlement_row_id', row.id);
  if (exErr) return { ok: false, status: 'link_read_failed', reason: exErr.message };

  const links = chosen.map((p) => ({
    settlement_row_id: row.id,
    company_id: companyId,
    payment_source: p.source,
    payment_id: p.id,
    doc_no: p.docNo ?? null,
    amount_sen: Number(p.amountSen || 0),
  }));
  const { error: linkErr } = ((existingLinks ?? []) as unknown[]).length > 0
    ? { error: null }
    : await sb.from('acc_settlement_matches').insert(links);
  if (linkErr) {
    const twice = String(linkErr.code ?? '') === '23505' || /duplicate key/i.test(String(linkErr.message ?? ''));
    return {
      ok: false,
      status: twice ? 'payment_already_settled' : 'link_failed',
      reason: twice
        ? 'One of these payments has already been cleared by another settlement line. Refresh the list — the same money cannot arrive twice.'
        : linkErr.message,
    };
  }

  /* Confirming books the FEE and nothing else, dated by the transaction (§2.5).
     No bank leg: the money is still with the acquirer on this day, and saying
     otherwise in the ledger would be a lie the bank statement then contradicts.
     A fee-free line — some instalment plans, most refunds — books nothing at
     all, and that is right: nothing has been lost yet, the whole gross is still
     owed, and the payout entry will clear it. */
  const feeSen = Number(row.fee_sen);
  const posted = feeSen === 0
    ? { ok: true as const, status: 'nothing_to_post', jeNo: null as string | null, jeId: null as string | null }
    : await postJournal(sb, {
      companyId,
      entryDate: isoDay(row.txn_date),
      sourceType: 'SETTLE',
      sourceDocNo: `SETTLE-${row.id}`,
      narration: `${row.acquirer_code} settlement ${isoDay(row.txn_date)}${row.ref ? ` ref ${row.ref}` : ''} — ${chosen.map((p) => p.docNo).filter(Boolean).join(', ') || 'card payments'}`,
      lines: settlementLines(
        {
          feeAccountCode: acq.acquirer.fee_account_code,
          transitAccountCode: acq.acquirer.transit_account_code,
        },
        {
          acquirerCode: row.acquirer_code,
          txnDate: isoDay(row.txn_date),
          ref: row.ref,
          feeSen,
        },
      ),
    });
  if (!posted.ok) {
    /* The entry did not post, so the links must not survive — otherwise the
       payments are marked settled with nothing in the ledger behind them. */
    await sb.from('acc_settlement_matches').delete().eq('settlement_row_id', row.id);
    return { ok: false, status: posted.status, reason: posted.reason ?? 'the entry was refused by the posting gate' };
  }

  const { error: upErr } = await sb
    .from('acc_settlement_rows')
    .update({
      bucket: 'MATCHED',
      match_reason: input.matchReason,
      confirmed_at: new Date().toISOString(),
      confirmed_by: input.userName ?? null,
      posted_je_no: posted.jeNo ?? null,
      posted_je_id: posted.jeId ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', row.id);
  if (upErr) {
    /* The ledger is right and the links are right; only the row's stamp failed.
       Say so loudly — a retry is a no-op through the gate's idempotency. */
    return { ok: false, status: 'stamp_failed', reason: `${upErr.message} (the entry ${posted.jeNo ?? '(none — no fee to book)'} DID post — press confirm again to finish stamping the line)` };
  }
  return { ok: true, status: 'confirmed', ...(posted.jeNo ? { jeNo: posted.jeNo } : {}) };
}

/**
 * THE MONEY ARRIVED. Book one payout against the bank.
 *
 * This is the second half of the owner's two-step: the card machine was
 * reconciled days ago; today the bank statement (or the acquirer's payment
 * advice) shows the credit, and only now does the ledger move it out of
 * settlement-in-transit and into the bank.
 *
 * The amount is what the STATEMENT SAID IT WOULD PAY — stated_net_sen when the
 * acquirer prints a payable total, otherwise the sum of its own lines. It is
 * not re-derived from what has been confirmed so far, because a payout is not
 * partial: the acquirer pays the batch, and if the bank credit disagrees with
 * this number the difference is a real problem for a human to look at, not
 * something to quietly absorb.
 *
 * Idempotent through the gate (source SETTLEBANK, keyed on the batch), so
 * pressing it twice books once. Layer 4 will call this with the date it reads
 * off the bank statement; until then the operator types it.
 */
export async function postBatchReceipt(
  sb: any,
  companyId: number,
  batchId: number,
  receivedOn: string,
): Promise<{ ok: true; status: 'posted' | 'already_posted'; jeNo?: string; amountSen: number } | { ok: false; status: string; reason: string }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(receivedOn ?? ''))) {
    return { ok: false, status: 'bad_date', reason: 'Give the date the money reached the bank, as it reads on the bank statement (YYYY-MM-DD).' };
  }

  const { data: batchRaw, error } = await sb
    .from('acc_settlement_batches')
    .select('id, acquirer_code, period_to, net_sen, stated_net_sen, received_on, receipt_je_no')
    .eq('id', batchId).eq('company_id', companyId).maybeSingle();
  if (error) return { ok: false, status: 'load_failed', reason: error.message };
  if (!batchRaw) return { ok: false, status: 'not_found', reason: `batch ${batchId} not found` };
  const batch = batchRaw as {
    acquirer_code: string; period_to: string | null;
    net_sen: number | null; stated_net_sen: number | null;
    received_on: string | null; receipt_je_no: string | null;
  };

  const amountSen = Number(batch.stated_net_sen ?? batch.net_sen ?? 0);
  if (amountSen === 0) {
    return { ok: false, status: 'nothing_to_receive', reason: 'This statement pays nothing — there is no receipt to book.' };
  }
  if (batch.receipt_je_no) {
    return { ok: true, status: 'already_posted', jeNo: batch.receipt_je_no, amountSen };
  }

  const acq = await loadAcquirer(sb, companyId, batch.acquirer_code);
  if (!acq.ok) return { ok: false, status: 'acquirer_unavailable', reason: acq.reason };

  /* Which bank the payout lands in is 决定4 information. Until the owner
     supplies it the company's default bank carries it — and says so, every
     time, rather than silently choosing. */
  const roles = await resolveRoles(sb, companyId);
  let bankAccount = acq.acquirer.bank_account_code;
  if (!bankAccount) {
    bankAccount = roles.BANK_DEFAULT;
    /* eslint-disable-next-line no-console */
    console.error(`[acc/settlement] ${batch.acquirer_code} has no receiving bank account configured — payout booked to ${bankAccount}; fill in the acquirer setup (决定4)`);
  }

  const posted = await postJournal(sb, {
    companyId,
    /* The bank's date, never the statement's: this entry exists because the
       bank says the money is there on this day. */
    entryDate: receivedOn,
    sourceType: 'SETTLEBANK',
    sourceDocNo: `SETTLEBANK-${batchId}`,
    narration: `${batch.acquirer_code} payout received ${receivedOn} — ${(Math.abs(amountSen) / 100).toFixed(2)}`,
    lines: settlementReceiptLines(
      { bankAccountCode: bankAccount, transitAccountCode: acq.acquirer.transit_account_code },
      { acquirerCode: batch.acquirer_code, receivedOn, amountSen },
    ),
  });
  if (!posted.ok) return { ok: false, status: posted.status, reason: posted.reason ?? 'the posting gate refused the entry' };

  const { error: upErr } = await sb.from('acc_settlement_batches').update({
    received_on: receivedOn,
    receipt_je_no: posted.jeNo,
    receipt_je_id: posted.jeId,
    receipt_posted_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', batchId);
  if (upErr) {
    return { ok: false, status: 'stamp_failed', reason: `${upErr.message} (entry ${posted.jeNo} DID post — try again to finish stamping the batch)` };
  }
  return { ok: true, status: posted.status === 'already_posted' ? 'already_posted' : 'posted', jeNo: posted.jeNo, amountSen };
}
