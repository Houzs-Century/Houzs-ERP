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
  /** Who keyed the payment in — the till's `collected_by`, falling back to
      whoever created the row. A uuid here; the name is resolved once, in bulk,
      by whichever screen shows it. */
  recordedById?: string | null;
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
  /** SETS of candidates whose amounts sum exactly to the gross — a customer can
      settle two orders with one swipe, or three. */
  comboHints: string[][];
  /**
   * The system's OWN best answer, when there is exactly one way to make this
   * line's amount out of the payments in range — pre-ticked on screen so the
   * operator confirms rather than re-does the search.
   *
   * Owner, 2026-08-18: 每个 merchant 都要 set 成如果 approval code 对不上，他会尽
   * 量根据日期金额去尝试自动匹配后让我知道，我再 final confirm — 因为我没办法确定
   * authorised code salesperson 一定填对.
   *
   * It is a SUGGESTION, never a decision: it stays in NEEDS_CONFIRM and nothing
   * posts until a human presses confirm. A mistyped approval code is exactly
   * why amount+date may not auto-confirm — it is the same uncertainty, moved.
   */
  suggested: PaymentCandidate[];
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
/**
 * The ONE set of payments that makes the amount exactly — or nothing.
 *
 * Sizes from one upward, unlike exactPairs: this is used where the payments
 * already share the statement's reference, so a single one of them making the
 * amount is an answer and not the amount+date branch's business.
 *
 * "One way" is the whole point. 700 + 550 + 550 against a line of 1,250 can be
 * made two ways, and no evidence available here says which 550 was on the
 * swipe — so it returns nothing and a person decides.
 */
function soleExactSubset(pool: PaymentCandidate[], targetSen: number): PaymentCandidate[] {
  /* NO size limit on how many documents one swipe covers. The owner, asked
     whether two was the ceiling: 他可能不止两张单加起来，可能超过两张. A customer
     settling six orders in one go is one swipe like any other, and a cap of
     four would have quietly failed to match it — the worst kind of limit,
     because the screen would say "pick the right one" and give no reason.

     Safe to be exhaustive HERE because the pool is already narrow: these are
     only the payments carrying this statement line's own reference, which is
     the swipe itself plus the occasional mis-keyed code. 14 of them is 16,383
     subsets, which is nothing; beyond that the list is truncated rather than
     allowed to grow exponentially, and 15 documents on one swipe is a line
     worth a person's eye anyway. */
  const list = pool.slice(0, 14);

  /* The ordinary shape first, and without any search: every document of the
     swipe carries the code and together they are the line. */
  const all = list.reduce((s, p) => s + p.amountSen, 0);
  if (all === targetSen && list.length === pool.length) return list;

  const found: PaymentCandidate[][] = [];
  const walk = (from: number, picked: PaymentCandidate[], sum: number) => {
    if (found.length > 1) return;
    if (picked.length > 0 && sum === targetSen) { found.push([...picked]); return; }
    if (from >= list.length) return;
    for (let i = from; i < list.length; i += 1) {
      picked.push(list[i]!);
      walk(i + 1, picked, sum + list[i]!.amountSen);
      picked.pop();
      if (found.length > 1) return;
    }
  };
  walk(0, [], 0);
  return found.length === 1 ? found[0]! : [];
}

function exactPairs(candidates: PaymentCandidate[], targetSen: number): string[][] {
  /* Sets of payments that add up to the line EXACTLY.

     Pairs were enough for the case the brief names (一笔刷卡对应两张订单), but
     the owner put it more generally on 2026-08-20 — 顾客可能刷一次卡，但是还两
     个单 — and a customer settling three outstanding orders with one swipe is
     the same act. Three worked already, because the operator could tick three
     and the sum check accepts them; it simply was not SUGGESTED, so he had to
     find it himself.

     Bounded, unlike soleExactSubset above, and for a reason: there the pool is
     the payments carrying this line's own reference, so an exhaustive search is
     over a handful of highly relevant rows. HERE the pool is every payment in
     the date window, and "some six of these twenty happen to add up" is both
     expensive to find and weak evidence when found — a coincidence, not a
     swipe. Six deep is enough for the real shape (owner: 可能超过两张) without
     turning the screen into a list of arithmetic accidents. */
  const MAX_PICK = 6;
  const MAX_HINTS = 5;
  const pool = candidates.slice(0, 20);
  const hints: string[][] = [];

  const walk = (from: number, picked: PaymentCandidate[], sum: number) => {
    if (hints.length >= MAX_HINTS) return;
    if (sum === targetSen && picked.length > 1) { hints.push(picked.map((p) => p.id)); return; }
    if (picked.length >= MAX_PICK || from >= pool.length) return;
    for (let i = from; i < pool.length; i += 1) {
      picked.push(pool[i]!);
      walk(i + 1, picked, sum + pool[i]!.amountSen);
      picked.pop();
      if (hints.length >= MAX_HINTS) return;
    }
  };
  walk(0, [], 0);
  return hints;
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
          suggested: [],
          clue: `Reference ${row.ref} matches ${hits[0].docNo}`,
        });
        continue;
      }
      if (hits.length > 1) {
        /* SEVERAL payments carrying the SAME reference, adding up to the line
           EXACTLY — one swipe that the till split across several documents,
           and the strongest evidence this module ever gets. The owner, asked
           how it should behave: 多张 so 那边放的 approval code 都一样，然后加起来
           金额是对的上卡机报告的，你不能自动核对吗.
           He is right, and this used to fall through to "pick the right one" —
           asking a person to choose between payments that are not alternatives
           at all, but parts of one payment.
           Only when they ALL add up: if some subset does and the rest do not,
           the remainder is unexplained money wearing the same reference, and
           that is exactly a line a person should look at. */
        /* The reference AND the amount both agree — take it.
           The owner, when this used to stop at "they must ALL add up":
           这个情况当他对的上卡机报告的数额也不应该出现不是? He is right. The
           common cause of an extra payment wearing this reference is a code
           mis-keyed onto an unrelated sale, and in that case the documents
           that add up ARE the swipe. Nothing is hidden by taking them: what is
           left over stays unsettled and shows on the watchlist (未对上的收款),
           which is where a mis-keyed code should surface.
           Still only when there is ONE way to make the amount — 700 + 550 + 550
           against a line of 1,250 is a question no evidence here can answer. */
        const together = hits.reduce((s, p) => s + p.amountSen, 0);
        const sole = soleExactSubset(hits, row.grossSen);
        if (sole.length > 0) {
          for (const p of sole) claimed.add(key(p));
          const rest = hits.length - sole.length;
          decisions.push({
            row,
            bucket: 'MATCHED',
            matchReason: 'ref',
            matched: sole,
            candidates: [],
            comboHints: [],
            suggested: [],
            clue: `Reference ${row.ref} matches ${sole.length === 1 ? sole[0]!.docNo : `${sole.length} payments that add up to it exactly — ${sole.map((p) => p.docNo).join(' + ')}`}`
              /* Say what was NOT taken. A payment left behind wearing the same
                 reference is worth a look even though this line is settled. */
              + (rest > 0
                ? `. ${rest} other payment(s) carry this reference and are not part of it — they stay open.`
                : ''),
          });
          continue;
        }
        decisions.push({
          row,
          bucket: 'NEEDS_CONFIRM',
          matchReason: 'ref',
          matched: [],
          candidates: hits,
          comboHints: exactPairs(hits, row.grossSen),
          suggested: [],
          /* Say BOTH numbers. A reference shared by payments that cannot make
             this line is either a mis-keyed code or a document missing from the
             swipe, and the difference is the clue to which. */
          clue: `${hits.length} payments carry reference ${row.ref}, but no combination of them makes `
            + `${(row.grossSen / 100).toFixed(2)} (they come to ${(together / 100).toFixed(2)})`
            + ' — pick the ones that belong to it.',
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
      /* ONE payment of this amount in range is the system's answer — ticked for
         the operator, still his to confirm. Several is a question, not an
         answer, so nothing is ticked and he chooses. */
      const only = sameAmount.length === 1 ? sameAmount : [];
      const why = trustsRef && row.ref
        ? `Reference ${row.ref} matched nothing`
        : `${cfg.code} sends no unique reference`;
      decisions.push({
        row,
        bucket: 'NEEDS_CONFIRM',
        matchReason: 'amount+date',
        matched: [],
        candidates: sameAmount,
        comboHints: [],
        suggested: only,
        clue: only.length === 1
          ? `${why} — ${only[0].docNo} is the only payment of this amount within ${tolerance} day(s). Check it and confirm.`
          : `${why}; ${sameAmount.length} payments match on amount and date — pick the right one`,
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
      /* One swipe, several orders (一笔刷卡对应两张订单, and the owner more
         generally on 2026-08-20: 顾客可能刷一次卡，但是还两个单). Exactly ONE set
         that adds up is the same kind of single answer as one payment on the
         amount — whether that set is two documents or four. Two different sets
         that both add up is a question, not an answer, so nothing is ticked. */
      const onlySet = hints.length === 1
        ? inWindow.filter((p) => hints[0]!.includes(p.id))
        : [];
      decisions.push({
        row,
        bucket: 'NEEDS_CONFIRM',
        matchReason: 'amount+date',
        matched: [],
        candidates: inWindow,
        comboHints: hints,
        suggested: onlySet,
        clue: onlySet.length > 0
          ? `No single payment matches — ${onlySet.map((p) => p.docNo).join(' + ')} add up to it exactly. Check them and confirm.`
          : hints.length
            ? `No single payment matches; ${hints.length} set(s) of payments add up to this amount — pick the right one`
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
      suggested: [],
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
