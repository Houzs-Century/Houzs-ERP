// ----------------------------------------------------------------------------
// acc/settlement-match — pairing statement lines with the ERP's own payments.
//
// The brief's non-negotiables for this file (§3.5 layer 3):
//
//   • Only a UNIQUE REFERENCE may auto-match. An acquirer without one (系统3's
//     GHL) "只能靠金额＋日期猜" — every one of its lines goes to NEEDS_CONFIRM
//     with its candidates, and a human decides. An acquirer whose 决定4 config
//     has not been filled in yet counts as "without one", because unknown is
//     not the same as yes.
//   • The date tolerance comes from the CONFIG. 系统3's design document said 3
//     days and its code said 7; here there is one number and it is in the row.
//   • One settlement line may cover SEVERAL payments (一笔刷卡对应两张订单), so
//     the candidate list is multi-select and exact-sum PAIRS are surfaced as a
//     hint rather than left for the operator to find by hand.
//   • A payment already settled by another line is not a candidate at all — the
//     database enforces that too (acc_settlement_payment_once), but a candidate
//     list that offers money already cleared wastes the operator's attention.
//
// Everything here is pure: rows in, decisions out. No reads, no writes — which
// is what makes the rules above testable line by line.
// ----------------------------------------------------------------------------

import type { ParsedRow } from './settlement-parse';

export type PaymentCandidate = {
  source: 'SOPAY' | 'SIPAY';
  id: string;
  docNo: string;
  paidOn: string;        // YYYY-MM-DD
  amountSen: number;
  approvalCode: string | null;
  customerName: string | null;
};

export type MatchBucket = 'MATCHED' | 'NEEDS_CONFIRM' | 'UNMATCHED' | 'IGNORED';

export type MatchDecision = {
  row: ParsedRow;
  bucket: MatchBucket;
  matchReason: 'ref' | 'amount+date' | null;
  /** Auto-taken payments (ref match only). Empty for every other bucket. */
  matched: PaymentCandidate[];
  /** What to offer the operator when the bucket is NEEDS_CONFIRM. */
  candidates: PaymentCandidate[];
  /** Pairs of candidates whose amounts sum exactly to the gross. */
  comboHints: Array<[string, string]>;
  /** The one-line reason shown on screen next to the row. */
  clue: string;
};

export type MatchConfig = {
  code: string;
  has_unique_ref: boolean | null;
  date_tolerance_days: number;
};

const normRef = (s: string | null | undefined): string =>
  String(s ?? '').trim().toUpperCase().replace(/^0+(?=\d)/, '');

const dayGap = (a: string, b: string): number =>
  Math.abs((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);

/** Pairs (i<j) of candidates whose amounts sum exactly to the target. Bounded
    at 40 candidates: past that the window is too wide to be a useful hint, and
    the quadratic scan stops earning its keep. */
function exactPairs(candidates: PaymentCandidate[], targetSen: number): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  const pool = candidates.slice(0, 40);
  for (let i = 0; i < pool.length; i += 1) {
    for (let j = i + 1; j < pool.length; j += 1) {
      if (pool[i].amountSen + pool[j].amountSen === targetSen) pairs.push([pool[i].id, pool[j].id]);
      if (pairs.length >= 5) return pairs;
    }
  }
  return pairs;
}

/**
 * Decide a bucket for every statement line.
 *
 * `alreadySettled` holds `${source}:${id}` for payments a previous statement
 * already cleared. Within ONE call the function also keeps its own claim set,
 * so two lines of the same file cannot both auto-take the same payment: the
 * second finds it gone and lands in NEEDS_CONFIRM, which is the honest answer.
 */
export function matchStatement(
  cfg: MatchConfig,
  rows: ParsedRow[],
  payments: PaymentCandidate[],
  alreadySettled: Set<string> = new Set(),
): MatchDecision[] {
  const key = (p: PaymentCandidate) => `${p.source}:${p.id}`;
  const claimed = new Set<string>(alreadySettled);
  const available = () => payments.filter((p) => !claimed.has(key(p)));

  const byRef = new Map<string, PaymentCandidate[]>();
  for (const p of payments) {
    const r = normRef(p.approvalCode);
    if (!r) continue;
    const list = byRef.get(r);
    if (list) list.push(p);
    else byRef.set(r, [p]);
  }

  const tolerance = Number.isFinite(cfg.date_tolerance_days) ? Math.max(0, cfg.date_tolerance_days) : 3;
  const trustsRef = cfg.has_unique_ref === true;
  const decisions: MatchDecision[] = [];

  for (const row of rows) {
    /* 1. The unique reference — the only path that may auto-match. */
    if (trustsRef && row.ref) {
      const hits = (byRef.get(normRef(row.ref)) ?? []).filter((p) => !claimed.has(key(p)));
      if (hits.length === 1) {
        claimed.add(key(hits[0]));
        decisions.push({
          row,
          bucket: 'MATCHED',
          matchReason: 'ref',
          matched: hits,
          candidates: [],
          comboHints: [],
          clue: `Reference ${row.ref} matches ${hits[0].docNo}`,
        });
        continue;
      }
      if (hits.length > 1) {
        decisions.push({
          row,
          bucket: 'NEEDS_CONFIRM',
          matchReason: 'ref',
          matched: [],
          candidates: hits,
          comboHints: exactPairs(hits, row.grossSen),
          clue: `${hits.length} payments carry reference ${row.ref} — pick the right one`,
        });
        continue;
      }
    }

    /* 2. Amount + date, inside the CONFIGURED tolerance. Never auto-confirmed:
          for a no-unique-ref acquirer the brief forbids it outright, and for a
          ref-carrying acquirer a line that failed on reference is exactly the
          line a human should look at. */
    const pool = available();
    const sameAmount = pool.filter((p) => p.amountSen === row.grossSen && dayGap(p.paidOn, row.txnDate) <= tolerance);
    if (sameAmount.length > 0) {
      decisions.push({
        row,
        bucket: 'NEEDS_CONFIRM',
        matchReason: 'amount+date',
        matched: [],
        candidates: sameAmount,
        comboHints: [],
        clue: trustsRef && row.ref
          ? `No payment carries reference ${row.ref}; ${sameAmount.length} payment(s) match on amount and date`
          : `${cfg.code} sends no unique reference — ${sameAmount.length} payment(s) match on amount and date`,
      });
      continue;
    }

    /* 3. Nothing on the amount. Offer the window anyway — this is where the
          many-orders-one-swipe case is resolved, so smaller payments in range
          are candidates and exact-summing pairs are pointed at. */
    const inWindow = pool
      .filter((p) => dayGap(p.paidOn, row.txnDate) <= tolerance && Math.abs(p.amountSen) <= Math.abs(row.grossSen))
      .sort((a, b) => b.amountSen - a.amountSen);
    if (inWindow.length > 0) {
      const hints = exactPairs(inWindow, row.grossSen);
      decisions.push({
        row,
        bucket: 'NEEDS_CONFIRM',
        matchReason: 'amount+date',
        matched: [],
        candidates: inWindow,
        comboHints: hints,
        clue: hints.length
          ? `No single payment matches; ${hints.length} pair(s) of payments add up to this amount`
          : `No payment matches this amount — ${inWindow.length} smaller payment(s) are within ${tolerance} day(s)`,
      });
      continue;
    }

    /* 4. Money the acquirer says it sent that this ERP has no record of. This
          is watchlist 2 (未对上的结算) and it stays visible until explained. */
    decisions.push({
      row,
      bucket: 'UNMATCHED',
      matchReason: null,
      matched: [],
      candidates: [],
      comboHints: [],
      clue: `No payment recorded near ${row.txnDate} for this amount`,
    });
  }

  return decisions;
}

/** Payments the ERP recorded that no statement line has claimed — watchlist 1
    (未到账收款: "the system says we took this card money; the acquirer has not
    sent it"). Ageing is what makes it actionable, so it is returned. */
export function recordedNotArrived(
  payments: PaymentCandidate[],
  settled: Set<string>,
  asOf: string,
): Array<PaymentCandidate & { ageDays: number }> {
  return payments
    .filter((p) => !settled.has(`${p.source}:${p.id}`))
    .map((p) => ({ ...p, ageDays: Math.round(dayGap(p.paidOn, asOf)) }))
    .sort((a, b) => b.ageDays - a.ageDays);
}
