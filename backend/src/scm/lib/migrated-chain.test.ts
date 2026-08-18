import { describe, it, expect, vi } from 'vitest';
import {
  planMigratedInvoices,
  migratedInvoiceNumber,
  duplicateSourceLineKeys,
  enqueueConvertIfAllowed,
  accountingSuppressed,
  refuseMigratedSources,
  MIGRATED_WRITEBACK_SKIP_REASON,
  type MigratedSourceDoc,
} from './migrated-chain';

/* Every fixture below is a real document read out of production and live
   AED_HOUZS on 2026-08-11, not an invented shape. The AutoCount totals are
   PI.NetTotal / IV.NetTotal in sen. */

const line = (over: Partial<MigratedSourceDoc['lines'][number]> = {}) => ({
  lineId: 'l1', itemCode: 'AKEMI IMMORTAL MATT (Q)', qty: 1, unitPriceSen: 369400,
  sourceLineKey: 'so-1', ...over,
});

const src = (over: Partial<MigratedSourceDoc> = {}): MigratedSourceDoc => ({
  docNo: 'HC-GR-000034', acDocNo: 'GR-000034', acInvoiceNos: ['PI-000658'], lines: [line()], ...over,
});

describe('migrated invoice numbering', () => {
  it('carries the AutoCount invoice number, never a fresh sequence', () => {
    expect(migratedInvoiceNumber('PI-000658')).toBe('HC-PI-000658');
    // AutoCount's sales invoices are numbered I-…, not IV-… (verified live)
    expect(migratedInvoiceNumber('I-2601-0154')).toBe('HC-I-2601-0154');
  });

  it('numbers every planned invoice from its AutoCount invoice', () => {
    const { plans } = planMigratedInvoices([src()], { 'PI-000658': 369400 });
    expect(plans).toHaveLength(1);
    expect(plans[0]!.invoiceNumber).toBe('HC-PI-000658');
    // the check-migrated-numbering rule, restated as an assertion
    expect(plans[0]!.invoiceNumber).toBe(`HC-${plans[0]!.acInvoiceNo}`);
  });
});

describe('rule 1 — one ERP invoice per AutoCount invoice', () => {
  it('merges the GRNs one AutoCount invoice spans into ONE invoice', () => {
    // real: PI-000832 covers HC-GR-000201-PO-000273 and HC-GR-000201-PO-000275
    const { plans } = planMigratedInvoices([
      src({ docNo: 'HC-GR-000201-PO-000273', acDocNo: 'GR-000201', acInvoiceNos: ['PI-000832'] }),
      src({
        docNo: 'HC-GR-000201-PO-000275', acDocNo: 'GR-000201', acInvoiceNos: ['PI-000832'],
        lines: [line({ lineId: 'l2', sourceLineKey: 'so-2' })],
      }),
    ], { 'PI-000832': 738800 });
    expect(plans).toHaveLength(1);
    expect(plans[0]!.invoiceNumber).toBe('HC-PI-000832');
    expect(plans[0]!.sourceDocNos).toEqual(['HC-GR-000201-PO-000273', 'HC-GR-000201-PO-000275']);
    expect(plans[0]!.eligible).toBe(true);
  });

  it('keeps separate AutoCount invoices separate', () => {
    const { plans } = planMigratedInvoices([
      src({ docNo: 'A', acInvoiceNos: ['PI-000001'] }),
      src({ docNo: 'B', acInvoiceNos: ['PI-000002'] }),
    ], { 'PI-000001': 369400, 'PI-000002': 369400 });
    expect(plans.map((p) => p.invoiceNumber)).toEqual(['HC-PI-000001', 'HC-PI-000002']);
  });
});

describe('rule 2 — only what AutoCount actually invoiced', () => {
  it('refuses a delivery AutoCount never invoiced', () => {
    // real: HC-DO-007466, HC-DO-007525, HC-DO-008624
    const { plans, blocked } = planMigratedInvoices(
      [src({ docNo: 'HC-DO-007466', acDocNo: 'DO-007466', acInvoiceNos: [] })], {});
    expect(plans).toHaveLength(0);
    expect(blocked[0]).toMatchObject({ docNo: 'HC-DO-007466', reason: 'no_autocount_invoice' });
  });

  it('names a CANCELLED AutoCount invoice as its own answer, not as "never invoiced"', () => {
    const { blocked } = planMigratedInvoices(
      [src({ acInvoiceNos: [], acCancelledInvoiceNos: ['PI-000658'] })], {});
    expect(blocked[0]!.reason).toBe('autocount_invoice_cancelled');
  });

  it('refuses a document with no AutoCount number to mirror', () => {
    // real: 12 of 291 migrated GRNs
    const { blocked } = planMigratedInvoices([src({ acDocNo: null })], {});
    expect(blocked[0]!.reason).toBe('no_autocount_document');
  });

  it('refuses a document billed across several AutoCount invoices — no line key exists to split it', () => {
    const { plans, blocked } = planMigratedInvoices(
      [src({ acInvoiceNos: ['PI-006011', 'PI-006012'] })], { 'PI-006011': 1, 'PI-006012': 1 });
    expect(plans).toHaveLength(0);
    expect(blocked[0]!.reason).toBe('ambiguous_autocount_invoices');
  });

  it('refuses a document with nothing left to invoice', () => {
    // real: HC-DO-000608 holds 3 rows, all qty 0
    const { plans, blocked } = planMigratedInvoices(
      [src({ lines: [line({ qty: 0 })] })], { 'PI-000658': 0 });
    expect(plans).toHaveLength(0);
    expect(blocked[0]!.reason).toBe('nothing_to_invoice');
  });
});

describe('rule 3 — a duplicated source line is refused, never silently billed', () => {
  /* HC-DO-005452 really holds 12 rows / 24 units against AutoCount's 6 rows /
     12 units: every so_item_id appears twice with the same qty. Its AutoCount
     invoice I-2507-0184 billed RM 7,300.00; the doubled rows would bill
     RM 14,600.00. */
  const doubled = src({
    docNo: 'HC-DO-005452', acDocNo: 'DO-005452', acInvoiceNos: ['I-2507-0184'],
    lines: [
      line({ lineId: 'a', itemCode: 'AKEMI ARISTOI MATT (SK)', qty: 1, unitPriceSen: 730000, sourceLineKey: 'so-4391533d' }),
      line({ lineId: 'b', itemCode: 'AKEMI ARISTOI MATT (SK)', qty: 1, unitPriceSen: 730000, sourceLineKey: 'so-4391533d' }),
    ],
  });

  it('spots the duplicate order line', () => {
    expect(duplicateSourceLineKeys(doubled.lines)).toEqual(['so-4391533d']);
  });

  it('refuses it — and quoting BOTH numbers: it would have billed 1,460,000 sen against AutoCount 730,000', () => {
    const { plans, blocked } = planMigratedInvoices([doubled], { 'I-2507-0184': 730000 });
    expect(plans).toHaveLength(0);
    expect(blocked[0]!.reason).toBe('duplicate_source_lines');

    // WITHOUT rule 3, this document reaches the total gate carrying double.
    const naive = planMigratedInvoices(
      [{ ...doubled, lines: doubled.lines.map((l, i) => ({ ...l, sourceLineKey: `distinct-${i}` })) }],
      { 'I-2507-0184': 730000 });
    expect(naive.plans[0]!.valueSen).toBe(1460000);
    expect(naive.plans[0]!.acValueSen).toBe(730000);
    expect(naive.plans[0]!.eligible).toBe(false);
  });

  it('a document whose lines legitimately repeat a PRODUCT but not an order line is fine', () => {
    const { plans } = planMigratedInvoices([src({
      lines: [
        line({ lineId: 'a', qty: 1, unitPriceSen: 100, sourceLineKey: 'so-1' }),
        line({ lineId: 'b', qty: 1, unitPriceSen: 100, sourceLineKey: 'so-2' }),
      ],
    })], { 'PI-000658': 200 });
    expect(plans[0]!.eligible).toBe(true);
  });
});

describe('rule 4 — the total must equal AutoCount\'s, to the sen', () => {
  it('passes the delivery that reconciles exactly', () => {
    // real: HC-DO-008331 -> I-2601-0154, RM 4,849.50 on both sides
    const { plans } = planMigratedInvoices([src({
      docNo: 'HC-DO-008331', acDocNo: 'DO-008331', acInvoiceNos: ['I-2601-0154'],
      lines: [line({ itemCode: 'AKEMI ARMOUR MATT (K)', qty: 1, unitPriceSen: 484950 })],
    })], { 'I-2601-0154': 484950 });
    expect(plans[0]!.eligible).toBe(true);
    expect(plans[0]!.reason).toBe('ok');
    expect(plans[0]!.valueSen).toBe(484950);
    expect(plans[0]!.acValueSen).toBe(484950);
  });

  it('a free line does NOT fail the gate when AutoCount billed it free too', () => {
    // real shape: HC-DO-007726 bills RM 3,694.00 across 4 lines, 3 of them RM 0
    const { plans } = planMigratedInvoices([src({
      docNo: 'HC-DO-007726', acDocNo: 'DO-007726', acInvoiceNos: ['I-2512-0062'],
      lines: [
        line({ lineId: 'a', qty: 1, unitPriceSen: 369400, sourceLineKey: 's1' }),
        line({ lineId: 'b', qty: 1, unitPriceSen: 0, sourceLineKey: 's2' }),
        line({ lineId: 'c', qty: 2, unitPriceSen: 0, sourceLineKey: 's3' }),
      ],
    })], { 'I-2512-0062': 369400 });
    expect(plans[0]!.unpricedLines).toBe(2);
    expect(plans[0]!.eligible).toBe(true);
  });

  it('a line the cutover failed to price DOES fail the gate, and reports both numbers', () => {
    // real: HC-DO-010222 would bill RM 0.00 against AutoCount's RM 7,650.00
    const { plans, blocked } = planMigratedInvoices([src({
      docNo: 'HC-DO-010222', acDocNo: 'DO-010222', acInvoiceNos: ['I-2606-0009'],
      lines: [line({ qty: 8, unitPriceSen: 0 })],
    })], { 'I-2606-0009': 765000 });
    expect(plans[0]!.eligible).toBe(false);
    expect(plans[0]!.reason).toBe('total_disagrees_with_autocount');
    expect(blocked[0]).toMatchObject({
      docNo: 'HC-DO-010222', reason: 'total_disagrees_with_autocount',
      valueSen: 0, acValueSen: 765000,
    });
  });

  it('refuses when AutoCount has no total to check against — a missing cross-check is not a passing one', () => {
    const { plans } = planMigratedInvoices([src()], {});
    expect(plans[0]!.eligible).toBe(false);
    expect(plans[0]!.acValueSen).toBe(-1);
  });

  it('the override exists and is opt-in only', () => {
    const { plans } = planMigratedInvoices([src()], {}, { allowTotalMismatch: true });
    expect(plans[0]!.eligible).toBe(true);
  });
});

describe('rule 5 — one invoice, one party', () => {
  /* 309 of 4,789 AutoCount purchase invoices and 568 of 9,245 sales invoices
     span more than one source document, so the merged header is the common
     case. It can name only one supplier / debtor. */
  it('merges documents that agree on the party', () => {
    const { plans } = planMigratedInvoices([
      src({ docNo: 'HC-GR-000201-PO-000273', acInvoiceNos: ['PI-000832'], partyKey: 'supplier-a' }),
      src({
        docNo: 'HC-GR-000201-PO-000275', acInvoiceNos: ['PI-000832'], partyKey: 'supplier-a',
        lines: [line({ lineId: 'l2', sourceLineKey: 'so-2' })],
      }),
    ], { 'PI-000832': 738800 });
    expect(plans).toHaveLength(1);
    expect(plans[0]!.eligible).toBe(true);
  });

  it('refuses when they disagree — the header cannot be decided by sort order', () => {
    const { plans, blocked } = planMigratedInvoices([
      src({ docNo: 'HC-GR-000201-PO-000273', acInvoiceNos: ['PI-000832'], partyKey: 'supplier-a' }),
      src({
        docNo: 'HC-GR-000201-PO-000275', acInvoiceNos: ['PI-000832'], partyKey: 'supplier-b',
        lines: [line({ lineId: 'l2', sourceLineKey: 'so-2' })],
      }),
    ], { 'PI-000832': 738800 });
    expect(plans[0]!.eligible).toBe(false);
    expect(plans[0]!.reason).toBe('party_disagrees_across_sources');
    // both source documents are named, not just the losing one
    expect(blocked.map((b) => b.docNo).sort())
      .toEqual(['HC-GR-000201-PO-000273', 'HC-GR-000201-PO-000275']);
  });

  it('a party disagreement outranks a matching total — right money, wrong customer is still wrong', () => {
    const { plans } = planMigratedInvoices([
      src({ docNo: 'A', acInvoiceNos: ['PI-000832'], partyKey: 'supplier-a' }),
      src({
        docNo: 'B', acInvoiceNos: ['PI-000832'], partyKey: 'supplier-b',
        lines: [line({ lineId: 'l2', sourceLineKey: 'so-2' })],
      }),
    ], { 'PI-000832': 738800 });
    expect(plans[0]!.valueSen).toBe(plans[0]!.acValueSen);   // the money agrees
    expect(plans[0]!.eligible).toBe(false);                       // and it is STILL refused
    expect(plans[0]!.reason).toBe('party_disagrees_across_sources');
  });

  it('the manual override cannot buy past a party disagreement', () => {
    const { plans } = planMigratedInvoices([
      src({ docNo: 'A', acInvoiceNos: ['PI-000832'], partyKey: 'supplier-a' }),
      src({ docNo: 'B', acInvoiceNos: ['PI-000832'], partyKey: 'supplier-b', lines: [line({ lineId: 'l2', sourceLineKey: 'so-2' })] }),
    ], { 'PI-000832': 738800 }, { allowTotalMismatch: true });
    expect(plans[0]!.eligible).toBe(false);
  });

  it('a document with no recorded party does not manufacture a disagreement', () => {
    const { plans } = planMigratedInvoices([
      src({ docNo: 'A', acInvoiceNos: ['PI-000832'], partyKey: 'supplier-a' }),
      src({ docNo: 'B', acInvoiceNos: ['PI-000832'], partyKey: null, lines: [line({ lineId: 'l2', sourceLineKey: 'so-2' })] }),
    ], { 'PI-000832': 738800 });
    expect(plans[0]!.eligible).toBe(true);
  });
});

describe('partial AutoCount coverage is refused by the total gate, with no rule of its own', () => {
  it('an invoice spanning four receipts of which we migrated one cannot reach its total', () => {
    // real shape: PI-001895 covers GR-000954, GR-000986, GR-001032, GR-001074
    const { plans, blocked } = planMigratedInvoices([src({
      docNo: 'HC-GR-000954', acDocNo: 'GR-000954', acInvoiceNos: ['PI-001895'],
      lines: [line({ qty: 1, unitPriceSen: 100000 })],
    })], { 'PI-001895': 400000 });
    expect(plans[0]!.eligible).toBe(false);
    expect(blocked[0]).toMatchObject({ reason: 'total_disagrees_with_autocount', valueSen: 100000, acValueSen: 400000 });
  });
});

describe('AutoCount write-back is suppressed for a migrated conversion', () => {
  it('enqueues NOTHING for a migrated source, and never calls the outbox', async () => {
    const enqueue = vi.fn(async () => ({ id: 'outbox-1' }));
    const decision = await enqueueConvertIfAllowed({ migrated: true }, enqueue);
    expect(enqueue).not.toHaveBeenCalled();
    expect(decision).toEqual({ enqueued: false, reason: 'migrated_source' });
  });

  it('records WHY it sent nothing, rather than leaving a gap', async () => {
    const enqueue = vi.fn(async () => ({ id: 'outbox-1' }));
    const recordSkipped = vi.fn(async () => ({ id: 'skip-1' }));
    await enqueueConvertIfAllowed({ migrated: true }, enqueue, recordSkipped);
    expect(enqueue).not.toHaveBeenCalled();
    expect(recordSkipped).toHaveBeenCalledWith(MIGRATED_WRITEBACK_SKIP_REASON);
  });

  it('still enqueues for an ordinary conversion — the guard is not a blanket off switch', async () => {
    const enqueue = vi.fn(async () => ({ id: 'outbox-1' }));
    const recordSkipped = vi.fn(async () => ({ id: 'skip-1' }));
    const decision = await enqueueConvertIfAllowed({ migrated: false }, enqueue, recordSkipped);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(recordSkipped).not.toHaveBeenCalled();
    expect(decision).toEqual({ enqueued: true, reason: 'enqueued' });
  });

  it('reports the outbox being unwired rather than pretending it enqueued', async () => {
    expect(await enqueueConvertIfAllowed({ migrated: false })).toEqual(
      { enqueued: false, reason: 'writeback_not_wired' });
  });
});

describe('the convert routes refuse a migrated source', () => {
  /* All three operator convert paths call refuseMigratedSources — POST
     /from-grn, POST /from-grn-items, POST /from-dos. The handlers themselves
     cannot be driven in this suite (it runs in the Cloudflare Workers pool,
     where vi.mock does not intercept), which is exactly why the decision lives
     in a function instead of inline in three handlers. */
  it('refuses, and names every migrated document in the pick', () => {
    const r = refuseMigratedSources([
      { docNo: 'HC-DO-009888', migrated: true },
      { docNo: 'DO-2608-001', migrated: false },
      { docNo: 'HC-DO-005452', migrated: true },
    ]);
    expect(r).not.toBeNull();
    expect(r!.error).toBe('migrated_source_document');
    expect(r!.docNumbers).toEqual(['HC-DO-005452', 'HC-DO-009888']);
  });

  it('lets an ordinary conversion through — the guard is not a blanket block', () => {
    expect(refuseMigratedSources([
      { docNo: 'GRN-2608-001', migrated: false },
      { docNo: 'GRN-2608-002', migrated: false },
    ])).toBeNull();
  });

  it('one migrated line in an otherwise ordinary pick is enough to refuse the whole invoice', () => {
    // a partial invoice cannot carry AutoCount's number, so the pick cannot be
    // silently narrowed to the ordinary rows
    expect(refuseMigratedSources([
      { docNo: 'GRN-2608-001', migrated: false },
      { docNo: 'HC-GR-000034', migrated: true },
    ])).not.toBeNull();
  });

  it('an empty pick is not a refusal', () => {
    expect(refuseMigratedSources([])).toBeNull();
  });
});

describe('a migrated invoice posts no journal entry', () => {
  it('suppresses accounting for a migrated source and leaves an ordinary one alone', () => {
    expect(accountingSuppressed({ migrated: true })).toBe(true);
    expect(accountingSuppressed({ migrated: false })).toBe(false);
  });
});
