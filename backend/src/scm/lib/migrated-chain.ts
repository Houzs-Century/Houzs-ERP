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
  /** the quantity that would be invoiced now */
  qty: number;
  unitPriceCenti: number;
  discountCenti?: number;
  /**
   * The order line this delivery/receipt line came from (so_item_id /
   * purchase_order_item_id). Two lines of one document sharing it is rule 3's
   * duplicate.
   */
  sourceLineKey?: string | null;
};

/** A migrated GRN or DO, with the AutoCount invoices raised from it. */
export type MigratedSourceDoc = {
  /** the ERP document number (HC-GR-000034 / HC-DO-005452) */
  docNo: string;
  /** the AutoCount document this mirrors (GR-000034 / DO-005452) */
  acDocNo: string | null;
  /** AutoCount invoice numbers raised from it — empty means never invoiced */
  acInvoiceNos: string[];
  /** AutoCount invoice numbers raised from it that AutoCount later CANCELLED */
  acCancelledInvoiceNos?: string[];
  /**
   * Who the invoice is with — the supplier on a receipt, the debtor on a
   * delivery. One AutoCount invoice routinely spans several of our documents
   * (309 of 4,789 purchase invoices and 568 of 9,245 sales invoices do), and the
   * merged ERP invoice can carry only ONE party on its header. Rule 5 refuses
   * the group rather than letting the first document's party win by sort order.
   */
  partyKey?: string | null;
  lines: MigratedSourceLine[];
};

export type MigratedGateReason =
  | 'ok'
  /** the ERP document carries no AutoCount document number to mirror */
  | 'no_autocount_document'
  /** AutoCount never raised an invoice from this document */
  | 'no_autocount_invoice'
  /** every AutoCount invoice raised from it was cancelled */
  | 'autocount_invoice_cancelled'
  /** invoiced across several AutoCount invoices and there is no line key to split by */
  | 'ambiguous_autocount_invoices'
  /** no line left to invoice */
  | 'nothing_to_invoice'
  /** the same order line appears on two rows of one document */
  | 'duplicate_source_lines'
  /** the documents one AutoCount invoice spans do not agree on the supplier / debtor */
  | 'party_disagrees_across_sources'
  /** what we would bill is not what AutoCount billed */
  | 'total_disagrees_with_autocount';

export type MigratedInvoicePlan = {
  /** the AutoCount invoice this mirrors */
  acInvoiceNo: string;
  /** HC-<acInvoiceNo> */
  invoiceNumber: string;
  /** every migrated source document whose lines this invoice carries */
  sourceDocNos: string[];
  lineCount: number;
  qty: number;
  /** what this invoice would be worth, in sen, from the SOURCE lines only */
  valueCenti: number;
  /** what AutoCount actually billed on that invoice, in sen */
  acValueCenti: number;
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
  /** filled for total_disagrees_with_autocount so the report can print both */
  valueCenti?: number;
  acValueCenti?: number;
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

export function lineValueCenti(l: MigratedSourceLine): number {
  return Math.max(0, Math.round(l.qty * l.unitPriceCenti) - Math.round(l.discountCenti ?? 0));
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
 * `acInvoiceTotalCenti` is what AutoCount billed, keyed by its invoice number.
 * An invoice we cannot look up a total for is refused rather than written — a
 * missing cross-check is not a passing cross-check.
 *
 * `allowTotalMismatch` exists only so the gate can be demonstrated from both
 * sides in a test; the routes never set it and the converter's default run
 * never sets it.
 */
export function planMigratedInvoices(
  sources: MigratedSourceDoc[],
  acInvoiceTotalCenti: Record<string, number> | Map<string, number>,
  opts: { allowTotalMismatch?: boolean } = {},
): MigratedPlanResult {
  const acTotal = (k: string): number | undefined =>
    acInvoiceTotalCenti instanceof Map ? acInvoiceTotalCenti.get(k) : acInvoiceTotalCenti[k];

  const blocked: MigratedBlockedSource[] = [];
  const groups = new Map<string, MigratedSourceDoc[]>();

  const block = (s: MigratedSourceDoc, reason: MigratedGateReason) => blocked.push({
    docNo: s.docNo,
    acDocNo: s.acDocNo,
    acInvoiceNos: s.acInvoiceNos,
    reason,
    lineCount: s.lines.length,
    unpricedLines: s.lines.filter((l) => !(l.unitPriceCenti > 0)).length,
  });

  for (const s of sources) {
    if (!s.acDocNo) { block(s, 'no_autocount_document'); continue; }
    /* Rule 3 first: a duplicated line makes every later number wrong, so it must
       not be reachable by any path that writes. */
    if (duplicateSourceLineKeys(s.lines).length > 0) { block(s, 'duplicate_source_lines'); continue; }
    const invoiceable = s.lines.filter((l) => l.qty > 0);
    if (invoiceable.length === 0) { block(s, 'nothing_to_invoice'); continue; }
    const acs = [...new Set(s.acInvoiceNos.map((x) => x.trim()).filter(Boolean))].sort();
    if (acs.length === 0) {
      /* "AutoCount cancelled it" and "AutoCount never raised one" are different
         facts about the business and get different names, though both refuse. */
      block(s, (s.acCancelledInvoiceNos ?? []).length > 0
        ? 'autocount_invoice_cancelled' : 'no_autocount_invoice');
      continue;
    }
    /* No line-to-line key exists on either side, so "which of these two invoices
       billed this line" has no answer. Refuse and name it. */
    if (acs.length > 1) { block(s, 'ambiguous_autocount_invoices'); continue; }
    const g = groups.get(acs[0]!) ?? [];
    g.push({ ...s, lines: invoiceable });
    groups.set(acs[0]!, g);
  }

  const plans: MigratedInvoicePlan[] = [];
  for (const [acInvoiceNo, docs] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const lines = docs.flatMap((d) => d.lines);
    const valueCenti = lines.reduce((t, l) => t + lineValueCenti(l), 0);
    const acValueCenti = acTotal(acInvoiceNo) ?? -1;
    /* Rule 5: the merged header can name only ONE supplier / debtor, and which
       one it would name is decided by sort order. Sort order is not evidence, so
       a group that disagrees is refused. Checked BEFORE the total, because a
       group billed to the wrong party is wrong even when the money adds up. */
    const parties = [...new Set(docs.map((d) => d.partyKey).filter((p): p is string => !!p))];
    const partySplit = parties.length > 1;
    const eligible = !partySplit
      && (opts.allowTotalMismatch === true || (acValueCenti >= 0 && acValueCenti === valueCenti));
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
          unpricedLines: d.lines.filter((l) => !(l.unitPriceCenti > 0)).length,
          valueCenti,
          acValueCenti,
        });
      }
    }
    plans.push({
      acInvoiceNo,
      invoiceNumber: migratedInvoiceNumber(acInvoiceNo),
      sourceDocNos: docs.map((d) => d.docNo).sort(),
      lineCount: lines.length,
      qty: lines.reduce((t, l) => t + l.qty, 0),
      valueCenti,
      acValueCenti,
      unpricedLines: lines.filter((l) => !(l.unitPriceCenti > 0)).length,
      eligible,
      reason,
    });
  }
  return { plans, blocked };
}

/* ── AutoCount write-back suppression ──────────────────────────────────────
   The AutoCount outbox (lib/autocount-outbox.ts) enqueues a gr_to_pi transfer
   when a GRN is converted and a do_to_iv transfer when a DO is. For a MIGRATED
   document that is exactly the wrong thing: the invoice being created here
   already exists in the live AED_HOUZS book, and its parent carries a
   linked_ac_docno, so dispatchOne resolves a real FromDocNo and pushes a SECOND
   purchase invoice / sales invoice into the owner's live accounts.

   enqueueConvert has none of the "already in AutoCount" protection its
   enqueueSoCreate / enqueuePoCreate siblings have (both bail on a populated
   linked_ac_docno), so the refusal lives here, in front of it.

   It is RECORDED, not silent. The outbox already has the vocabulary for this —
   recordConvertSkipped exists precisely so a conversion the ERP will not send
   leaves a row saying why, rather than a gap nobody can tell from a bug. */

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

/** Human-readable refusal for the operator-facing convert endpoints. */
export const MIGRATED_LINE_PICK_REFUSAL = {
  error: 'migrated_source_document',
  message:
    'This document was carried over from AutoCount. Its invoice must mirror the AutoCount invoice one-for-one — '
    + 'run the migrated-invoice converter instead. A hand-picked invoice cannot carry AutoCount\'s number.',
} as const;
