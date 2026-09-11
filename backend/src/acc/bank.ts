// ----------------------------------------------------------------------------
// acc/bank — the database side of bank reconciliation (layer 4, phase 4).
//
// The readers and the one writer that the routes need. Everything that decides
// anything lives next door in bank-parse / bank-match / bank-reconcile, which
// are pure and therefore testable without a database; this file only fetches,
// and posts through the one gate.
//
// The one writer, postBankLine, is deliberately thin: a movement that settles a
// merchant statement is posted by LAYER 3's postBatchReceipt, not by a second
// path of this module's own. There is one notion of "the acquirer paid us" in
// this system and one place that books it — 0335's header says so — and a bank
// screen that wrote its own receipts would be a second, parallel truth about
// the same money.
// ----------------------------------------------------------------------------

import type { BankColumnMap, BankParseConfig } from './bank-parse';
import type { BankRecognitionRule, PayableBatch, PayoutAdviceForMatch } from './bank-match';
import type { LedgerMovement } from './bank-reconcile';
import { lockMonthOf, monthAsDate, monthFromDate, type MonthLock } from './bank-lock';

export type BankStatementConfig = {
  id: number;
  account_code: string;
  bank_code: string;
  account_no: string | null;
  statement_format: string;
  delimiter: string | null;
  amount_format: 'decimal' | 'integer-sen';
  credit_indicator: string;
  column_map: BankColumnMap;
  is_active: boolean;
};

type Fail = { ok: false; reason: string };

/** Every bank account of this company that can have a statement uploaded. */
export async function loadBankConfigs(
  sb: any, companyId: number,
): Promise<{ ok: true; configs: BankStatementConfig[] } | Fail> {
  const { data, error } = await sb.from('acc_bank_statement_config')
    .select('id, account_code, bank_code, account_no, statement_format, delimiter, amount_format, credit_indicator, column_map, is_active')
    .eq('company_id', companyId)
    .order('account_code');
  if (error) return { ok: false, reason: error.message };
  return { ok: true, configs: ((data ?? []) as BankStatementConfig[]) };
}

export async function loadBankConfig(
  sb: any, companyId: number, accountCode: string,
): Promise<{ ok: true; config: BankStatementConfig } | Fail> {
  const all = await loadBankConfigs(sb, companyId);
  if (!all.ok) return all;
  const found = all.configs.find((c) => c.account_code === accountCode);
  if (!found) {
    /* Name what IS set up. "Not configured" alone leaves the operator guessing
       whether he picked the wrong account or nobody has done the setup. */
    const known = all.configs.map((c) => `${c.account_code} (${c.bank_code})`).join(', ');
    return {
      ok: false,
      reason: `No statement format is set up for account ${accountCode} in this company.`
        + (known ? ` Configured here: ${known}.` : ' No bank account is configured here at all.'),
    };
  }
  return { ok: true, config: found };
}

/** Turn a stored config into what the reader wants. One place, so the column
    names in the table and the field names in the parser cannot drift apart. */
export const parseConfigFrom = (
  cfg: BankStatementConfig, statementMonth?: string | null,
): BankParseConfig => ({
  code: `${cfg.bank_code} ${cfg.account_code}`,
  delimiter: cfg.delimiter ?? undefined,
  columnMap: cfg.column_map,
  amountFormat: cfg.amount_format,
  creditIndicator: cfg.credit_indicator,
  statement_format: cfg.statement_format,
  statementMonth: statementMonth ?? null,
});

export async function loadRecognitionRules(
  sb: any,
): Promise<{ ok: true; rules: BankRecognitionRule[] } | Fail> {
  const { data, error } = await sb.from('acc_bank_recognition_rules')
    .select('acquirer_code, pattern, match_field, trading_date_pattern, merchant_pattern, sort_order, is_active')
    .eq('is_active', true)
    .order('sort_order');
  if (error) return { ok: false, reason: error.message };
  const rows = (data ?? []) as Array<Record<string, any>>;
  return {
    ok: true,
    rules: rows.map((r) => ({
      acquirerCode: String(r.acquirer_code),
      pattern: String(r.pattern),
      field: (r.match_field ?? 'both') as BankRecognitionRule['field'],
      tradingDatePattern: r.trading_date_pattern ?? null,
      merchantPattern: r.merchant_pattern ?? null,
    })),
  };
}

/**
 * The merchant statements that are RECONCILED and still owed money.
 *
 * Reconciled only — the owner's rule, 核对完了没有问题才会显示去 bank statement
 * 的 reconciliation. A statement whose lines are still undecided must not be
 * claimable by a bank credit, or the money would land against a total that is
 * still moving.
 */
export async function loadPayableBatches(
  sb: any, companyId: number,
): Promise<{ ok: true; batches: PayableBatch[] } | Fail> {
  const [batchRes, rowRes, recRes] = await Promise.all([
    sb.from('acc_settlement_batches')
      .select('id, acquirer_code, file_name, period_from, period_to, net_sen, stated_net_sen')
      .eq('company_id', companyId),
    sb.from('acc_settlement_rows')
      .select('batch_id, confirmed_at, bucket').eq('company_id', companyId),
    sb.from('acc_settlement_receipts')
      .select('batch_id, amount_sen').eq('company_id', companyId),
  ]);
  if (batchRes.error) return { ok: false, reason: batchRes.error.message };
  if (rowRes.error) return { ok: false, reason: rowRes.error.message };
  if (recRes.error) return { ok: false, reason: recRes.error.message };

  const openByBatch = new Map<number, number>();
  for (const r of (rowRes.data ?? []) as Array<Record<string, any>>) {
    const id = Number(r.batch_id);
    const open = !r.confirmed_at && r.bucket !== 'IGNORED' ? 1 : 0;
    openByBatch.set(id, (openByBatch.get(id) ?? 0) + open);
  }
  const receivedByBatch = new Map<number, number>();
  for (const r of (recRes.data ?? []) as Array<Record<string, any>>) {
    const id = Number(r.batch_id);
    receivedByBatch.set(id, (receivedByBatch.get(id) ?? 0) + Number(r.amount_sen ?? 0));
  }

  const batches: PayableBatch[] = [];
  for (const b of (batchRes.data ?? []) as Array<Record<string, any>>) {
    const id = Number(b.id);
    if ((openByBatch.get(id) ?? 0) > 0) continue;             // not reconciled yet
    const payableSen = Number(b.stated_net_sen ?? b.net_sen ?? 0);
    const outstandingSen = payableSen - (receivedByBatch.get(id) ?? 0);
    if (outstandingSen === 0) continue;                        // already in the bank
    batches.push({
      id,
      acquirerCode: String(b.acquirer_code),
      fileName: b.file_name ?? undefined,
      periodFrom: String(b.period_from ?? ''),
      periodTo: String(b.period_to ?? ''),
      payableSen,
      outstandingSen,
    });
  }
  return { ok: true, batches };
}

/**
 * Every payment advice uploaded for this company — the acquirer's own written
 * answer to "which days does one credit pay" (acc/payout-advice).
 *
 * Handed to the matcher RAW, all of them: whether an advice still answers for
 * today's books is decided there, against the same payable statements it would
 * offer — one already paid, or re-opened, simply fails to resolve and the
 * ordinary search takes over. Filtering here would be a second copy of that
 * rule, one refactor away from disagreeing with it.
 */
export async function loadPayoutAdvices(
  sb: any, companyId: number,
): Promise<{ ok: true; payouts: PayoutAdviceForMatch[] } | Fail> {
  const [payoutRes, dayRes] = await Promise.all([
    sb.from('acc_settlement_payouts')
      .select('id, acquirer_code, file_name, advice_date, net_sen')
      .eq('company_id', companyId),
    sb.from('acc_settlement_payout_batches')
      .select('payout_id, settled_on, net_sen')
      .eq('company_id', companyId),
  ]);
  if (payoutRes.error) return { ok: false, reason: payoutRes.error.message };
  if (dayRes.error) return { ok: false, reason: dayRes.error.message };

  const daysByPayout = new Map<number, Array<{ settledOn: string; netSen: number }>>();
  for (const d of (dayRes.data ?? []) as Array<Record<string, any>>) {
    const id = Number(d.payout_id);
    const at = daysByPayout.get(id) ?? [];
    at.push({ settledOn: String(d.settled_on).slice(0, 10), netSen: Number(d.net_sen ?? 0) });
    daysByPayout.set(id, at);
  }

  return {
    ok: true,
    payouts: ((payoutRes.data ?? []) as Array<Record<string, any>>).map((p) => ({
      id: Number(p.id),
      acquirerCode: String(p.acquirer_code),
      fileName: p.file_name == null ? null : String(p.file_name),
      adviceDate: p.advice_date == null ? null : String(p.advice_date).slice(0, 10),
      netSen: Number(p.net_sen ?? 0),
      days: daysByPayout.get(Number(p.id)) ?? [],
    })),
  };
}

/**
 * Every posted movement on one account, up to a date.
 *
 * scm.v_gl_entries is the posted-ledger read every balance in this system goes
 * through, so the reconciliation cannot disagree with the general ledger — it
 * is reading the same rows.
 *
 * Reversed entries are KEPT (migration 0290, owner decision 2026-08-13: show
 * both entries and let them net). A reversal and its original sum to zero, so
 * the balance is right and the audit trail survives — which is what a
 * reconciliation needs, since the bank statement will show neither.
 */
export async function loadAccountLedger(
  sb: any, companyId: number, accountCode: string, upTo: string,
): Promise<{ ok: true; movements: LedgerMovement[] } | Fail> {
  const { data, error } = await sb.from('v_gl_entries')
    .select('je_no, entry_date, source_type, source_doc_no, debit_sen, credit_sen, notes, party_name, reversed, reversed_by_je')
    .eq('company_id', companyId)
    .eq('account_code', accountCode)
    .lte('entry_date', upTo);
  if (error) return { ok: false, reason: error.message };

  /* One ENTRY per row, not one line: an entry can touch the bank account twice
     (a transfer in and out on the same journal), and the reconciliation matches
     entries. Summed rather than deduplicated, so nothing is lost either way. */
  const byJe = new Map<string, LedgerMovement>();
  for (const r of (data ?? []) as Array<Record<string, any>>) {
    /* A REVERSED entry and the contra that undid it are one correction, not
       two bank movements: they net to nothing and no statement will ever show
       either. Both sides carry reversed_by_je; neither is the bank's business
       (docs/bugs/0802 — they were being listed, and offered, as two entries). */
    if (r.reversed === true || r.reversed_by_je != null) continue;
    const jeNo = String(r.je_no ?? '');
    const at = byJe.get(jeNo);
    if (at) {
      at.debitSen += Number(r.debit_sen ?? 0);
      at.creditSen += Number(r.credit_sen ?? 0);
    } else {
      byJe.set(jeNo, {
        jeNo,
        entryDate: String(r.entry_date ?? '').slice(0, 10),
        sourceType: r.source_type ?? null,
        sourceDocNo: r.source_doc_no ?? null,
        debitSen: Number(r.debit_sen ?? 0),
        creditSen: Number(r.credit_sen ?? 0),
        notes: r.notes ?? null,
        partyName: (r.party_name as string | null | undefined) ?? null,
      });
    }
  }
  return { ok: true, movements: [...byJe.values()].sort((a, b) => a.entryDate.localeCompare(b.entryDate)) };
}

/**
 * What the account's OTHER statements have claimed, for the carried list
 * (docs/bugs/0802): every je_no a POSTED line of any statement of this account
 * points at (its own posted_je_no, or a match row on a POSTED line), except the
 * statement being looked at — plus the day the first statement ever filed for
 * the account begins, before which nothing was reconciled here and so nothing
 * is "still waiting". Fails closed: a read that fails is a refusal.
 */
export async function loadClaimedElsewhere(
  sb: Parameters<typeof loadAccountLedger>[0], companyId: number, accountCode: string, exceptStatementId: number | null,
): Promise<{ ok: true; claimed: Set<string>; firstPeriodFrom: string | null } | Fail> {
  const { data: stmts, error: sErr } = await sb.from('acc_bank_statements')
    .select('id, period_from').eq('company_id', companyId).eq('account_code', accountCode);
  if (sErr) return { ok: false, reason: sErr.message };
  const all = (stmts ?? []) as Array<{ id: number; period_from: string | null }>;
  const firstPeriodFrom = all.map((s) => String(s.period_from ?? '').slice(0, 10)).filter(Boolean).sort()[0] ?? null;
  const ids = all.map((s) => Number(s.id)).filter((id) => id !== exceptStatementId);
  const claimed = new Set<string>();
  if (ids.length === 0) return { ok: true, claimed, firstPeriodFrom };

  const { data: lines, error: lErr } = await sb.from('acc_bank_statement_lines')
    .select('id, posted_je_no, state').eq('company_id', companyId).in('statement_id', ids).eq('state', 'POSTED');
  if (lErr) return { ok: false, reason: lErr.message };
  const posted = (lines ?? []) as Array<{ id: number; posted_je_no: string | null }>;
  for (const l of posted) if (l.posted_je_no) claimed.add(String(l.posted_je_no));

  const postedIds = posted.map((l) => Number(l.id));
  if (postedIds.length > 0) {
    const { data: matches, error: mErr } = await sb.from('acc_bank_statement_matches')
      .select('bank_line_id, je_no').eq('company_id', companyId).in('bank_line_id', postedIds);
    if (mErr) return { ok: false, reason: mErr.message };
    for (const m of (matches ?? []) as Array<{ je_no: string }>) claimed.add(String(m.je_no));
  }
  return { ok: true, claimed, firstPeriodFrom };
}

/** Everything the reconciliation should treat as already claimed: what other
    statements claimed, and every ledger entry older than the first statement
    ever filed for the account. */
export const claimedSetFor = (
  elsewhere: { claimed: Set<string>; firstPeriodFrom: string | null },
  ledger: Array<{ jeNo: string; entryDate: string }>,
): Set<string> => {
  const out = new Set(elsewhere.claimed);
  if (elsewhere.firstPeriodFrom) {
    for (const l of ledger) if (l.entryDate < elsewhere.firstPeriodFrom) out.add(l.jeNo);
  }
  return out;
};

/**
 * The LIVE lock on one month of one account, or null.
 *
 * Lives here rather than beside the lock routes because it is a read, and
 * because every guarded write in layer 4 has to make it — a guard that imported
 * from a route module would put a cycle between the two files that need it most
 * (owner, 2026-09-08: 还有lock 起来不可以随便碰).
 *
 * A released lock is NOT live: the row stays for ever as the record that the
 * month was closed and reopened, and only `released_at IS NULL` stops a write.
 */
export async function loadLiveMonthLock(
  sb: any, companyId: number, accountCode: string, month: string,
): Promise<{ ok: true; lock: MonthLock | null } | Fail> {
  const { data, error } = await sb.from('acc_bank_month_locks')
    .select('account_code, period_month, locked_by, locked_at, lock_note,'
      + ' closing_statement_sen, closing_ledger_sen, difference_sen, statement_count, was_complete')
    .eq('company_id', companyId)
    .eq('account_code', accountCode)
    .eq('period_month', monthAsDate(month))
    .is('released_at', null)
    .maybeSingle();
  if (error) return { ok: false, reason: error.message };
  if (!data) return { ok: true, lock: null };
  const r = data as Record<string, any>;
  return {
    ok: true,
    lock: {
      accountCode: String(r.account_code),
      month: monthFromDate(String(r.period_month ?? '')),
      lockedBy: r.locked_by == null ? null : String(r.locked_by),
      lockedAt: String(r.locked_at ?? ''),
      lockNote: r.lock_note == null ? null : String(r.lock_note),
      closingStatementSen: r.closing_statement_sen == null ? null : Number(r.closing_statement_sen),
      closingLedgerSen: r.closing_ledger_sen == null ? null : Number(r.closing_ledger_sen),
      differenceSen: r.difference_sen == null ? null : Number(r.difference_sen),
      statementCount: Number(r.statement_count ?? 0),
      wasComplete: r.was_complete === true,
    },
  };
}

/**
 * Which bank account a statement line belongs to, and the month its own date
 * puts it in — the two things a guard needs before it can ask about a lock.
 *
 * TWO PLAIN READS, not one read with an embed. `select('…, acc_bank_statements
 * !inner(account_code)')` would do it in one trip and was the first shape here;
 * it is wrong twice over. PostgREST returns an embedded row as an object or a
 * one-element array depending on how it read the relationship, so the caller
 * has to guess — and a guard that guesses wrong does not fail loudly, it
 * silently decides the line has no account and lets a locked month through or
 * refuses an open one. The fake client the route tests run on models no embeds
 * at all, which means the guard would have been exercised by nothing.
 *
 * Two reads that both work everywhere beat one that is only tested in
 * production.
 */
export async function loadLineMonth(
  sb: any, companyId: number, lineId: number,
): Promise<{ ok: true; found: false } | { ok: true; found: true; accountCode: string; month: string } | Fail> {
  const { data: lineRow, error } = await sb.from('acc_bank_statement_lines')
    .select('booked_on, statement_id')
    .eq('id', lineId).eq('company_id', companyId).maybeSingle();
  if (error) return { ok: false, reason: error.message };
  if (!lineRow) return { ok: true, found: false };
  const line = lineRow as Record<string, any>;

  const { data: stmtRow, error: sErr } = await sb.from('acc_bank_statements')
    .select('account_code')
    .eq('id', Number(line.statement_id)).eq('company_id', companyId).maybeSingle();
  if (sErr) return { ok: false, reason: sErr.message };
  const accountCode = stmtRow == null ? '' : String((stmtRow as Record<string, any>).account_code ?? '');
  /* A line whose statement cannot be found is not a line this guard can clear.
     Saying so is a refusal the operator can act on; assuming "not locked" is
     the failure this whole function exists to prevent. */
  if (!accountCode) {
    return { ok: false, reason: `bank line ${lineId} has no statement to check a lock against` };
  }
  return { ok: true, found: true, accountCode, month: lockMonthOf(String(line.booked_on).slice(0, 10)) };
}
