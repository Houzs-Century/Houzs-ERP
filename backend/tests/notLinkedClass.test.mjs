/* The `not linked` column of check-ac-convert-symmetry's matrix stood at 765
 * lines for as long as it existed, with no cause attached to any of them, and
 * on 2026-09-08 the owner asked directly whether they were being handled.
 *
 * Splitting a number into a benign half and a finding half is only safe if the
 * benign half cannot swallow a real gap. That is what these tests pin. The
 * shape they guard against is the one the item-code column was in until #3167 -
 * several unrelated populations wearing one number - and the failure they guard
 * against is the OPPOSITE of the one that produced it: a classifier that is too
 * generous makes a defect read as agreement with the account book.
 *
 * The load-bearing case is a bedframe. `isHardBoundLine` means a company-1
 * bedframe / sofa / (SP) mattress sales-order line reads READY only through its
 * OWN dedicated purchase-order line, so a purchase-order line with no link
 * lights nothing up and a customer's order stays PENDING with the goods in the
 * warehouse. docs/bugs/0672 is the MIS-linked version of that; these are the
 * UN-linked version.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyNotLinked,
  tallyNotLinked,
  findingsIn,
  isBenignNotLinked,
  NOT_LINKED_CLASSES,
} from '../scripts/lib/not-linked-class.mjs';

/* A book line as loadBook() shapes one. Only the fields the classifier reads. */
const bookLine = (o = {}) => ({
  docNo: 'PO-010093', dtlKey: '9001', itemKey: 'BF-REGAL',
  fromDocType: null, fromDocNo: null, fromSoDtlKey: '', ...o,
});

const base = {
  childAcDocNo: 'PO-010093',
  childDtlKey: '9001',
  bookLine: bookLine(),
  bookChildLines: null,
  lineKeyed: true,
  fromType: null,
  parentImported: () => true,
  parentLineCount: () => 1,
};

/* A document-grain edge - every edge except SO->PO. `bookChildLines` is the
   route; the child's own DtlKey is deliberately absent, because on a MIGRATED
   delivery note, receipt or invoice it genuinely is (mig 0280: the keys are
   stamped forward and nothing backfills them). */
const docGrain = {
  childAcDocNo: 'DO-001800',
  childDtlKey: null,
  bookLine: null,
  bookChildLines: [bookLine({ docNo: 'DO-001800', fromDocType: 'SO', fromDocNo: 'SO-002281' })],
  lineKeyed: false,
  fromType: 'SO',
  parentImported: () => true,
  parentLineCount: () => 1,
};

describe('classifyNotLinked - the four benign causes', () => {
  it('an ERP-native document is benign: there is no book edge to hold', () => {
    const v = classifyNotLinked({ ...base, childAcDocNo: null });
    expect(v.cls).toBe('erp_native');
    expect(isBenignNotLinked(v.cls)).toBe(true);
    expect(v.parentDocNo).toBeNull();
  });

  it('a book line naming no source is benign - identical to the book', () => {
    const v = classifyNotLinked({ ...base, bookLine: bookLine({ fromSoDtlKey: '' }) });
    expect(v.cls).toBe('book_no_edge');
    expect(isBenignNotLinked(v.cls)).toBe(true);
  });

  it('a parent the cutover did not import is benign, and the book doc is COPIED not invented', () => {
    const v = classifyNotLinked({
      ...base,
      bookLine: bookLine({ fromSoDtlKey: '7001', fromDocNo: 'SO-000123' }),
      parentImported: () => false,
    });
    expect(v.cls).toBe('out_of_scope');
    expect(v.parentDocNo).toBe('SO-000123');
    expect(v.parentDtlKey).toBe('7001');
  });

  it('a document-grain-only edge is benign: the book stores no source LINE for it', () => {
    const v = classifyNotLinked({ ...docGrain });
    expect(v.cls).toBe('doc_grain_only');
    expect(isBenignNotLinked(v.cls)).toBe(true);
    expect(v.parentDocNo).toBe('SO-002281');
    /* The book named a document and nothing finer, so the LINE key stays null.
       Filling it in would be the invention migration-copy-never-compute forbids. */
    expect(v.parentDtlKey).toBeNull();
  });
});

describe('the document-grain edges are read through the DOCUMENT, never the line key', () => {
  /* This is the mistake the first version of this classifier made and it is
     pinned here rather than only corrected: reading these five edges through
     linked_ac_dtlkey reported 360 of 765 lines as "no AutoCount line key",
     which is a manufactured gap - mig 0280 stamps those keys FORWARD and
     backfills nothing, so the whole migrated population has none. */
  it('a missing child DtlKey does NOT make a document-grain edge unresolved', () => {
    const v = classifyNotLinked({ ...docGrain, childDtlKey: null, bookLine: null });
    expect(v.cls).toBe('doc_grain_only');
  });

  it('the book document naming no source of THIS type is benign', () => {
    /* The 183 invoice lines with no sales-order link are this case: the book's
       invoices are converted from DELIVERY ORDERS, so an IV <- SO link would be
       an edge the account book does not have. */
    const v = classifyNotLinked({
      ...docGrain,
      childAcDocNo: 'I-000745',
      bookChildLines: [bookLine({ docNo: 'I-000745', fromDocType: 'DO', fromDocNo: 'DO-004000' })],
    });
    expect(v.cls).toBe('book_no_edge');
    expect(v.why).toContain('SO');
  });

  it('a child document absent from the snapshot is UNRESOLVED, not "no edge"', () => {
    /* `null` and `[]` must not collapse: an empty line list would read as the
       book recording no source, which is the benign answer. */
    const v = classifyNotLinked({ ...docGrain, bookChildLines: null });
    expect(v.cls).toBe('unresolved');
    expect(isBenignNotLinked(v.cls)).toBe(false);
  });

  it('several sources are all reported, and one imported parent is enough', () => {
    const v = classifyNotLinked({
      ...docGrain,
      bookChildLines: [
        bookLine({ fromDocType: 'SO', fromDocNo: 'SO-000001' }),
        bookLine({ fromDocType: 'SO', fromDocNo: 'SO-000002' }),
      ],
      parentImported: (d) => d === 'SO-000002',
    });
    expect(v.cls).toBe('doc_grain_only');
    expect(v.parentDocNo).toBe('SO-000002');
  });

  it('no source imported at all is OUT OF SCOPE and names what the book said', () => {
    const v = classifyNotLinked({ ...docGrain, parentImported: () => false });
    expect(v.cls).toBe('out_of_scope');
    expect(v.why).toContain('SO-002281');
  });
});

describe('classifyNotLinked - a real gap can NEVER be folded into a benign bucket', () => {
  it('the book states the link at line grain and we hold the line: DROPPED, our defect', () => {
    const v = classifyNotLinked({
      ...base,
      bookLine: bookLine({ fromSoDtlKey: '7001', fromDocNo: 'SO-000123' }),
    });
    expect(v.cls).toBe('dropped');
    expect(isBenignNotLinked(v.cls)).toBe(false);
  });

  it('a missing AutoCount line key is UNRESOLVED, never "the book has no edge"', () => {
    /* The trap: an absent key means we cannot reach the book row, and reading
       "no book row" as "the book records nothing" turns every unreachable line
       into agreement. That is the silence-printing-as-clean shape. */
    const v = classifyNotLinked({ ...base, childDtlKey: null, bookLine: null });
    expect(v.cls).toBe('unresolved');
    expect(isBenignNotLinked(v.cls)).toBe(false);
  });

  it('a key that resolves to no book line is UNRESOLVED, not benign', () => {
    const v = classifyNotLinked({ ...base, bookLine: null });
    expect(v.cls).toBe('unresolved');
    expect(isBenignNotLinked(v.cls)).toBe(false);
  });

  it('a source line carried by several ERP rows is UNRESOLVED - two is not found', () => {
    /* 296 sales-order DtlKeys are carried by more than one ERP row. Picking one
       is the coin flip that put a REGAL in front of a TRION customer. */
    const v = classifyNotLinked({
      ...base,
      bookLine: bookLine({ fromSoDtlKey: '7001', fromDocNo: 'SO-000123' }),
      parentLineCount: () => 3,
    });
    expect(v.cls).toBe('unresolved');
    expect(isBenignNotLinked(v.cls)).toBe(false);
    expect(v.why).toContain('3 ERP rows');
  });

  it('the source line being absent from the ERP is OUT OF SCOPE, not DROPPED', () => {
    const v = classifyNotLinked({
      ...base,
      bookLine: bookLine({ fromSoDtlKey: '7001', fromDocNo: 'SO-000123' }),
      parentLineCount: () => 0,
    });
    expect(v.cls).toBe('out_of_scope');
  });

  it('an ERP-native document wins over everything else, including a book edge', () => {
    /* Ordering matters: a row with no AutoCount document number cannot have a
       book line, so every later branch would be reading a stale lookup. */
    const v = classifyNotLinked({
      ...base,
      childAcDocNo: '   ',
      bookLine: bookLine({ fromSoDtlKey: '7001', fromDocNo: 'SO-000123' }),
    });
    expect(v.cls).toBe('erp_native');
  });
});

describe('the benign / finding split is DECLARED, not derived at the call site', () => {
  it('exactly two classes are findings, and they are the two that mean "act"', () => {
    expect(NOT_LINKED_CLASSES.filter((c) => !c.benign).map((c) => c.id))
      .toEqual(['dropped', 'unresolved']);
  });

  it('every class the classifier can return is declared', () => {
    const declared = new Set(NOT_LINKED_CLASSES.map((c) => c.id));
    const produced = [
      classifyNotLinked({ ...base, childAcDocNo: null }),
      classifyNotLinked({ ...base }),
      classifyNotLinked({ ...base, bookLine: bookLine({ fromSoDtlKey: '7001', fromDocNo: 'X' }), parentImported: () => false }),
      classifyNotLinked({ ...docGrain }),
      classifyNotLinked({ ...base, bookLine: bookLine({ fromSoDtlKey: '7001', fromDocNo: 'SO-1' }) }),
      classifyNotLinked({ ...base, bookLine: null }),
    ].map((v) => v.cls);
    for (const c of produced) expect(declared.has(c)).toBe(true);
    expect(new Set(produced).size).toBe(NOT_LINKED_CLASSES.length);
  });

  it('a tally prints every class, including the empty ones', () => {
    /* A bucket that is zero must appear as zero. Omitting it makes an empty
       bucket indistinguishable from one the report forgot to compute. */
    const t = tallyNotLinked([classifyNotLinked({ ...base, childAcDocNo: null })]);
    expect(Object.keys(t).sort()).toEqual(NOT_LINKED_CLASSES.map((c) => c.id).sort());
    expect(t.erp_native).toBe(1);
    expect(t.dropped).toBe(0);
  });

  it('findingsIn counts only the non-benign half', () => {
    const t = tallyNotLinked([
      classifyNotLinked({ ...base, childAcDocNo: null }),
      classifyNotLinked({ ...base }),
      classifyNotLinked({ ...base, bookLine: bookLine({ fromSoDtlKey: '7001', fromDocNo: 'SO-1' }) }),
      classifyNotLinked({ ...base, bookLine: null }),
    ]);
    expect(findingsIn(t)).toBe(2);
    expect(Object.values(t).reduce((a, b) => a + b, 0)).toBe(4);
  });
});
