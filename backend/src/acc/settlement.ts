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

import { postJournal, reverseJournal } from './engine';
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
    own accounts (the scm.acc_acquirers view built by migration 0332). */
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
 * Whether a recorded payment may belong to THIS acquirer's statement.
 *
 * Three kinds of yes:
 *   • a card payment (merchant / installment) TAGGED with this acquirer;
 *   • a card payment tagged with NOTHING — the salesperson skipped the field;
 *   • an `imported` payment with no tag. Migration-era rows all look like this:
 *     AutoCount recorded the sale, but the PAYOUT lands in this system's bank,
 *     so the statement must still be able to find them (the owner's first real
 *     uploads, 2026-09: four MBB lines all UNMATCHED while their sales sat in
 *     mfg_sales_order_payments with method 'imported' and provider NULL).
 *
 * A payment tagged with a DIFFERENT acquirer is never a candidate — that is
 * somebody else's stream — and cash/transfer never settle through one. An
 * untagged candidate is a QUESTION, not an answer: the matcher only ever
 * auto-takes on a unique reference, everything else waits for a human, and
 * confirming stamps the tag on (see confirmSettlementRow).
 */
export function couldBeAcquirers(method: string, provider: string | null | undefined, acquirerName: string): boolean {
  const p = provider == null ? '' : String(provider).trim();
  if (p !== '' && p !== acquirerName) return false;
  if (method === 'merchant' || method === 'installment') return true;
  return method === 'imported';
}

/**
 * Every card payment this company recorded that could belong to this acquirer
 * in the window — from BOTH sales panels, because the money is one stream even
 * though the ERP records it in two places.
 *
 * The window is widened by the acquirer's own tolerance on each side: a
 * statement line dated the 3rd can legitimately be a swipe from the 1st.
 * Which payments qualify is couldBeAcquirers' one job, above.
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

  /* The window is read WHOLE and filtered here, not by `.eq('merchant_provider',
     name)` in the query — that filter was how a NULL-tagged payment could never
     be found, however exactly its amount and date agreed with the statement. */
  const { data: soAll, error: soErr } = await sb
    .from('mfg_sales_order_payments')
    .select('id, so_doc_no, paid_at, amount_sen, approval_code, method, merchant_provider, collected_by, created_by')
    .eq('company_id', companyId)
    .gte('paid_at', lo)
    .lte('paid_at', hi);
  if (soErr) return { ok: false, reason: `SO payments: ${soErr.message}` };
  const soRaw = ((soAll ?? []) as Array<Record<string, any>>)
    .filter((r) => couldBeAcquirers(String(r.method), r.merchant_provider as string | null, name));

  const { data: siAll, error: siErr } = await sb
    .from('sales_invoice_payments')
    .select('id, sales_invoice_id, paid_at, amount_sen, approval_code, method, merchant_provider, collected_by, created_by')
    .eq('company_id', companyId)
    .gte('paid_at', lo)
    .lte('paid_at', hi);
  if (siErr) return { ok: false, reason: `SI payments: ${siErr.message}` };
  const siRaw = ((siAll ?? []) as Array<Record<string, any>>)
    .filter((r) => couldBeAcquirers(String(r.method), r.merchant_provider as string | null, name));

  /* WHOSE sale it was. The operator is reconciling money against documents,
     and a document number alone does not tell him which customer he is looking
     at (owner, 2026-08-18: 我希望他是显示 transaction detail 和 sales order
     detail, 而不是 document 罢了). Two reads for the whole window, not one per
     line, and a name that cannot be resolved stays null rather than guessed. */
  const soDocs = [...new Set(soRaw.map((r) => String(r.so_doc_no ?? '')).filter(Boolean))];
  const siIds = [...new Set(siRaw.map((r) => String(r.sales_invoice_id ?? '')).filter(Boolean))];
  const customerOf = new Map<string, string>();
  if (soDocs.length > 0) {
    const { data, error } = await sb.from('mfg_sales_orders')
      .select('doc_no, customer_name').eq('company_id', companyId).in('doc_no', soDocs);
    /* Failed is not "nameless": a blank customer column across the whole
       screen reads as data, so the read fails like its siblings above. */
    if (error) return { ok: false, reason: `SO customers: ${error.message}` };
    for (const r of (data ?? []) as Array<{ doc_no: string; customer_name: string | null }>) {
      if (r.customer_name) customerOf.set(`SO:${r.doc_no}`, r.customer_name);
    }
  }
  if (siIds.length > 0) {
    const { data, error } = await sb.from('sales_invoices')
      .select('id, invoice_number, debtor_name').eq('company_id', companyId).in('id', siIds);
    if (error) return { ok: false, reason: `SI customers: ${error.message}` };
    for (const r of (data ?? []) as Array<{ id: string; invoice_number: string | null; debtor_name: string | null }>) {
      if (r.debtor_name) customerOf.set(`SI:${r.id}`, r.debtor_name);
      if (r.invoice_number) customerOf.set(`SI#:${r.id}`, r.invoice_number);
    }
  }

  /* An empty tag reaches the screen as NULL either way — the marker the
     operator sees ("未标 merchant") keys off it. */
  const tagOf = (r: Record<string, any>): string | null => {
    const p = r.merchant_provider == null ? '' : String(r.merchant_provider).trim();
    return p === '' ? null : p;
  };
  const payments: PaymentCandidate[] = [];
  for (const r of soRaw) {
    payments.push({
      source: 'SOPAY',
      id: String(r.id),
      docNo: String(r.so_doc_no ?? ''),
      paidOn: isoDay(r.paid_at),
      amountSen: Number(r.amount_sen ?? 0),
      approvalCode: r.approval_code ?? null,
      customerName: customerOf.get(`SO:${String(r.so_doc_no ?? '')}`) ?? null,
      recordedById: (r.collected_by ?? r.created_by ?? null) as string | null,
      merchantProvider: tagOf(r),
    });
  }
  for (const r of siRaw) {
    payments.push({
      source: 'SIPAY',
      id: String(r.id),
      /* The invoice NUMBER when it can be resolved — the id is a uuid, and a
         uuid on screen is not a document reference to anybody. */
      docNo: customerOf.get(`SI#:${String(r.sales_invoice_id ?? '')}`) ?? String(r.sales_invoice_id ?? ''),
      paidOn: isoDay(r.paid_at),
      amountSen: Number(r.amount_sen ?? 0),
      approvalCode: r.approval_code ?? null,
      customerName: customerOf.get(`SI:${String(r.sales_invoice_id ?? '')}`) ?? null,
      recordedById: (r.collected_by ?? r.created_by ?? null) as string | null,
      merchantProvider: tagOf(r),
    });
  }
  return { ok: true, payments };
}

/**
 * Clear the wreck a half-failed upload leaves behind, so its file can come in
 * again.
 *
 * settlementUpload writes the batch head FIRST and its lines after; a failure
 * between the two leaves a batch with no lines that still holds the file_hash
 * — so the operator retries the SAME file and is told "already uploaded" about
 * an upload that never finished (the owner's PBB statement of 2026-08-01 sat
 * exactly like this). A batch WITH lines keeps its refusal: that one really
 * was uploaded, and twice is twice.
 */
export async function clearOrphanBatch(
  sb: any,
  companyId: number,
  fileHash: string,
): Promise<{ ok: true; state: 'clear' | 'cleared_orphan' | 'duplicate' } | { ok: false; reason: string }> {
  const { data: prior, error: priorErr } = await sb
    .from('acc_settlement_batches')
    .select('id')
    .eq('company_id', companyId)
    .eq('file_hash', fileHash)
    .maybeSingle();
  if (priorErr) return { ok: false, reason: priorErr.message };
  if (!prior) return { ok: true, state: 'clear' };

  const priorId = Number((prior as { id: number }).id);
  const { count, error: cntErr } = await sb
    .from('acc_settlement_rows')
    .select('id', { count: 'exact', head: true })
    .eq('batch_id', priorId);
  if (cntErr) return { ok: false, reason: cntErr.message };
  if ((count ?? 0) > 0) return { ok: true, state: 'duplicate' };

  const { error: delErr } = await sb
    .from('acc_settlement_batches')
    .delete()
    .eq('id', priorId)
    .eq('company_id', companyId);
  if (delErr) return { ok: false, reason: delErr.message };
  return { ok: true, state: 'cleared_orphan' };
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

  /* STAMP THE TAG the payment was recorded without. A migration-era payment
     (method 'imported') carries no merchant_provider; the human confirming
     this line has just decided whose money it is, so the answer is written
     onto the payment — the next statement finds it as a NAMED candidate, and
     the watchlists can group it. Only NULL is ever written over: a tag someone
     chose at the till is not this function's to change. Done BEFORE anything
     posts, so a failure here stops a clean confirm instead of unwinding one;
     done twice it writes nothing, so a stamp-failed retry is safe. */
  for (const [table, source] of [['mfg_sales_order_payments', 'SOPAY'], ['sales_invoice_payments', 'SIPAY']] as const) {
    const ids = chosen.filter((p) => p.source === source).map((p) => p.id);
    if (ids.length === 0) continue;
    const { error } = await sb
      .from(table)
      .update({ merchant_provider: acq.acquirer.display_name })
      .in('id', ids)
      .eq('company_id', companyId)
      .is('merchant_provider', null);
    if (error) {
      return { ok: false, status: 'provider_stamp_failed', reason: `Could not mark the payment as ${acq.acquirer.display_name}'s: ${error.message}` };
    }
  }

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
 * ONE STATEMENT, ONE OR MORE CREDITS (owner, 2026-08-17: "我实际收到的钱可能是
 * 多笔的哦"). His files prove it both ways: Hong Leong pays a multi-day
 * statement one credit per trading day (two landed together on 18/06, 7,261.65
 * and 1,788.28), Maybank credits each trading date separately, and Public Bank
 * goes the other way — one advice covering the 7th, 8th and 9th. So each credit
 * is its own row with its own date, amount and entry, and the statement is only
 * square when they add up to what it said it would pay.
 *
 * What it said it would pay is `stated_net_sen` when the acquirer prints a
 * payable total, otherwise the sum of its own lines. A credit that would take
 * the total PAST that is refused with both numbers named: money the statement
 * does not explain belongs to another statement, and quietly absorbing it here
 * would drive that acquirer's in-transit negative — the exact symptom this
 * layer exists to make impossible.
 */
export type ReceiptInput = {
  receivedOn: string;
  /** This credit. Omitted = whatever the statement still has outstanding. */
  amountSen?: number | null;
  bankRef?: string | null;
  note?: string | null;
  userName?: string | null;
  /** WHICH BANK ACCOUNT the money is actually in.
      Set when the credit is being booked off a bank statement, and it WINS over
      the acquirer's configured bank — the statement is evidence, the config is
      a guess made before the money moved. Without this, an acquirer configured
      to pay into Hong Leong whose credit turns up on the Maybank statement
      books to Hong Leong, and Maybank's reconciliation can never balance
      (owner, 2026-08-20: 不确定 maybank 对其他的卡机).
      Left unset by the type-it-in-by-hand path, which has no statement to
      read and must fall back to the configuration. */
  bankAccountCode?: string | null;
};

/** Every credit recorded against a batch, oldest first, with what is left. */
/** Take a confirmed line back out of the ledger — the door the ignore
    refusal has pointed at since layer 3 shipped ("This line is already in the
    ledger. Reverse its journal entry instead.") without any screen being able
    to perform it. The owner asked for cancel-ability before his first real
    upload (2026-08-27: 上传了能cancel 掉?).

    Mirror of undoBatchReceipt one function down: reverse the fee entry
    (SETTLE-{rowId} — a fee-free line posted nothing and reverses nothing),
    release the payment links so the money is claimable again, and send the
    row back to NEEDS_CONFIRM for a fresh human decision — never silently back
    to MATCHED, because whatever prompted the undo may also mean the old match
    was the mistake.

    REFUSED while the statement has money recorded received: the receipts were
    taken against the batch's confirmed payable, and pulling a row out from
    under them would leave credits explaining themselves with arithmetic that
    no longer exists. Undo the credits first — they have their own button. */
export async function unconfirmSettlementRow(
  sb: any,
  companyId: number,
  rowId: number,
): Promise<{ ok: true; status: 'unconfirmed'; jeNo?: string } | { ok: false; status: string; reason: string }> {
  const { data: rowRaw, error } = await sb
    .from('acc_settlement_rows')
    .select('id, batch_id, acquirer_code, txn_date, ref, bucket, confirmed_at, posted_je_no')
    .eq('id', rowId).eq('company_id', companyId).maybeSingle();
  if (error) return { ok: false, status: 'load_failed', reason: error.message };
  if (!rowRaw) return { ok: false, status: 'not_found', reason: `settlement line ${rowId} not found` };
  const row = rowRaw as {
    id: number; batch_id: number; acquirer_code: string; txn_date: string; ref: string | null;
    bucket: string; confirmed_at: string | null; posted_je_no: string | null;
  };
  if (!row.confirmed_at) {
    return { ok: false, status: 'not_confirmed', reason: 'This line is not in the ledger — there is nothing to take back.' };
  }

  const { data: receiptsRaw, error: rcErr } = await sb
    .from('acc_settlement_receipts')
    .select('id')
    .eq('batch_id', row.batch_id).eq('company_id', companyId).limit(1);
  if (rcErr) return { ok: false, status: 'load_failed', reason: rcErr.message };
  if (((receiptsRaw ?? []) as unknown[]).length > 0) {
    return {
      ok: false, status: 'has_receipts',
      reason: 'Money is already recorded received against this statement. Undo those credits on the bank side first, then take this line back.',
    };
  }

  if (row.posted_je_no) {
    const reversed = await reverseJournal(sb, {
      sourceType: 'SETTLE',
      sourceDocNo: `SETTLE-${row.id}`,
      companyId,
      entryDate: isoDay(row.txn_date),
      narration: (orig: { je_no: string }) => `Reversal of ${orig.je_no} — the confirmation was taken back`,
    });
    if (!reversed.ok) return { ok: false, status: reversed.status, reason: reversed.reason ?? 'the reversal was refused' };
  }

  /* Links go AFTER the reversal held: releasing the payments while the fee
     entry still stands would let the same money confirm twice against one
     booked fee. */
  const { error: delErr } = await sb.from('acc_settlement_matches').delete().eq('settlement_row_id', row.id);
  if (delErr) {
    return { ok: false, status: 'unlink_failed', reason: `${delErr.message} (the entry WAS reversed — press undo again to finish releasing the payments)` };
  }

  const { error: upErr } = await sb
    .from('acc_settlement_rows')
    .update({ confirmed_at: null, posted_je_no: null, bucket: 'NEEDS_CONFIRM', match_reason: null })
    .eq('id', row.id).eq('company_id', companyId);
  if (upErr) {
    return { ok: false, status: 'update_failed', reason: `${upErr.message} (entry reversed and payments released — press undo again to finish the row)` };
  }
  return { ok: true, status: 'unconfirmed' };
}

export async function loadBatchReceipts(
  sb: any,
  companyId: number,
  batchId: number,
): Promise<{ ok: true; receipts: Array<Record<string, any>>; receivedSen: number } | { ok: false; reason: string }> {
  const { data, error } = await sb
    .from('acc_settlement_receipts')
    .select('id, batch_id, received_on, amount_sen, bank_ref, note, je_no, created_by, created_at')
    .eq('company_id', companyId)
    .eq('batch_id', batchId)
    .order('received_on');
  if (error) return { ok: false, reason: error.message };
  const receipts = (data ?? []) as Array<Record<string, any>>;
  return { ok: true, receipts, receivedSen: receipts.reduce((s, r) => s + Number(r.amount_sen ?? 0), 0) };
}

export async function postBatchReceipt(
  sb: any,
  companyId: number,
  batchId: number,
  input: ReceiptInput,
): Promise<
  | { ok: true; status: 'posted'; receiptId: number; jeNo?: string; amountSen: number; receivedSen: number; payableSen: number; outstandingSen: number }
  | { ok: false; status: string; reason: string }
> {
  const receivedOn = String(input.receivedOn ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(receivedOn)) {
    return { ok: false, status: 'bad_date', reason: 'Give the date the money reached the bank, as it reads on the bank statement (YYYY-MM-DD).' };
  }

  const { data: batchRaw, error } = await sb
    .from('acc_settlement_batches')
    .select('id, acquirer_code, period_to, net_sen, stated_net_sen')
    .eq('id', batchId).eq('company_id', companyId).maybeSingle();
  if (error) return { ok: false, status: 'load_failed', reason: error.message };
  if (!batchRaw) return { ok: false, status: 'not_found', reason: `batch ${batchId} not found` };
  const batch = batchRaw as {
    acquirer_code: string; period_to: string | null;
    net_sen: number | null; stated_net_sen: number | null;
  };

  const payableSen = Number(batch.stated_net_sen ?? batch.net_sen ?? 0);
  if (payableSen === 0) {
    return { ok: false, status: 'nothing_to_receive', reason: 'This statement pays nothing — there is no receipt to book.' };
  }

  const already = await loadBatchReceipts(sb, companyId, batchId);
  if (!already.ok) return { ok: false, status: 'load_failed', reason: already.reason };
  const outstanding = payableSen - already.receivedSen;
  if (outstanding === 0) {
    return {
      ok: false,
      status: 'fully_received',
      reason: `This statement is already fully received — ${(payableSen / 100).toFixed(2)} across ${already.receipts.length} credit(s). If the bank shows more, it belongs to another statement.`,
    };
  }

  /* Told nothing, take the rest: the ordinary case is one credit for the whole
     payout, and the operator should not have to retype a number the statement
     already knows. */
  const amountSen = input.amountSen == null ? outstanding : Math.round(Number(input.amountSen));
  if (!Number.isFinite(amountSen) || amountSen === 0) {
    return { ok: false, status: 'bad_amount', reason: 'Give the amount of this credit, as it reads on the bank statement.' };
  }
  /* Past what the statement promised — refused with both numbers, never
     absorbed. Same sign test both ways so a clawback batch behaves. */
  if (Math.abs(amountSen) > Math.abs(outstanding) || Math.sign(amountSen) !== Math.sign(outstanding)) {
    return {
      ok: false,
      status: 'over_receipt',
      reason: `${batch.acquirer_code} still owes ${(outstanding / 100).toFixed(2)} on this statement, and this credit is ${(amountSen / 100).toFixed(2)}. Record only what this statement paid — the rest belongs to another one.`,
    };
  }

  const acq = await loadAcquirer(sb, companyId, batch.acquirer_code);
  if (!acq.ok) return { ok: false, status: 'acquirer_unavailable', reason: acq.reason };

  /* WHICH BANK. Three sources, in order of how much they know:
       1. the STATEMENT this credit is being booked from — an observed fact,
          and it beats any configuration. An acquirer set up to pay into Hong
          Leong whose credit appears on the Maybank statement really is money
          in Maybank, and booking it to Hong Leong leaves Maybank's
          reconciliation permanently short by that amount;
       2. the acquirer's configured receiving bank, for the manual path where
          nobody is holding a statement;
       3. the company default, which says so loudly rather than choosing in
          silence. */
  const roles = await resolveRoles(sb, companyId);
  let bankAccount = input.bankAccountCode || acq.acquirer.bank_account_code;
  if (!bankAccount) {
    bankAccount = roles.BANK_DEFAULT;
    /* eslint-disable-next-line no-console */
    console.error(`[acc/settlement] ${batch.acquirer_code} has no receiving bank account configured — payout booked to ${bankAccount}; fill in the acquirer setup (决定4)`);
  }

  /* The row first, so the entry can be keyed on it: two credits of the same
     amount on the same day are a real thing (two terminals, one merchant), and
     keying the entry on the batch would make the second one look like a repeat
     of the first and silently book nothing. */
  const { data: rowRaw, error: insErr } = await sb.from('acc_settlement_receipts').insert({
    batch_id: batchId,
    company_id: companyId,
    received_on: receivedOn,
    amount_sen: amountSen,
    bank_ref: input.bankRef ?? null,
    note: input.note ?? null,
    created_by: input.userName ?? null,
  }).select('id').single();
  if (insErr) return { ok: false, status: 'save_failed', reason: insErr.message };
  const receiptId = Number((rowRaw as { id: number }).id);

  const posted = await postJournal(sb, {
    companyId,
    /* The bank's date, never the statement's: this entry exists because the
       bank says the money is there on this day. */
    entryDate: receivedOn,
    sourceType: 'SETTLEBANK',
    sourceDocNo: `SETTLEBANK-${batchId}-${receiptId}`,
    narration: `${batch.acquirer_code} payout received ${receivedOn} — ${(Math.abs(amountSen) / 100).toFixed(2)}`,
    lines: settlementReceiptLines(
      { bankAccountCode: bankAccount, transitAccountCode: acq.acquirer.transit_account_code },
      { acquirerCode: batch.acquirer_code, receivedOn, amountSen },
    ),
  });
  if (!posted.ok) {
    /* The entry did not post, so the credit must not survive as a row that
       says money arrived with nothing in the ledger behind it. */
    await sb.from('acc_settlement_receipts').delete().eq('id', receiptId);
    return { ok: false, status: posted.status, reason: posted.reason ?? 'the posting gate refused the entry' };
  }

  const { error: upErr } = await sb.from('acc_settlement_receipts').update({
    je_no: posted.jeNo,
    je_id: posted.jeId,
    posted_at: new Date().toISOString(),
  }).eq('id', receiptId);
  if (upErr) {
    return { ok: false, status: 'stamp_failed', reason: `${upErr.message} (entry ${posted.jeNo} DID post — the credit is recorded, only its entry number is missing)` };
  }

  const receivedSen = already.receivedSen + amountSen;
  return {
    ok: true,
    status: 'posted',
    /* The row this wrote. Layer 4 books a credit off the BANK statement and
       has to be able to point its own line at the receipt that resulted —
       without it, undoing from the bank screen would have to find the receipt
       again by date and amount, which is exactly the guess this module exists
       to avoid. */
    receiptId,
    jeNo: posted.jeNo,
    amountSen,
    receivedSen,
    payableSen,
    outstandingSen: payableSen - receivedSen,
  };
}

/**
 * Undo ONE credit — the wrong date, the wrong amount, or a credit that turned
 * out to belong to another statement.
 *
 * The way out of the ledger is a journal, not a delete: the entry is reversed
 * through the engine (source SETTLEBANK, contra SETTLEBANK_REVERSAL) and only
 * then does the row go, so the money is put back into settlement-in-transit
 * where it was and the history of the correction survives.
 */
export async function undoBatchReceipt(
  sb: any,
  companyId: number,
  receiptId: number,
): Promise<{ ok: true; status: 'undone'; jeNo?: string } | { ok: false; status: string; reason: string }> {
  const { data: rowRaw, error } = await sb
    .from('acc_settlement_receipts')
    .select('id, batch_id, amount_sen, received_on, je_no')
    .eq('id', receiptId).eq('company_id', companyId).maybeSingle();
  if (error) return { ok: false, status: 'load_failed', reason: error.message };
  if (!rowRaw) return { ok: false, status: 'not_found', reason: `credit ${receiptId} not found` };
  const row = rowRaw as { batch_id: number; amount_sen: number; received_on: string; je_no: string | null };

  const reversed = await reverseJournal(sb, {
    sourceType: 'SETTLEBANK',
    sourceDocNo: `SETTLEBANK-${row.batch_id}-${receiptId}`,
    companyId,
    entryDate: isoDay(row.received_on),
    narration: (orig) => `Reversal of ${orig.je_no} — that credit was not this statement's`,
  });
  if (!reversed.ok) return { ok: false, status: reversed.status, reason: reversed.reason ?? 'the reversal was refused' };

  const { error: delErr } = await sb.from('acc_settlement_receipts').delete().eq('id', receiptId);
  if (delErr) {
    return { ok: false, status: 'delete_failed', reason: `${delErr.message} (the entry WAS reversed — press undo again to finish removing the credit)` };
  }
  return { ok: true, status: 'undone', ...(reversed.status === 'reversed' ? { jeNo: reversed.jeNo } : {}) };
}
