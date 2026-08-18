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
// PRESENTATION ONLY. It changes NOTHING about what counts as valid: the same
// category-mandatory variant axes (so-variant-rule), the same deposit threshold
// (order-rules — per company since 2026-07-31: Houzs 30%, 2990 50%), the same
// past-date / processing-≤-delivery date
// rules. It only aggregates + names them. Pure — no I/O, no DB, no Hono.
// ----------------------------------------------------------------------------
import { REQUIRED_VARIANT_AXES_BY_CATEGORY } from './so-variant-rule';
import { meetsDepositGate, processingDateThresholdFor } from './order-rules';
import { soDatePairRefusal } from './so-processing-date';
import { fmtRM } from './format';

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

/** Canonical axis key → human label for the given category ('legHeight' →
 *  'Leg Height'). Falls back to the raw key if the axis isn't in the rule. */
const axisLabel = (group: string, key: string): string => {
  const axes = REQUIRED_VARIANT_AXES_BY_CATEGORY[(group ?? '').toLowerCase()] ?? [];
  return axes.find((a) => a.key === key)?.label ?? key;
};

export type ProcessingGateFacts = {
  /** Effective processing date on this save (YYYY-MM-DD) or null. */
  procDate: string | null;
  /** Effective delivery date on this save (YYYY-MM-DD) or null. */
  delivDate: string | null;
  /** Malaysia calendar day (YYYY-MM-DD) — the not-in-the-past floor. */
  todayMY: string;
  /** Stored dates BEFORE this save, for the grandfather carve-out on the edit
   *  path: an already-saved past — or unpaired — date this edit does NOT change
   *  is a historical record, not a fresh entry, and must not block. Omit (leave
   *  undefined) on the create path — every date there is new. */
  origProcDate?: string | null;
  origDelivDate?: string | null;
  /** Lines whose category-mandatory variants aren't filled — exactly what the
   *  routes get from findIncompleteVariantLines. */
  variantOffenders?: readonly VariantOffenderLike[];
  /** Lines whose fabric colour is still KIV (findColourKivLines). Owner rule
   *  2026-07-24 (after SO-2607-016): the moment an SO carries a Processing
   *  Date, every line must be a fully-confirmed maintained selection — a
   *  colour-KIV line blocks the date. Routes must pass this ONLY when the save
   *  genuinely SETS or CHANGES processing_date (the offenders are ignored
   *  when procDate is null, and clearing the date never blocks), so editing
   *  e.g. a remark on an old KIV order still works. */
  kivOffenders?: readonly ColourKivOffenderLike[];
  /** Deposit-vs-total for the 30% gate, SAME unit on both sides (centi on the
   *  server). Omit / null when the gate doesn't apply on this path (the
   *  consignment mirror has no deposit gate). The shortfall is reported only
   *  when a processing date is actually being set. */
  deposit?: { paidCenti: number; totalCenti: number } | null;
  /** Active company ('HOUZS' | '2990') — picks the deposit threshold. Absent
   *  falls back to the looser 30%; see processingDateThresholdFor. */
  companyCode?: string | null;
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
 *  money gate, then the date rules. [] = the save clears every gate.
 *
 *  Each gate here is the SAME predicate the routes used to `return` on — see the
 *  per-branch comments. Nothing new is rejected; failures are just collected. */
export function collectProcessingGateProblems(facts: ProcessingGateFacts): SaveProblem[] {
  const out: SaveProblem[] = [];

  // 1. Category-mandatory variants — one problem per (line, missing axis) so the
  //    UI can name the exact line AND the exact field to fill. Mirrors the
  //    routes' findIncompleteVariantLines → 409 variants_incomplete.
  //    A line that is colour-KIV also reads as "fabricCode missing" here; the
  //    KIV problem below explains that state better ("confirm the colour", not
  //    "Fabrics is required"), so the bare fabricCode axis is suppressed for
  //    those lines to avoid double-reporting the same field.
  const kivLines = new Set((facts.kivOffenders ?? []).map((o) => o.itemCode));
  for (const off of facts.variantOffenders ?? []) {
    for (const key of off.missing) {
      if (key === 'fabricCode' && kivLines.has(off.itemCode)) continue;
      const label = axisLabel(off.group, key);
      out.push({
        code: 'variants_incomplete',
        message: `${off.itemCode} — ${label} is required`,
        line: off.itemCode,
        field: label,
      });
    }
  }

  // 1b. Colour KIV — the line committed to a fabric SERIES with the colour
  //     confirmed later (variants carry fabricId/fabricLabel, no fabricCode).
  //     Owner rule 2026-07-24 (verbatim intent: "如果它一有 processing date,
  //     就一定要有我们维护里面的选项,不能这样子随便选,要不然我们过不到单"),
  //     after SO-2607-016 reached production planning with two KIV sofa lines
  //     and the factory could not proceed. Only fires when a Processing Date is
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

  // 1c. Customer + delivery completeness. Unified with the Proceed gate (owner
  //     2026-07-31) — the Processing Date IS the signal that releases the order
  //     to purchasing, so the same facts must be present for either. Only when a date is being SET;
  //     clearing it, or editing something else on a dated order, never blocks.
  if (facts.procDate && facts.completeness) {
    const { hasCustomerName, hasAddress, hasPostcode } = facts.completeness;
    if (!hasCustomerName) {
      out.push({ code: 'processing_date_incomplete', message: 'Customer name is required before a Processing Date can be set', field: 'Customer' });
    }
    if (!hasAddress) {
      out.push({ code: 'processing_date_incomplete', message: 'Delivery address line 1 is required before a Processing Date can be set', field: 'Address' });
    }
    if (!hasPostcode) {
      out.push({ code: 'processing_date_incomplete', message: 'Delivery postcode is required before a Processing Date can be set', field: 'Postcode' });
    }
    if (!facts.delivDate) {
      out.push({ code: 'processing_date_incomplete', message: 'A delivery date is required before a Processing Date can be set', field: 'Delivery date' });
    }
  }

  // 2. Deposit — a Processing Date releases the order to purchasing to go and
  //    order the goods, so it can't be set until >=30% is collected. Reported with the concrete
  //    amount + threshold. The SAME predicate the Proceed gate weighs
  //    (meetsDepositGate) — one deposit rule, since setting the date IS
  //    proceeding. Only fires when a date is actually being set.
  if (facts.deposit && facts.procDate) {
    const { paidCenti, totalCenti } = facts.deposit;
    /* Per company (owner 2026-07-31: Houzs 30%, 2990 50%). The threshold is read
       ONCE and used for the verdict, the percentage in the message and the
       amount in the message — a 2990 operator refused at 50% must not be told
       "30%", which is what a hard-coded constant here would print. */
    const threshold = processingDateThresholdFor(facts.companyCode);
    if (!meetsDepositGate(paidCenti, totalCenti, facts.companyCode)) {
      const pct = Math.round(threshold * 100);
      const neededCenti = Math.ceil(totalCenti * threshold);
      out.push({
        code: 'processing_date_unpaid',
        // fmtRM takes whole-MYR — the ledger is centi, so divide by 100.
        message: `Deposit ${fmtRM(Math.round(paidCenti / 100))} of ${fmtRM(Math.round(neededCenti / 100))} needed (${pct}%) before a Processing Date can be set`,
        field: 'Deposit',
      });
    }
  }

  // 3. Date rules. A freshly-typed / moved past date is rejected; an unchanged
  //    already-past date is grandfathered (proc/deliv !== their originals).
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
  // Factory start can't fall after the promised delivery. Both plain ISO
  // YYYY-MM-DD, so a string compare is correct.
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
