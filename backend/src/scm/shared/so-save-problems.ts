// ----------------------------------------------------------------------------
// so-save-problems — collect EVERY Processing-Date / save gate failure into ONE
// list, so the operator sees all the reasons at once instead of fixing them one
// at a time.
//
// Why this exists (owner 2026-07-18): setting a Processing Date (or saving a
// confirmed SO) ran the gates SEQUENTIALLY — the routes `return`ed on the FIRST
// failing gate, so the owner fixed one thing, saved, hit the NEXT gate, saved
// again, hit the next. The backend already knew WHICH line + WHICH variant + the
// deposit shortfall; it just never reported more than one at a time. This
// re-expresses the gates the routes already compute as a flat problem list.
//
// PRESENTATION ONLY, with ONE exception recorded below. It changes nothing
// about what counts as valid: the same category-mandatory variant axes
// (so-variant-rule), the same past-date / processing-≤-delivery date rules. It
// only aggregates + names them. Pure — no I/O, no DB, no Hono.
//
// THE EXCEPTION: the deposit is no longer a condition of the Processing-Date
// gate at all (owner ruling 2026-08-20, 「以电脑为准 —— 两边都不查」). That is a
// rule change, not a presentation change, and it is stated at step 2 of
// collectProcessingGateProblems. The deposit still has words here — the PROCEED
// refusal at the bottom of this file renders them — but the save gate has no
// money condition to report.
//
// SINCE 2026-08-18 it also builds the PROCEED refusal (collectProceedGateProblems
// / proceedGateUnmetBody, at the bottom of this file). Same reason, same shape:
// that refusal was one stored sentence naming all five gate conditions, returned
// whenever any single one failed. It belongs here rather than in a second module
// so the two surfaces of one rule cannot grow two vocabularies.
// ----------------------------------------------------------------------------
import { REQUIRED_VARIANT_AXES_BY_CATEGORY } from './so-variant-rule';
import {
  meetsDepositGate,
  processingDateThresholdFor,
  proceedGateFailures,
  type ProceedGateCondition,
} from './order-rules';
import { soDatePairRefusal } from './so-processing-date';
import { fmtSen } from './format';

/** One machine- + human-readable reason a save was rejected.
 *  - `code`  — stable gate identifier (mirrors the legacy single-error codes:
 *              variants_incomplete / processing_date_unpaid / processing_date_past
 *              / delivery_date_past / processing_after_delivery), so any consumer
 *              can still branch on it.
 *  - `message` — the plain-language sentence the operator reads (already 白话文).
 *  - `line`  — the offending item code, when the problem is line-specific.
 *  - `field` — the concrete input to fix (a variant axis label, a date, or the
 *              deposit), so the UI can name / anchor it. */
export type SaveProblem = { code: string; message: string; line?: string; field?: string };

/** Offender shape produced by findIncompleteVariantLines — kept structural here
 *  so this pure module never imports from the routes/lib layer (avoids a shared↔
 *  lib import cycle). `missing` carries canonical axis keys (e.g. 'legHeight'). */
export type VariantOffenderLike = {
  itemCode: string;
  group: string;
  missing: readonly string[];
};

/** Offender shape produced by findColourKivLines — structural for the same
 *  reason as VariantOffenderLike. A line here committed to a fabric SERIES
 *  (fabricLabel, e.g. "EZ") but its COLOUR is still KIV (no fabricCode). */
export type ColourKivOffenderLike = {
  itemCode: string;
  fabricLabel?: string;
};

const axisLabel = (group: string, key: string): string => {
  const axes = REQUIRED_VARIANT_AXES_BY_CATEGORY[(group ?? '').toLowerCase()] ?? [];
  return axes.find((a) => a.key === key)?.label ?? key;
};

/* ── ONE VOCABULARY FOR THE UNIFIED GATE ───────────────────────────────────
   The four completeness conditions and the deposit are ONE rule with TWO
   surfaces: the aggregated save report (a Processing Date is being set) and the
   proceed refusal (someone pressed Proceed). Owner 2026-07-31 — a Processing
   Date IS Proceed — so they must never disagree about wording any more than
   about verdict, and the way to guarantee that is one table, not two lists that
   look alike today.

   Only the trailing clause differs, because the two operators are looking at
   different controls: one is filling in a date field, the other has already
   pressed a button. Saying "before a Processing Date can be set" to the second
   one names a box he is not in — the order he pressed Proceed on already HAS
   its date (mfg-sales-orders.ts only runs the proceed gate on that branch). */
type GateAct = 'processing_date' | 'proceed';

const ACT_CLAUSE: Record<GateAct, string> = {
  processing_date: 'before a Processing Date can be set',
  proceed: 'before this order can be proceeded',
};

const CONDITION_SUBJECT: Record<Exclude<ProceedGateCondition, 'deposit'>, { subject: string; field: string }> = {
  customer_name: { subject: 'Customer name is required',            field: 'Customer' },
  address:       { subject: 'Delivery address line 1 is required',  field: 'Address' },
  postcode:      { subject: 'Delivery postcode is required',        field: 'Postcode' },
  delivery_date: { subject: 'A delivery date is required',          field: 'Delivery date' },
};

const randomColourHint = (itemCode: string, axisKey: string): string =>
  axisKey === 'fabricCode' && /^SQUARE PILLOW(?!.*RDM)/i.test(itemCode.trim())
    ? '. No colour chosen? Use the random-colour pillow SKU instead'
    : '';

const completenessProblem = (
  cond: Exclude<ProceedGateCondition, 'deposit'>,
  act: GateAct,
): SaveProblem => ({
  code: 'processing_date_incomplete',
  message: `${CONDITION_SUBJECT[cond].subject} ${ACT_CLAUSE[act]}`,
  field: CONDITION_SUBJECT[cond].field,
});

const depositProblem = (
  paidSen: number,
  totalSen: number,
  companyCode: string | null | undefined,
  act: GateAct,
): SaveProblem | null => {
  if (meetsDepositGate(paidSen, totalSen, companyCode)) return null;
  /* Per company (owner 2026-07-31: Houzs 30%, 2990 50%). The threshold is read
     ONCE and used for the percentage in the message and the amount in the
     message — a 2990 operator refused at 50% must not be told "30%", which is
     what a hard-coded constant here would print. */
  const threshold = processingDateThresholdFor(companyCode);
  const pct = Math.round(threshold * 100);
  const neededSen = Math.ceil(totalSen * threshold);
  return {
    code: 'processing_date_unpaid',
    message: `Deposit ${fmtSen(paidSen)} of ${fmtSen(neededSen)} needed (${pct}%) ${ACT_CLAUSE[act]}`,
    field: 'Deposit',
  };
};

export type ProcessingGateFacts = {
  procDate: string | null;
  delivDate: string | null;
  todayMY: string;
  origProcDate?: string | null;
  origDelivDate?: string | null;
  variantOffenders?: readonly VariantOffenderLike[];
  kivOffenders?: readonly ColourKivOffenderLike[];
  /* NO `deposit`, AND NO `companyCode` — owner ruling 2026-08-20, 「以电脑为准
     —— 两边都不查」. The money condition used to live here and it is GONE, not
     merely unfed: see "THE DEPOSIT IS NOT A CONDITION OF THIS GATE" in the
     collector below for why the field was deleted rather than left accepted-and-
     ignored. `companyCode` went with it — it existed only to pick the deposit
     fraction (processingDateThresholdFor), and nothing else here reads it. */
  /** Customer / delivery completeness, for the UNIFIED gate (owner 2026-07-31:
   *  Processing Date IS Proceed, one rule). These were required to Proceed but
   *  NOT to set a Processing Date; now both ask the same question. Email is
   *  deliberately absent — the owner dropped it, and it was the only field
   *  anything actually lacked (12 of 63 live orders; zero lacked these four).
   *  Omit (undefined) on a path that has no customer facts to offer; the gate
   *  then does not report them rather than inventing a failure. */
  completeness?: {
    hasCustomerName: boolean;
    hasAddress: boolean;
    hasPostcode: boolean;
  } | null;
};

/** Every reason THIS save fails its Processing-Date gates, in the order the
 *  operator reads them: the concrete line+axis variant gaps first, then the
 *  customer/delivery completeness, then the date rules. [] = the save clears
 *  every gate.
 *
 *  There is no money step. Step 2 is where the deposit condition WAS, and it
 *  states the owner's 2026-08-20 ruling that removed it — kept as a numbered
 *  step so the next reader learns the gate lost a condition on purpose rather
 *  than wondering why the list jumps from 1c to 3. */
export function collectProcessingGateProblems(facts: ProcessingGateFacts): SaveProblem[] {
  const out: SaveProblem[] = [];

  const kivLines = new Set((facts.kivOffenders ?? []).map((o) => o.itemCode));
  for (const off of facts.variantOffenders ?? []) {
    for (const key of off.missing) {
      if (key === 'fabricCode' && kivLines.has(off.itemCode)) continue;
      const label = axisLabel(off.group, key);
      out.push({
        code: 'variants_incomplete',
        message: `${off.itemCode} — ${label} is required${randomColourHint(off.itemCode, key)}`,
        line: off.itemCode,
        field: label,
      });
    }
  }

  // 1b. Colour KIV — the line committed to a fabric SERIES with the colour
  //     confirmed later (variants carry fabricId/fabricLabel, no fabricCode).
  //     Owner rule 2026-07-24 (verbatim intent: "如果它一有 processing date,
  //     就一定要有我们维护里面的选项,不能这样子随便选,要不然我们过不到单"),
  //     after an SO was released for ordering with two KIV sofa lines and
  //     purchasing had nothing to order against — a fabric series with no colour
  //     is not a thing anyone can buy. Only fires when a Processing Date is
  //     actually being set on this save — the routes additionally pass
  //     kivOffenders only when the date genuinely changes, so an unrelated edit
  //     to an old KIV order (or clearing the date) is never blocked.
  if (facts.procDate) {
    for (const off of facts.kivOffenders ?? []) {
      const series = (off.fabricLabel ?? '').trim();
      out.push({
        code: 'fabric_colour_kiv',
        message: `${off.itemCode} — fabric colour is still KIV${series ? ` (${series})` : ''}. Confirm the colour before setting the Processing Date.`,
        line: off.itemCode,
        field: 'Fabrics',
      });
    }
  }

  if (facts.procDate && facts.completeness) {
    const { hasCustomerName, hasAddress, hasPostcode } = facts.completeness;
    if (!hasCustomerName) out.push(completenessProblem('customer_name', 'processing_date'));
    if (!hasAddress) out.push(completenessProblem('address', 'processing_date'));
    if (!hasPostcode) out.push(completenessProblem('postcode', 'processing_date'));
    if (!facts.delivDate) out.push(completenessProblem('delivery_date', 'processing_date'));
  }

  /* 2. THE DEPOSIT IS NOT A CONDITION OF THIS GATE — owner ruling, 2026-08-20.
     ────────────────────────────────────────────────────────────────────────
     His words: 「以电脑为准 —— 两边都不查」. The desktop is the standard, and
     NEITHER surface checks the money any more.

     This step used to weigh the company's deposit fraction (Houzs 30%, 2990
     50%) and refuse `processing_date_unpaid`. What that produced in practice
     was a rule that depended on WHICH SCREEN you were on rather than on the
     order: the desktop New-SO screen sent a bare `manualEntry: true` on every
     create and had the condition dropped for it, the phone sent nothing and was
     refused the identical order, and the header-edit path waived nothing at all
     — so a desktop-created RM 0 order saved on Monday and was refused on its
     first edit on Tuesday, with no hint why.

     DELETED, NOT DISABLED, and the difference is the point. Leaving
     `ProcessingGateFacts.deposit` in place with nobody feeding it would leave a
     live-looking money gate and three callers passing null — the exact shape a
     future edit "restores" by accident. The condition is removed HERE, where it
     was decided, so both surfaces get the same answer from one place and a
     reader can see it was a decision rather than an omission.

     WHAT IS DELIBERATELY UNCHANGED. The other four conditions below and above
     still refuse: an order with no customer, no address line 1, no postcode or
     no delivery date still cannot carry a Processing Date. The owner removed
     the money condition, not the releasable-order conditions — purchasing
     ordering goods for an address nobody has is a different failure.

     `depositProblem` above is still live: `collectProceedGateProblems` renders
     it for the proceed refusal. That path is an ORPHAN (soProceedGateBlocked
     has had no callers since 2026-08-18) so it refuses nothing today, and it is
     out of this ruling's scope — but it IS the trap for whoever wires a future
     proceed path, and it is flagged in docs/modules/sales-order.md. */

  const { procDate, delivDate, todayMY } = facts;
  const origProc = facts.origProcDate ?? null;
  const origDeliv = facts.origDelivDate ?? null;

  if (procDate && procDate < todayMY && procDate !== origProc) {
    out.push({
      code: 'processing_date_past',
      message: 'Processing Date cannot be in the past — today or a future date only.',
      field: 'Processing Date',
    });
  }
  if (delivDate && delivDate < todayMY && delivDate !== origDeliv) {
    out.push({
      code: 'delivery_date_past',
      message: 'Delivery Date cannot be in the past — today or a future date only.',
      field: 'Delivery Date',
    });
  }
  /* "Both dates or neither" (owner, restated 2026-08-13), BOTH directions, from
     the one shared predicate in shared/so-processing-date rather than a local
     compare. This block used to ask only the delivery→processing direction; the
     reverse lived in 1c above and is gated on `facts.completeness`, which the
     consignment paths do not supply — so on those paths a Processing Date with
     no Delivery Date raised nothing at all. Grandfathering (a stored unpaired
     pair this save leaves exactly as it found it) is inside the predicate: 19
     live orders are honestly unpaired, and an edit that touches neither date
     must still save.

     Suppressed when 1c already named the missing delivery date — the same fact
     told twice reads as two things to fix. */
  const pairAlreadyReported = out.some(
    (p) => p.code === 'processing_date_incomplete' && p.field === 'Delivery date',
  );
  if (!pairAlreadyReported && soDatePairRefusal({
    nextProc: procDate, nextDeliv: delivDate, origProc, origDeliv,
  })) {
    out.push({
      code: 'processing_delivery_must_pair',
      message: procDate
        ? 'A Delivery Date is required when a Processing Date is set — set both, or leave both empty.'
        : 'A Processing Date is required when a Delivery Date is set — set both, or leave both empty.',
      field: procDate ? 'Delivery Date' : 'Processing Date',
    });
  }
  if (procDate && delivDate && procDate > delivDate) {
    out.push({
      code: 'processing_after_delivery',
      message: 'Processing Date cannot be later than the Delivery Date.',
      field: 'Processing Date',
    });
  }

  return out;
}

/** Build the aggregated HTTP body the routes return in place of the old
 *  single-error responses. Callers do:
 *    const problems = collectProcessingGateProblems(facts);
 *    if (problems.length) return c.json(validationFailedBody(problems), 422);
 *  `message` stays a single plain sentence for any surface that only reads
 *  `message` (mobile scan, PDF, un-migrated clients) — the full list is in
 *  `problems`. */
export function validationFailedBody(problems: SaveProblem[]): {
  error: 'validation_failed';
  message: string;
  problems: SaveProblem[];
} {
  const message =
    problems.length === 1
      ? problems[0]!.message
      : `${problems.length} things need fixing before this can be saved.`;
  return { error: 'validation_failed', message, problems };
}

// ---------------------------------------------------------------------------
// THE PROCEED REFUSAL — the same aggregation, for the other surface of the same
// rule.
//
// WHAT WAS WRONG. The two proceed paths returned ONE stored sentence naming ALL
// FIVE conditions whenever ANY ONE failed. On 2026-08-17 the owner hit it on a
// ZERO-TOTAL order, read the word "deposit" in it, and concluded the system was
// demanding 50% of nothing. It was not: meetsDepositGate is vacuously true at
// total <= 0 and says so in its own docblock, so the deposit term had PASSED —
// the order was missing its postcode. The refusal cost a day of wrong diagnosis
// because it could not say which of the five had failed.
//
// This is NOT a second dialect. It reads the same condition list the gate itself
// is defined as (proceedGateFailures), renders it through the same two emitters
// the aggregated save report renders, and ships it under the same `problems`
// key the frontend already understands (parseSaveProblems / humanApiError,
// owner 2026-07-18). The only thing that is proceed-specific is the trailing
// clause of each sentence.
// ---------------------------------------------------------------------------

/** Proceed-gate facts, in the unit the MESSAGES need.
 *
 *  Deliberately not ProceedGateInput: that type's `paid`/`total` are ratio-only
 *  by contract ("whole-MYR on the POS, centi on the server"), which is fine for
 *  a boolean and wrong for a printed amount. Here the numbers reach fmtRM, so
 *  the unit is pinned in the field names — a caller cannot hand over whole-MYR
 *  and quietly print "Deposit RM 3 of RM 300 needed". */
export type ProceedGateFacts = {
  hasCustomerName: boolean;
  hasAddress: boolean;
  hasPostcode: boolean;
  hasDeliveryDate: boolean;
  paidSen: number;
  totalSen: number;
  companyCode?: string | null;
};

/** EVERY condition of the proceed gate this order fails, and only those.
 *  [] means the gate is met — and that is not a parallel reading of the rule
 *  but THE rule: meetsProceedGate is itself defined as
 *  `proceedGateFailures(...).length === 0`, so the refusal and the verdict
 *  cannot disagree about a single input. Order matches the form (identity,
 *  address, date, money). */
export function collectProceedGateProblems(f: ProceedGateFacts): SaveProblem[] {
  const out: SaveProblem[] = [];
  const failures = proceedGateFailures({
    hasCustomerName: f.hasCustomerName,
    hasAddress: f.hasAddress,
    hasPostcode: f.hasPostcode,
    hasDeliveryDate: f.hasDeliveryDate,
    paid: f.paidSen,
    total: f.totalSen,
    companyCode: f.companyCode,
  });
  for (const cond of failures) {
    if (cond !== 'deposit') {
      out.push(completenessProblem(cond, 'proceed'));
      continue;
    }
    const shortfall = depositProblem(f.paidSen, f.totalSen, f.companyCode, 'proceed');
    if (shortfall) out.push(shortfall);
  }
  return out;
}

/** The HTTP body the proceed paths refuse with.
 *
 *  `error` STAYS `proceed_gate_unmet` — clients match on it, so this is purely
 *  additive. `reason` keeps its place and its type (a plain sentence) for any
 *  surface that reads only that key; what changed is that it now names what
 *  actually failed instead of reciting all five conditions. `problems` is the
 *  established aggregated contract (validationFailedBody's key, parsed by
 *  frontend parseSaveProblems), so every surface that already renders a full
 *  problem list renders this one with no client change. */
export function proceedGateUnmetBody(problems: SaveProblem[]): {
  error: 'proceed_gate_unmet';
  reason: string;
  problems: SaveProblem[];
} {
  return { error: 'proceed_gate_unmet', reason: proceedGateReason(problems), problems };
}

const proceedGateReason = (problems: SaveProblem[]): string =>
  problems.length > 0
    ? problems.map((p) => p.message).join('; ')
    : 'This order cannot be proceeded yet.';
