// ----------------------------------------------------------------------------
// migrated-chain — the rules for converting a document CARRIED OVER from
// AutoCount into the invoice AutoCount already raised from it.
//
// Owner 2026-08-11: our migrated GRNs become purchase invoices, our migrated DOs
// become sales invoices, so the ERP's relationship map has the same shape as
// AutoCount's. He narrowed it twice — "我说的是我们ERP 的DO to Invoice / 我们ERP的
// GR to PI" and "而不是全部" — so this is about OUR documents, not an import of
// AutoCount's 4,789 purchase-invoice / 9,245 sales-invoice history.
//
// This module holds the DECISIONS, with no database in them, so the batch
// converter (backend/scripts/create-migrated-invoices.mjs) and the operator's
// own convert button (routes/purchase-invoices.ts, routes/sales-invoices.ts)
// cannot drift apart.
//
// ── THE ONE THING THAT MAKES THIS SAFE ───────────────────────────────────────
// A migrated document is a PARTIAL mirror. The cutover imported the OUTSTANDING
// part of a delivery, not the whole of it: measured against the live book on
// 2026-08-11, 21 of our 25 migrated delivery orders carry FEWER lines than the
// AutoCount delivery they mirror (HC-DO-000608 has 3 rows against AutoCount's
// 10). So "our document" and "AutoCount's document" are not the same document,
// and an invoice built from ours cannot be assumed to bill what AutoCount
// billed.
//
// There is no line-to-line key to reconcile them with either — AutoCount
// populates none (PIDTL.FromDocDtlKey 0 of 20,777, IVDTL.FromDocDtlKey 0 of
// 43,522). What DOES exist is the invoice TOTAL, on both sides. So the gate is
// arithmetic rather than trust: an invoice is written only when the total we
// would write equals the total AutoCount actually billed, to the sen. A
// document that clears that test is provably right; one that fails it is
// reported with BOTH numbers and left alone. A blank is visible and a gate
// refuses it; a plausible wrong number is silent forever.
//
// ── THE FIVE RULES ───────────────────────────────────────────────────────────
//
// 1. ONE ERP INVOICE PER AUTOCOUNT INVOICE, NUMBERED FROM IT.
//    Every document carried over keeps AutoCount's number (owner's standing
//    rule, twice on 2026-08-10, enforced by check-migrated-numbering). An
//    AutoCount invoice routinely spans several of our documents — PI-000832
//    covers both HC-GR-000201-PO-000273 and HC-GR-000201-PO-000275, and
//    I-2602-0288 covers both HC-DO-008833 and HC-DO-009888 — so it mirrors as
//    ONE ERP invoice drawing lines from all of them. Minting a fresh
//    PI-YYMM-NNNN would leave a human holding an AutoCount invoice that finds
//    nothing in the ERP.
//
// 2. ONLY WHAT AUTOCOUNT ACTUALLY INVOICED.
//    Measured 2026-08-11 against live AED_HOUZS: 43 of 291 migrated GRNs have
//    an AutoCount receipt that was never invoiced, 12 more have no derivable
//    AutoCount receipt number at all, and 3 of 25 migrated DOs were never
//    invoiced (HC-DO-007466, HC-DO-007525, HC-DO-008624). Inventing paperwork
//    for those would put a document in the ERP that exists nowhere else. A
//    CANCELLED AutoCount invoice counts as "not invoiced" and is a distinct
//    answer from "never invoiced" — both are refused, separately named.
//
// 3. REFUSE A DUPLICATED SOURCE LINE.
//    EIGHT of the 25 migrated delivery orders carry the same so_item_id on two
//    or more rows — 18 extra rows and 28 extra units in all: HC-DO-005452 (12
//    rows against AutoCount's 6, every order line twice, 24 units against 12),
//    HC-DO-007525 (one order line on 6 rows), HC-DO-006224, and HC-DO-004868 /
//    004903 / 009013 / 010008 / 010222 with one duplicate each. Proven against
//    the live book: AutoCount's DO-005452 holds six lines, each once.
//    Invoicing ours would bill a customer RM 14,600.00 for the RM 7,300.00
//    AutoCount billed. It is a defect in the migrated data, refused and named
//    here rather than silently halved — halving guesses which row was real.
//
//    NOTE what this rule does NOT refuse: a document whose line COUNT merely
//    differs from AutoCount's. HC-DO-008833 has 3 rows against AutoCount's 2 and
//    is converted, because its three rows are three distinct order lines and the
//    money reconciles exactly (RM 4,388.00 both sides). Different line shape,
//    same invoice, is normal — the compartment split alone guarantees it.
//
// 4. THE TOTAL MUST EQUAL AUTOCOUNT'S.
//    See above. This subsumes the unpriced-line problem without being fooled by
//    it in either direction: a genuinely free line (AutoCount bills RM 0 for the
//    pillow that came with the bed) passes, while a line whose price the cutover
//    simply failed to carry fails, because the total then falls short. Both
//    matter here — 42 of 59 migrated DO lines and 483 of 496 migrated GRN lines
//    carry no price on the document or on the order line behind it.
//
//    This rule also disposes of PARTIAL coverage without needing its own gate.
//    An AutoCount invoice spanning four receipts of which we migrated one bills
//    four receipts' worth; our one receipt cannot reach that total, so the group
//    is refused rather than written short.
//
// 5. ONE INVOICE, ONE PARTY.
//    Rule 1 merges several of our documents into one invoice — 309 of 4,789
//    AutoCount purchase invoices and 568 of 9,245 sales invoices span more than
//    one source document, so this is the common case, not an edge one. The
//    merged header carries exactly ONE supplier / debtor, and which one it would
//    carry is decided by document-number sort order. Sort order is not evidence.
//    A group whose sources disagree on the party is refused and named.
// ----------------------------------------------------------------------------

export type MigratedInvoiceKind = 'PI' | 'SI';

/** One line of a migrated GRN / DO, already net of anything invoiced or returned. */
export type MigratedSourceLine = {
  lineId: string;
  itemCode: string;
  qty: number;
  unitPriceSen: number;
  discountSen?: number;
  sourceLineKey?: string | null;
};

/** A migrated GRN or DO, with the AutoCount invoices raised from it. */
export type MigratedSourceDoc = {
  docNo: string;
  acDocNo: string | null;
  acInvoiceNos: string[];
  acCancelledInvoiceNos?: string[];
  partyKey?: string | null;
  lines: MigratedSourceLine[];
};

export type MigratedGateReason =
  | 'ok'
  | 'no_autocount_document'
  | 'no_autocount_invoice'
  | 'autocount_invoice_cancelled'
  | 'ambiguous_autocount_invoices'
  | 'nothing_to_invoice'
  | 'duplicate_source_lines'
  | 'party_disagrees_across_sources'
  | 'total_disagrees_with_autocount';

export type MigratedInvoicePlan = {
  acInvoiceNo: string;
  invoiceNumber: string;
  sourceDocNos: string[];
  lineCount: number;
  qty: number;
  valueSen: number;
  acValueSen: number;
  unpricedLines: number;
  eligible: boolean;
  reason: MigratedGateReason;
};

export type MigratedBlockedSource = {
  docNo: string;
  acDocNo: string | null;
  acInvoiceNos: string[];
  reason: MigratedGateReason;
  lineCount: number;
  unpricedLines: number;
  valueSen?: number;
  acValueSen?: number;
};

export type MigratedPlanResult = {
  plans: MigratedInvoicePlan[];
  blocked: MigratedBlockedSource[];
};

export const MIGRATED_NUMBER_PREFIX = 'HC-';

/**
 * The document number for anything carried over from AutoCount: AutoCount's own
 * number with the house prefix. Same shape as the migrated SO / PO / GRN / DO
 * numbers that check-migrated-numbering already enforces, and it now enforces
 * this one too.
 */
export function migratedInvoiceNumber(acInvoiceNo: string): string {
  return `${MIGRATED_NUMBER_PREFIX}${acInvoiceNo.trim()}`;
}

export function lineValueSen(l: MigratedSourceLine): number {
  return Math.max(0, Math.round(l.qty * l.unitPriceSen) - Math.round(l.discountSen ?? 0));
}

/** Rule 3: the same order line on two rows of one document. */
export function duplicateSourceLineKeys(lines: MigratedSourceLine[]): string[] {
  const seen = new Map<string, number>();
  for (const l of lines) {
    const k = l.sourceLineKey;
    if (!k) continue;
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k).sort();
}

/**
 * Group migrated source documents into the invoices AutoCount already raised.
 *
 * `acInvoiceTotalSen` is what AutoCount billed, keyed by its invoice number.
 * An invoice we cannot look up a total for is refused rather than written — a
 * missing cross-check is not a passing cross-check.
 *
 * `allowTotalMismatch` exists only so the gate can be demonstrated from both
 * sides in a test; the routes never set it and the converter's default run
 * never sets it.
 */
export function planMigratedInvoices(
  sources: MigratedSourceDoc[],
  acInvoiceTotalSen: Record<string, number> | Map<string, number>,
  opts: { allowTotalMismatch?: boolean } = {},
): MigratedPlanResult {
  const acTotal = (k: string): number | undefined =>
    acInvoiceTotalSen instanceof Map ? acInvoiceTotalSen.get(k) : acInvoiceTotalSen[k];

  const blocked: MigratedBlockedSource[] = [];
  const groups = new Map<string, MigratedSourceDoc[]>();

  const block = (s: MigratedSourceDoc, reason: MigratedGateReason) => blocked.push({
    docNo: s.docNo,
    acDocNo: s.acDocNo,
    acInvoiceNos: s.acInvoiceNos,
    reason,
    lineCount: s.lines.length,
    unpricedLines: s.lines.filter((l) => !(l.unitPriceSen > 0)).length,
  });

  for (const s of sources) {
    if (!s.acDocNo) { block(s, 'no_autocount_document'); continue; }
    if (duplicateSourceLineKeys(s.lines).length > 0) { block(s, 'duplicate_source_lines'); continue; }
    const invoiceable = s.lines.filter((l) => l.qty > 0);
    if (invoiceable.length === 0) { block(s, 'nothing_to_invoice'); continue; }
    const acs = [...new Set(s.acInvoiceNos.map((x) => x.trim()).filter(Boolean))].sort();
    if (acs.length === 0) {
      block(s, (s.acCancelledInvoiceNos ?? []).length > 0
        ? 'autocount_invoice_cancelled' : 'no_autocount_invoice');
      continue;
    }
    if (acs.length > 1) { block(s, 'ambiguous_autocount_invoices'); continue; }
    const g = groups.get(acs[0]!) ?? [];
    g.push({ ...s, lines: invoiceable });
    groups.set(acs[0]!, g);
  }

  const plans: MigratedInvoicePlan[] = [];
  for (const [acInvoiceNo, docs] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const lines = docs.flatMap((d) => d.lines);
    const valueSen = lines.reduce((t, l) => t + lineValueSen(l), 0);
    const acValueSen = acTotal(acInvoiceNo) ?? -1;
    const parties = [...new Set(docs.map((d) => d.partyKey).filter((p): p is string => !!p))];
    const partySplit = parties.length > 1;
    const eligible = !partySplit
      && (opts.allowTotalMismatch === true || (acValueSen >= 0 && acValueSen === valueSen));
    const reason: MigratedGateReason = eligible ? 'ok'
      : partySplit ? 'party_disagrees_across_sources' : 'total_disagrees_with_autocount';
    if (!eligible) {
      for (const d of docs) {
        blocked.push({
          docNo: d.docNo,
          acDocNo: d.acDocNo,
          acInvoiceNos: [acInvoiceNo],
          reason,
          lineCount: d.lines.length,
          unpricedLines: d.lines.filter((l) => !(l.unitPriceSen > 0)).length,
          valueSen,
          acValueSen,
        });
      }
    }
    plans.push({
      acInvoiceNo,
      invoiceNumber: migratedInvoiceNumber(acInvoiceNo),
      sourceDocNos: docs.map((d) => d.docNo).sort(),
      lineCount: lines.length,
      qty: lines.reduce((t, l) => t + l.qty, 0),
      valueSen,
      acValueSen,
      unpricedLines: lines.filter((l) => !(l.unitPriceSen > 0)).length,
      eligible,
      reason,
    });
  }
  return { plans, blocked };
}


export const MIGRATED_WRITEBACK_SKIP_REASON =
  'carried over from AutoCount at the 2026-08 cutover — the invoice this mirrors already exists '
  + 'in the live account book, so sending it would create a duplicate there';

/** Shown by the explicit "post the GL" endpoints when they correctly do nothing. */
export const MIGRATED_NO_GL_MESSAGE =
  'Carried over from AutoCount at the 2026-08 cutover. AutoCount already booked this entry, so '
  + 'posting it here would count the same money in two books. No journal entry was written.';

export type WritebackDecision = {
  enqueued: boolean;
  reason: 'migrated_source' | 'enqueued' | 'writeback_not_wired' | 'enqueue_failed';
};

/**
 * Enqueue an AutoCount convert transfer unless the source document was carried
 * over from AutoCount, in which case NOTHING is enqueued, the enqueue function
 * is never called, and the skip is recorded instead.
 *
 * Both callbacks are injected rather than imported so the rule stays testable
 * without a database.
 */
export async function enqueueConvertIfAllowed(
  source: { migrated: boolean },
  enqueue?: () => Promise<unknown>,
  recordSkipped?: (reason: string) => Promise<unknown>,
): Promise<WritebackDecision> {
  if (source.migrated) {
    if (recordSkipped) await recordSkipped(MIGRATED_WRITEBACK_SKIP_REASON);
    return { enqueued: false, reason: 'migrated_source' };
  }
  if (!enqueue) return { enqueued: false, reason: 'writeback_not_wired' };
  try {
    await enqueue();
    return { enqueued: true, reason: 'enqueued' };
  } catch {
    return { enqueued: false, reason: 'enqueue_failed' };
  }
}

/**
 * TRUE when this invoice must post no journal entry, no revenue and no customer
 * credit: AutoCount already booked the payable / the revenue, and booking it
 * again here double-counts the money across the two books.
 */
export function accountingSuppressed(source: { migrated: boolean }): boolean {
  return source.migrated === true;
}

/**
 * The refusal, or null when every source document is an ordinary one.
 *
 * All three operator-facing convert paths call THIS rather than testing the
 * flag themselves — POST /from-grn, POST /from-grn-items and POST /from-dos.
 * One function means the three cannot drift, and it means the decision is
 * testable: the route handlers themselves are not, because the backend suite
 * runs in the Cloudflare Workers pool, where vi.mock does not intercept and a
 * handler cannot be driven against a fake Supabase client (the same reason
 * mfg-purchase-orders.photo-carry.test.ts tests a core function instead).
 */
export function refuseMigratedSources(
  docs: Array<{ docNo: string; migrated: boolean }>,
): { error: string; message: string; docNumbers: string[] } | null {
  const migrated = docs.filter((d) => d.migrated).map((d) => d.docNo).sort();
  if (migrated.length === 0) return null;
  return { ...MIGRATED_LINE_PICK_REFUSAL, docNumbers: migrated };
}

/**
 * Whether AutoCount is still an ACTIVE accounting book whose invoices a MIGRATED
 * document must mirror.
 *
 * Owner 2026-09-22, verbatim "ERP 已是唯一账本，AutoCount 不用了" (asked the
 * explicit money-safety binary first, answered decisively): the ERP is now the
 * SOLE accounting book. So a document carried over from AutoCount is billed in
 * the ERP like any ordinary one — GR -> PI and DO -> SI, by hand — and no longer
 * has to mirror an AutoCount invoice one-for-one. Flip this back to `true` to
 * restore the mirror-only regime (e.g. if AutoCount is reinstated as a live
 * book), and the never-invoiced allowlists below govern the exceptions again.
 *
 * WHY OPENING THESE IS SAFE ON BOTH BOOKS (the double-book the old guard blocked):
 *  - AutoCount side: enqueueConvertIfAllowed() suppresses the gr_to_pi / do_to_iv
 *    write-back for a migrated source, so billing one here pushes NOTHING into the
 *    live AutoCount book — no duplicate reaches it, even while write-back runs.
 *  - ERP side: the ordinary remaining-quantity check still stops a GR/DO the ERP
 *    already invoiced from being billed twice; opening the mirror guard only makes
 *    a migrated document behave like a native one, it does not bypass that.
 */
export const AUTOCOUNT_IS_ACTIVE_BOOK = false;

export function mustMirrorAutoCount(
  autocountActiveBook: boolean,
  doc: { docNo: string; migrated: boolean },
  neverInvoicedInAutoCount: ReadonlySet<string>,
): boolean {
  if (!autocountActiveBook) return false;
  return doc.migrated && !neverInvoicedInAutoCount.has(doc.docNo);
}

/**
 * TRUE when a delivery must be invoiced by mirroring AutoCount, never by hand.
 * Governed by AUTOCOUNT_IS_ACTIVE_BOOK: with the ERP as the sole book (current
 * state) this is always FALSE, so every migrated delivery bills by hand like an
 * ordinary one. When AutoCount is the active book, a delivery it never invoiced
 * (`migrated-deliveries-not-invoiced.generated.ts`) still bills by hand and every
 * other migrated delivery mirrors.
 */
export function deliveryMustMirrorAutoCount(
  delivery: { docNo: string; migrated: boolean },
  neverInvoicedInAutoCount: ReadonlySet<string>,
): boolean {
  return mustMirrorAutoCount(AUTOCOUNT_IS_ACTIVE_BOOK, delivery, neverInvoicedInAutoCount);
}

/**
 * TRUE when a goods receipt (GRN) must be invoiced into a purchase invoice by
 * mirroring AutoCount, never by hand — the PURCHASE-side mirror of
 * deliveryMustMirrorAutoCount, the same rule one table over
 * (`migrated-receipts-not-invoiced.generated.ts`). Also governed by
 * AUTOCOUNT_IS_ACTIVE_BOOK: FALSE for every GRN while the ERP is the sole book.
 */
export function receiptMustMirrorAutoCount(
  receipt: { docNo: string; migrated: boolean },
  neverInvoicedInAutoCount: ReadonlySet<string>,
): boolean {
  return mustMirrorAutoCount(AUTOCOUNT_IS_ACTIVE_BOOK, receipt, neverInvoicedInAutoCount);
}

/** Human-readable refusal for the operator-facing convert endpoints. */
export const MIGRATED_LINE_PICK_REFUSAL = {
  error: 'migrated_source_document',
  message:
    'This document was carried over from AutoCount. Its invoice must mirror the AutoCount invoice one-for-one — '
    + 'run the migrated-invoice converter instead. A hand-picked invoice cannot carry AutoCount\'s number.',
} as const;
