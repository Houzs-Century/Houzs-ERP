// ----------------------------------------------------------------------------
// acc/bank-match — deciding what a line on the BANK statement is.
//
// Layer 4, phase 4. The bank prints one flat list; this turns it into answers:
// which lines are an acquirer paying out a statement we have already
// reconciled, which acquirer, which trading day, and which of our batches it
// settles. Everything else is handed on untouched — a bank statement is full of
// money that has nothing to do with cards.
//
// Two things here are load-bearing and neither is obvious.
//
// ── 1. A payout can arrive as TWO lines, and only one shape of pair is safe
//       to join. ──
// Owner, 2026-08-19: 据我所知 mbb merchant 偶尔会在 bank statement 显示进全额然后
// 扣. In the real Maybank export that is:
//     2026-08-09  +875.00  DR/CARD SALES M/N 2259020 …   ref D90200808
//     2026-08-09    -3.94  DR/CARD SALES M/N 2259020 …   ref D90200808
// One payout of RM 871.06, written as a credit and its charge.
//
// The tempting rule — "join lines sharing a reference" — is WRONG, and the same
// file proves it: three separate AEON payouts of RM 3,262.46, RM 6,619.48 and
// RM 10,114.61 all carry `MA458030163361` on 2026-08-03, and half the retail
// credits use the literal reference "Fund Transfer". Joining those would invent
// a RM 19,996.55 payout that never happened.
//
// So the rule is narrow on purpose: a group is ONE credit and the DEBITS that
// share its reference and its date. Two credits are never joined, whatever they
// share. That is exactly the gross-and-fee shape and nothing else.
//
// ── 2. Which acquirer a line belongs to is CONFIG, not code. ──
// The brief is explicit that every acquirer's "how do I recognise this money on
// the bank statement" rule must exist the moment the acquirer does — 系统3 had
// four acquirers and two rules, so two acquirers' money read as 永远收不到
// forever. The rules live in a table; this file only applies them. The real
// shapes they encode are recorded in docs/acquirer-statement-formats.md:
//
//   MBB   CR/CARD SALES MN <merchant> DATED <DDMMYYYY>   (net credited)
//         DR/CARD SALES M/N <merchant> DATED <DDMMYYYY>  (gross, fee separate)
//   PBB   03999061714  PBB-PBCS AC 3
//   AEON  Book Transfer Third AEON CREDIT SERVICE
//   HLB   blank sender, CA Credit Advice, ref …MERCHANT <YYYYMMDD>
// ----------------------------------------------------------------------------

import type { BankLine } from './bank-parse';
import { toIsoDate } from './settlement-parse';

/* ── What the bank actually moved ─────────────────────────────────────────── */

export type BankMovement = {
  /** The line(s) it is made of: one, or a credit and the charge(s) taken back
      against it. Kept, because a reconciliation has to be able to point at the
      rows on the statement the operator is holding. */
  lines: BankLine[];
  bookedOn: string;
  description: string;
  reference: string | null;
  /** The NET of its lines — what the account moved by. Positive is money in. */
  amountSen: number;
  /** What was taken back out of a credit, when the bank split it. 0 otherwise,
      so "was this split?" is a number nobody has to infer from the line count. */
  chargeSen: number;
};

/**
 * Join a credit with the charge(s) the bank took back against it.
 *
 * Only that shape. See the header: two credits sharing a reference are two
 * payouts, and the real file contains both traps.
 */
export function groupBankMovements(lines: BankLine[]): BankMovement[] {
  const single = (l: BankLine): BankMovement => ({
    lines: [l], bookedOn: l.bookedOn, description: l.description,
    reference: l.reference, amountSen: l.amountSen, chargeSen: 0,
  });

  /* Index by reference+date, but only where there IS a reference — a blank one
     is not a thing two lines can have in common. */
  const buckets = new Map<string, BankLine[]>();
  for (const l of lines) {
    if (!l.reference) continue;
    const key = `${l.reference}|${l.bookedOn}`;
    const at = buckets.get(key);
    if (at) at.push(l); else buckets.set(key, [l]);
  }

  const joined = new Set<BankLine>();
  const out: BankMovement[] = [];
  for (const group of buckets.values()) {
    const credits = group.filter((l) => l.amountSen > 0);
    const debits = group.filter((l) => l.amountSen < 0);
    /* Exactly one credit, at least one debit. Two credits could not be told
       apart — which charge belongs to which? — so they are left alone and each
       stands as its own movement. */
    if (credits.length !== 1 || debits.length === 0) continue;
    const credit = credits[0]!;
    const chargeSen = debits.reduce((s, d) => s + -d.amountSen, 0);
    /* A "charge" bigger than the credit is not a charge; something else is
       going on and a human should look at it, not this function. */
    if (chargeSen >= credit.amountSen) continue;
    for (const l of group) joined.add(l);
    out.push({
      lines: [credit, ...debits],
      bookedOn: credit.bookedOn,
      description: credit.description,
      reference: credit.reference,
      amountSen: credit.amountSen - chargeSen,
      chargeSen,
    });
  }

  for (const l of lines) if (!joined.has(l)) out.push(single(l));
  /* Statement order, so the screen reads down the page the operator is holding. */
  return out.sort((a, b) => (a.lines[0]!.lineNo - b.lines[0]!.lineNo));
}

/* ── Which acquirer, from config ──────────────────────────────────────────── */

export type BankRecognitionRule = {
  acquirerCode: string;
  /** Regex source. From the config table — never a literal in this file. */
  pattern: string;
  /** Where to look. Default searches the description and the reference. */
  field?: 'description' | 'reference' | 'both' | null;
  /** Regex whose FIRST capture group is the trading day being settled, e.g.
      `DATED\s*(\d{8})` for Maybank or `MERCHANT\s+(\d{8})` for Hong Leong.
      The trading day, not the payout day: they differ by design. */
  tradingDatePattern?: string | null;
  /** Regex whose first capture group is the merchant/terminal number. */
  merchantPattern?: string | null;
};

export type Recognised = {
  acquirerCode: string;
  /** YYYY-MM-DD, or null when the rule does not carry one. */
  tradingDate: string | null;
  merchantNo: string | null;
};

/** A rule with a broken regex must name ITSELF, not throw somewhere downstream
    with a stack trace the operator cannot act on (§2.14). */
const compile = (src: string, who: string): RegExp => {
  try {
    return new RegExp(src, 'i');
  } catch {
    throw new Error(`The bank recognition rule for ${who} is not a valid pattern: ${src}`);
  }
};

export function recogniseAcquirer(
  rules: BankRecognitionRule[],
  movement: { description: string; reference: string | null },
): Recognised | null {
  for (const rule of rules) {
    const where = rule.field ?? 'both';
    const hay = where === 'description' ? movement.description
      : where === 'reference' ? (movement.reference ?? '')
        : `${movement.description} ${movement.reference ?? ''}`;
    if (!compile(rule.pattern, rule.acquirerCode).test(hay)) continue;

    let tradingDate: string | null = null;
    if (rule.tradingDatePattern) {
      const m = compile(rule.tradingDatePattern, rule.acquirerCode).exec(hay);
      /* toIsoDate already tells 17062026 from 20260617 by asking whether the
         leading four digits can be a year — the same reader the acquirer side
         uses, so the two sides can never disagree about a date. */
      if (m?.[1]) tradingDate = toIsoDate(m[1]);
    }
    let merchantNo: string | null = null;
    if (rule.merchantPattern) {
      const m = compile(rule.merchantPattern, rule.acquirerCode).exec(hay);
      if (m?.[1]) merchantNo = m[1];
    }
    return { acquirerCode: rule.acquirerCode, tradingDate, merchantNo };
  }
  return null;
}

/* ── Which of our statements it settles ───────────────────────────────────── */

/** A reconciled merchant statement, waiting for its money. */
export type PayableBatch = {
  id: number;
  acquirerCode: string;
  fileName?: string;
  periodFrom: string;
  periodTo: string;
  /** What the statement should pay in total. */
  payableSen: number;
  /** What is still to come — a statement can be paid in several credits. */
  outstandingSen: number;
};

/** An uploaded payment advice, as matching needs it: the acquirer's own written
    list of which settlement days one credit pays (acc/payout-advice). */
export type PayoutAdviceForMatch = {
  id: number;
  acquirerCode: string;
  fileName: string | null;
  /** The advice's own date — usually the day the credit appears. */
  adviceDate: string | null;
  /** What the bank statement will show as ONE credit. */
  netSen: number;
  days: Array<{ settledOn: string; netSen: number }>;
};

export type BankMatchKind =
  /** One statement, exactly this amount. A button. */
  | 'PAYOUT'
  /** SEVERAL statements that add up to it exactly, and only one way to do it.
      Public Bank's real shape: one advice of 10 Aug paying for trading on the
      7th, 8th and 9th. Still a button, because there is nothing to choose. */
  | 'PAYOUT_SPLIT'
  /** Recognised as a payout, but which statement is a judgement. */
  | 'PAYOUT_UNSURE'
  /** Recognised as a payout, and no reconciled statement expects it. */
  | 'PAYOUT_NO_BATCH'
  /** Not an acquirer's money at all — a supplier, a salary, a deposit. */
  | 'OTHER';

export type BankDecision = {
  movement: BankMovement;
  kind: BankMatchKind;
  acquirerCode: string | null;
  tradingDate: string | null;
  merchantNo: string | null;
  /** Set only for PAYOUT: the one statement this settles. */
  batchId: number | null;
  /** Set only for PAYOUT_SPLIT: the statements that add up to it, and what
      each one takes. Ordered oldest first, the way an advice pays. */
  split: Array<{ batchId: number; amountSen: number }>;
  /** What a person would have to choose between. */
  candidates: PayableBatch[];
  /** One sentence saying why, in the operator's terms. Never a stack trace. */
  clue: string | null;
};

const rm = (sen: number) =>
  `RM ${(sen / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const covers = (b: PayableBatch, day: string) => day >= b.periodFrom && day <= b.periodTo;

/**
 * The statements that add up to one credit, EXACTLY — and only when there is
 * one way to do it.
 *
 * Public Bank's real shape: one advice of 10 Aug pays for trading on the 7th,
 * 8th and 9th (migration 0335's header). Without this the operator is told his
 * credit is too big for the statement he picked and given no way to do the
 * right thing, which is what the rig showed.
 *
 * Two rules, and both are about NOT guessing:
 *
 *   • only an EXACT sum counts. A near-miss is a difference, and a difference
 *     is the thing this module exists to surface, not to absorb;
 *   • if two different sets of statements both add up, nothing is suggested.
 *     "Some three of these five" is not an answer a person can check.
 *
 * Bounded on purpose — subsets of at most 4 from at most 12 statements is 794
 * combinations, and a payout spanning more than four of them is rare enough to
 * be worth a human's eye anyway.
 */
export function exactCombination(batches: PayableBatch[], targetSen: number): PayableBatch[] {
  const MAX_POOL = 12;
  const MAX_PICK = 4;
  /* Oldest first: an advice pays the oldest trading days it covers, and the
     order decides which single answer is reported when several are equal. */
  const pool = [...batches].sort((a, b) => a.periodFrom.localeCompare(b.periodFrom)).slice(0, MAX_POOL);

  const found: PayableBatch[][] = [];
  const walk = (from: number, picked: PayableBatch[], sum: number) => {
    if (found.length > 1) return;                 // already ambiguous, stop
    if (sum === targetSen && picked.length > 1) { found.push([...picked]); return; }
    if (picked.length >= MAX_PICK || from >= pool.length) return;
    for (let i = from; i < pool.length; i += 1) {
      const b = pool[i]!;
      /* Outstanding amounts can be negative (an acquirer clawing a payout
         back), so overshoot is not a safe reason to prune. Depth and pool size
         are what bound this, not the arithmetic. */
      picked.push(b);
      walk(i + 1, picked, sum + b.outstandingSen);
      picked.pop();
      if (found.length > 1) return;
    }
  };
  walk(0, [], 0);

  return found.length === 1 ? found[0]! : [];
}

/**
 * The statements one advice pays, resolved against the statements still owed
 * money — or null when the advice does not answer for this credit.
 *
 * The advice is trusted only when everything lines up: every day it names is
 * covered by a reconciled statement, each statement's outstanding is exactly
 * the advice's figure for its day(s), and the parts reach the advice's own
 * total. Anything less means the books have moved since the advice was written
 * — a report re-opened, a partial credit recorded — and then the advice is
 * history, not an answer, and the search below takes over.
 */
function adviceAllocation(
  advice: PayoutAdviceForMatch, payable: PayableBatch[],
): Array<{ batch: PayableBatch; amountSen: number }> | null {
  const perBatch = new Map<number, { batch: PayableBatch; amountSen: number }>();
  for (const day of advice.days) {
    const batch = payable.find((b) => covers(b, day.settledOn));
    if (!batch) return null;
    const at = perBatch.get(batch.id);
    if (at) at.amountSen += day.netSen;
    else perBatch.set(batch.id, { batch, amountSen: day.netSen });
  }
  const parts = [...perBatch.values()];
  if (parts.length === 0) return null;
  if (parts.some((p) => p.amountSen !== p.batch.outstandingSen)) return null;
  /* Day rows that do not reach the advice's own total are a partial record —
     an allocation built from them would book less than the credit. */
  if (parts.reduce((s, p) => s + p.amountSen, 0) !== advice.netSen) return null;
  /* Oldest first, the way an advice pays. */
  return parts.sort((a, b) => a.batch.periodFrom.localeCompare(b.batch.periodFrom));
}

/**
 * Decide every movement.
 *
 * The order of the tests is the point: a statement is claimed only when ONE
 * candidate can be, and every other outcome says what a person has to look at
 * rather than picking the nearest number. Money is not matched by proximity —
 * and where the acquirer has WRITTEN DOWN what a credit pays (the payment
 * advice), that answer outranks every inference here.
 */
export function matchBankMovements(input: {
  movements: BankMovement[];
  rules: BankRecognitionRule[];
  batches: PayableBatch[];
  /** Uploaded payment advices — the payer's own answers. Optional because only
      Public Bank sends one; every other acquirer is matched by inference. */
  payouts?: PayoutAdviceForMatch[];
}): BankDecision[] {
  const { movements, rules, batches, payouts } = input;

  return movements.map((movement): BankDecision => {
    const base = {
      movement, batchId: null, split: [] as Array<{ batchId: number; amountSen: number }>,
      candidates: [] as PayableBatch[],
      acquirerCode: null, tradingDate: null, merchantNo: null, clue: null,
    };

    /* Money going OUT is never an acquirer paying us. Said here rather than
       relied upon: an acquirer's own charge line reads exactly like its payout
       to a pattern, and only the sign tells them apart. */
    if (movement.amountSen <= 0) return { ...base, kind: 'OTHER' };

    const seen = recogniseAcquirer(rules, movement);
    if (!seen) return { ...base, kind: 'OTHER' };

    const mine = batches.filter((b) => b.acquirerCode === seen.acquirerCode && b.outstandingSen !== 0);
    const named = { ...base, acquirerCode: seen.acquirerCode, tradingDate: seen.tradingDate, merchantNo: seen.merchantNo };

    if (mine.length === 0) {
      return {
        ...named, kind: 'PAYOUT_NO_BATCH', candidates: [],
        clue: `${seen.acquirerCode} paid ${rm(movement.amountSen)}`
          + (seen.tradingDate ? ` for ${seen.tradingDate}` : '')
          + ', and no reconciled report of theirs is waiting for money. Reconcile the merchant report first.',
      };
    }

    /* THE ADVICE, before any inference. Public Bank writes down which days one
       credit pays; when an uploaded advice names this exact amount and its days
       resolve cleanly onto waiting statements, that IS the answer — written by
       the party paying. It is also the only path with no ceiling: a payout
       spanning ten reports needs no combination search, because nobody is
       searching. Two advices for the same amount is the one ambiguity left, and
       the credit's own day settles it or nobody does. */
    const usable = (payouts ?? [])
      .filter((p) => p.acquirerCode === seen.acquirerCode && p.netSen === movement.amountSen)
      .map((p) => ({ advice: p, parts: adviceAllocation(p, mine) }))
      .filter((x): x is { advice: PayoutAdviceForMatch; parts: Array<{ batch: PayableBatch; amountSen: number }> } =>
        x.parts !== null);
    const onAdviceDay = usable.filter((x) => x.advice.adviceDate === movement.bookedOn);
    const answered = usable.length === 1 ? usable[0]! : onAdviceDay.length === 1 ? onAdviceDay[0]! : null;
    if (answered) {
      const { advice, parts } = answered;
      const saying = `${seen.acquirerCode}'s payment advice${advice.adviceDate ? ` of ${advice.adviceDate}` : ''}`;
      if (parts.length === 1) {
        const b = parts[0]!.batch;
        return {
          ...named, kind: 'PAYOUT', batchId: b.id, candidates: [b],
          clue: `${saying} says this ${rm(movement.amountSen)} credit pays ${b.fileName ?? `report ${b.id}`}.`,
        };
      }
      return {
        ...named,
        kind: 'PAYOUT_SPLIT',
        candidates: parts.map((p) => p.batch),
        split: parts.map((p) => ({ batchId: p.batch.id, amountSen: p.amountSen })),
        clue: `${saying} says this ${rm(movement.amountSen)} credit pays ${parts.length} reports — `
          + `${parts.map((p) => `${p.batch.fileName ?? `report ${p.batch.id}`} ${rm(p.amountSen)}`).join(' + ')}.`
          + ' Check them and record it.',
      };
    }

    /* The trading day the bank names is the strongest evidence there is — it
       comes off the statement itself, not from a resemblance between amounts. */
    const onDay = seen.tradingDate ? mine.filter((b) => covers(b, seen.tradingDate!)) : [];
    const pool = onDay.length > 0 ? onDay : mine;
    const exact = pool.filter((b) => b.outstandingSen === movement.amountSen);

    if (exact.length === 1) {
      const b = exact[0]!;
      return {
        ...named, kind: 'PAYOUT', batchId: b.id, candidates: [b],
        clue: `${rm(movement.amountSen)} is exactly what ${b.fileName ?? `report ${b.id}`} is still owed`
          + (seen.tradingDate && covers(b, seen.tradingDate) ? `, and the bank names ${seen.tradingDate}.` : '.'),
      };
    }

    if (exact.length > 1) {
      return {
        ...named, kind: 'PAYOUT_UNSURE', candidates: exact,
        clue: `${exact.length} of ${seen.acquirerCode}'s reports are owed exactly ${rm(movement.amountSen)}. Pick the one this credit is for.`,
      };
    }

    /* No single statement is owed this, so ask whether SEVERAL of them are —
       one advice for three trading days is Public Bank's ordinary behaviour,
       not an exception. Tried against every outstanding statement of the
       acquirer rather than only those covering the named day, because an
       advice's own date names one day and pays for several. */
    const together = exactCombination(mine, movement.amountSen);
    if (together.length > 0) {
      return {
        ...named,
        kind: 'PAYOUT_SPLIT',
        candidates: together,
        split: together.map((b) => ({ batchId: b.id, amountSen: b.outstandingSen })),
        clue: `${together.length} of ${seen.acquirerCode}'s reports add up to ${rm(movement.amountSen)} exactly`
          + ` — ${together.map((b) => `${b.fileName ?? `report ${b.id}`} ${rm(b.outstandingSen)}`).join(' + ')}.`
          + ' Check them and record it.',
      };
    }

    if (onDay.length === 1) {
      const b = onDay[0]!;
      return {
        ...named, kind: 'PAYOUT_UNSURE', candidates: [b],
        /* Both numbers, always. A difference the operator can see is a
           difference he can explain — a chargeback, a second credit still to
           come — and one he cannot see is one he approves blind. */
        clue: `The bank names ${seen.tradingDate}, which is ${b.fileName ?? `report ${b.id}`}`
          + `, but that report is owed ${rm(b.outstandingSen)} and this credit is ${rm(movement.amountSen)}. Check before recording it.`,
      };
    }

    return {
      ...named, kind: 'PAYOUT_UNSURE', candidates: pool,
      clue: `${seen.acquirerCode} paid ${rm(movement.amountSen)}`
        + (seen.tradingDate ? ` for ${seen.tradingDate}` : '')
        + `, and no single report of theirs is owed that. ${pool.length} are still waiting — choose, or record it against more than one.`,
    };
  });
}
