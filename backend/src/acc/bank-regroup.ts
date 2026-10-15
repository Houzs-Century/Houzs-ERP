// ----------------------------------------------------------------------------
// bank-regroup — the upload's gross-and-fee join, applied to a statement that
// is already in.
//
// Since 2026-10-15 a Maybank statement PDF's pair (a card payout's gross and
// the fee taken back the same day, with no reference printed) is joined at
// upload into ONE movement: the credit row carries the net and the charge, and
// the fee row is never written (acc/bank-match.ts groupBankMovements). A
// statement uploaded before that holds the two as separate rows. 2990's MBB
// September has line 11 +RM 4,048.00 and line 13 −RM 18.22, and neither
// matches report 027032649949_DVS04E_1_20260906 (owed RM 4,029.78) on its own.
//
// This rewrites such a pair into the shape the upload now writes, so the
// credit is decided and booked like any other. Only OPEN rows that were never
// joined are touched, and a closed month is refused.
// ----------------------------------------------------------------------------

import {
  groupBankMovements, matchBankMovements,
  type BankRecognitionRule, type PayableBatch, type PayoutAdviceForMatch,
} from './bank-match';
import { loadLiveMonthLock } from './bank';
import { lockMonthOf, lockedRefusal } from './bank-lock';

/** A row of acc_bank_statement_lines, as far as joining it cares. */
export type StoredLine = {
  id: number; line_no: number | null; booked_on: string; description: string | null;
  reference: string | null; amount_sen: number; charge_sen: number | null; state: string; kind: string;
};

/** The decision columns the upload writes for a movement. */
export type StoredDecision = {
  kind: string; acquirer_code: string | null; trading_date: string | null; merchant_no: string | null;
  matched_batch_id: number | null; split: Array<{ batchId: number; amountSen: number }> | null; note: string | null;
};

export type RegroupPair = {
  creditId: number;
  feeIds: number[];
  lineNo: number;
  bookedOn: string;
  grossSen: number;
  chargeSen: number;
  netSen: number;
  /** What the upload would have written for the joined movement, decided now. */
  decision: StoredDecision;
};

/** The pairs a statement's rows hold that the upload would now join. Reads only. */
export function planRegroup(
  rows: StoredLine[], rules: BankRecognitionRule[], batches: PayableBatch[], payouts: PayoutAdviceForMatch[],
): RegroupPair[] {
  /* A row with a charge already IS a joined movement; a decided or ignored row
     is somebody's answer; a repeat is a copy. None of them is joined again. */
  const open = rows.filter((r) => String(r.state) === 'OPEN' && Number(r.charge_sen ?? 0) === 0 && String(r.kind) !== 'DUPLICATE');
  const byNo = new Map<number, StoredLine>();
  const clash = new Set<number>();
  for (const r of open) {
    const n = Number(r.line_no ?? 0);
    if (byNo.has(n)) clash.add(n);
    byNo.set(n, r);
  }
  /* Rows are joined by their place in the file; two rows claiming one place
     cannot be told apart, so neither is touched. */
  const lines = open
    .filter((r) => !clash.has(Number(r.line_no ?? 0)))
    .map((r) => ({
      lineNo: Number(r.line_no ?? 0), bookedOn: String(r.booked_on).slice(0, 10), description: String(r.description ?? ''),
      reference: r.reference ?? null, amountSen: Number(r.amount_sen), balanceSen: null,
    }));
  const joined = groupBankMovements(lines, rules).filter((m) => m.lines.length > 1);
  if (joined.length === 0) return [];
  const decisions = matchBankMovements({ movements: joined, rules, batches, payouts });
  return joined.map((m, i) => {
    const d = decisions[i]!;
    return {
      creditId: Number(byNo.get(m.lines[0]!.lineNo)!.id),
      feeIds: m.lines.slice(1).map((l) => Number(byNo.get(l.lineNo)!.id)),
      lineNo: m.lines[0]!.lineNo,
      bookedOn: m.bookedOn,
      grossSen: m.lines[0]!.amountSen,
      chargeSen: m.chargeSen,
      netSen: m.amountSen,
      decision: {
        kind: d.kind, acquirer_code: d.acquirerCode, trading_date: d.tradingDate, merchant_no: d.merchantNo,
        matched_batch_id: d.batchId, split: d.split.length > 0 ? d.split : null, note: d.clue,
      },
    };
  });
}

/**
 * Write the pairs: the credit row takes the net, the charge and the decision;
 * the fee row(s) go; the statement's movement count follows. One pair at a
 * time, and a pair whose fee rows cannot all be removed puts its credit back.
 */
export async function applyRegroup(
  sb: any, companyId: number, statement: { id: number; account_code: string; line_count: number | null }, pairs: RegroupPair[],
): Promise<{ ok: true; joined: RegroupPair[] } | { ok: false; reason: string; joined: RegroupPair[] }> {
  const joined: RegroupPair[] = [];
  for (const p of pairs) {
    const held = await loadLiveMonthLock(sb, companyId, statement.account_code, lockMonthOf(p.bookedOn));
    if (!held.ok) return { ok: false, reason: `whether ${lockMonthOf(p.bookedOn)} is closed could not be read: ${held.reason}`, joined };
    if (held.lock) return { ok: false, reason: lockedRefusal(held.lock, 'joining a payout and its fee').message, joined };

    const { data: credit, error: cErr } = await sb.from('acc_bank_statement_lines')
      .update({ amount_sen: p.netSen, charge_sen: p.chargeSen, ...p.decision, updated_at: new Date().toISOString() })
      .eq('id', p.creditId).eq('company_id', companyId).eq('statement_id', statement.id).eq('state', 'OPEN').eq('charge_sen', 0)
      .select('id').maybeSingle();
    if (cErr) return { ok: false, reason: `line ${p.lineNo}: ${cErr.message}`, joined };
    if (!credit) return { ok: false, reason: `line ${p.lineNo} is no longer an open, unjoined credit — nothing was changed for it`, joined };

    const { error: dErr } = await sb.from('acc_bank_statement_lines')
      .delete().eq('company_id', companyId).eq('statement_id', statement.id).eq('state', 'OPEN').in('id', p.feeIds);
    /* Asked again rather than trusted: whether the rows are gone is what
       matters, and a read answers it the same way on every client. */
    const { data: left, error: lErr } = await sb.from('acc_bank_statement_lines')
      .select('id').eq('company_id', companyId).in('id', p.feeIds);
    const remaining = Array.isArray(left) ? left.length : 0;
    if (dErr || lErr || remaining > 0) {
      /* Half a join is worse than none: the fee would count twice. The credit
         goes back to what the file printed. */
      await sb.from('acc_bank_statement_lines')
        .update({ amount_sen: p.grossSen, charge_sen: 0, updated_at: new Date().toISOString() })
        .eq('id', p.creditId).eq('company_id', companyId);
      const removed = p.feeIds.length - remaining;
      return {
        ok: false,
        reason: `line ${p.lineNo}: its fee row(s) could not all be removed (${dErr?.message ?? lErr?.message ?? `${remaining} of ${p.feeIds.length} still there`}); the credit was put back`
          + (removed > 0 && remaining > 0 ? ` — ${removed} fee row(s) WERE removed, so check this statement's total before going on` : ''),
        joined,
      };
    }
    joined.push(p);
  }

  if (joined.length > 0) {
    const fees = joined.reduce((s, p) => s + p.feeIds.length, 0);
    const { error: sErr } = await sb.from('acc_bank_statements')
      .update({ line_count: Math.max(0, Number(statement.line_count ?? 0) - fees) })
      .eq('id', statement.id).eq('company_id', companyId);
    if (sErr) return { ok: false, reason: `the pairs were joined, but the statement's movement count was not updated: ${sErr.message}`, joined };
  }
  return { ok: true, joined };
}
