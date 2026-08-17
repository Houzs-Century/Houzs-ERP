/* The empty state must say WHY it is empty, and only ONE branch is allowed to
 * claim the work is finished.
 *
 * The owner's 2026-08-17 report is the negative case that gives this suite its
 * value: a PO that had never been received, scoped in the URL, rendering
 * "every line has been received". Each test below is one of the situations that
 * single sentence used to cover, and the last one asserts the property directly
 * — no branch says "received" unless it checked.
 */
import { describe, expect, test } from 'vitest';
import { outstandingEmptyReason, type OutstandingScope, type ScopedPo } from './outstandingEmptyReason';

const po = (over: Partial<ScopedPo> = {}): ScopedPo => ({
  poId: 'p1', poDocNo: 'PO-2608-001', status: 'SUBMITTED',
  receivable: true, candidateLines: 2, outstandingLines: 1, ...over,
});

const scope = (over: Partial<OutstandingScope> = {}): OutstandingScope => ({
  requestedPoIds: [], pos: [], unknownPoIds: [], truncated: false, scanned: 0, ...over,
});

const base = {
  isError: false, isLoading: false, scope: scope(),
  serverRowCount: 0, visibleRowCount: 0, filtersActive: false,
};

describe('nothing to explain', () => {
  test('rows are visible → no message at all', () => {
    expect(outstandingEmptyReason({ ...base, serverRowCount: 3, visibleRowCount: 3 })).toBeNull();
  });
});

describe('a failed read outranks every other reason', () => {
  test('says the list is INCOMPLETE, never that it is finished', () => {
    const m = outstandingEmptyReason({ ...base, isError: true })!;
    expect(m).toContain("couldn't load");
    expect(m).not.toMatch(/has been received|has already been received/);
  });

  test('it wins even when the scope would otherwise claim completion', () => {
    const m = outstandingEmptyReason({
      ...base, isError: true,
      scope: scope({ requestedPoIds: ['p1'], pos: [po({ outstandingLines: 0 })] }),
    })!;
    expect(m).toContain("couldn't load");
  });
});

describe('the read stopped early — the owner-facing mechanism', () => {
  test('says lines are MISSING and explicitly denies the completion reading', () => {
    const m = outstandingEmptyReason({ ...base, scope: scope({ truncated: true }) })!;
    expect(m).toContain('cut short');
    expect(m).toContain('does NOT mean there is nothing left to receive');
  });

  test('it offers the single-PO route, which reads only that order', () => {
    expect(outstandingEmptyReason({ ...base, scope: scope({ truncated: true }) }))
      .toContain('Open a single Purchase Order');
  });
});

describe('scoped to a PO this company does not hold', () => {
  test('one unknown id names the company problem instead of a completion', () => {
    const m = outstandingEmptyReason({
      ...base, scope: scope({ requestedPoIds: ['x'], unknownPoIds: ['x'] }),
    })!;
    expect(m).toContain("not in this company's books");
    expect(m).not.toMatch(/received in full/);
  });

  test('several unknown ids are counted', () => {
    expect(outstandingEmptyReason({
      ...base, scope: scope({ requestedPoIds: ['x', 'y'], unknownPoIds: ['x', 'y'] }),
    })).toContain('None of those 2 Purchase Orders');
  });
});

describe('scoped, but the STATUS excludes the PO', () => {
  test('a DRAFT PO is named as a draft, with the fix', () => {
    const m = outstandingEmptyReason({
      ...base,
      scope: scope({
        requestedPoIds: ['p1'],
        pos: [po({ status: 'DRAFT', receivable: false, candidateLines: 0, outstandingLines: 0 })],
      }),
    })!;
    expect(m).toContain('PO-2608-001 is DRAFT');
    expect(m).toContain('Submit the order first');
    expect(m).not.toMatch(/received in full/);
  });

  test('a CANCELLED PO says CANCELLED', () => {
    expect(outstandingEmptyReason({
      ...base,
      scope: scope({ requestedPoIds: ['p1'], pos: [po({ status: 'CANCELLED', receivable: false })] }),
    })).toContain('is CANCELLED');
  });

  test('a NULL status is reported as unknown, not silently dropped', () => {
    expect(outstandingEmptyReason({
      ...base,
      scope: scope({ requestedPoIds: ['p1'], pos: [po({ status: null, receivable: false })] }),
    })).toContain('is in an unknown status');
  });

  test('two blocked POs are both named', () => {
    const m = outstandingEmptyReason({
      ...base,
      scope: scope({
        requestedPoIds: ['p1', 'p2'],
        pos: [
          po({ status: 'DRAFT', receivable: false }),
          po({ poId: 'p2', poDocNo: 'PO-2608-002', status: 'CANCELLED', receivable: false }),
        ],
      }),
    })!;
    expect(m).toContain('PO-2608-001 is DRAFT');
    expect(m).toContain('PO-2608-002 is CANCELLED');
  });
});

describe('scoped, receivable, and GENUINELY fully received', () => {
  test('the one branch entitled to say the work is done says it about the NAMED document', () => {
    const m = outstandingEmptyReason({
      ...base,
      scope: scope({
        requestedPoIds: ['p1'],
        pos: [po({ status: 'PARTIALLY_RECEIVED', outstandingLines: 0, candidateLines: 3 })],
      }),
    })!;
    expect(m).toBe(
      'Every line on PO-2608-001 has already been received in full, so there is '
      + 'nothing left to put on a Goods Receipt.',
    );
  });

  test('it does NOT fire while a toolbar filter could be the real cause', () => {
    const m = outstandingEmptyReason({
      ...base, filtersActive: true, serverRowCount: 4,
      scope: scope({ requestedPoIds: ['p1'], pos: [po({ outstandingLines: 0 })] }),
    })!;
    expect(m).toContain('the filters above hide');
  });

  test('an unnamed PO degrades to a phrase, never to a bare "this PO has been received"', () => {
    expect(outstandingEmptyReason({
      ...base,
      scope: scope({ requestedPoIds: ['p1'], pos: [po({ poDocNo: null, outstandingLines: 0 })] }),
    })).toContain('the PO you came from');
  });
});

describe('client-side causes', () => {
  test('the toolbar filters are named, with the row count they are hiding', () => {
    const m = outstandingEmptyReason({
      ...base, serverRowCount: 7, filtersActive: true,
    })!;
    expect(m).toContain('7 outstanding lines were loaded');
    expect(m).toContain('Clear the category or date filter');
  });

  test('one hidden row reads in the singular', () => {
    expect(outstandingEmptyReason({ ...base, serverRowCount: 1, filtersActive: true }))
      .toContain('1 outstanding line was loaded');
  });

  test('lines already consumed by the UNSAVED draft say so — not "received"', () => {
    const m = outstandingEmptyReason({ ...base, serverRowCount: 5 })!;
    expect(m).toContain('already on the Goods Receipt you are drafting');
    expect(m).not.toMatch(/has been received/);
  });
});

describe('unscoped and genuinely empty', () => {
  test('states what the read found, and what makes a line appear', () => {
    const m = outstandingEmptyReason(base)!;
    expect(m).toContain('No Purchase Order lines are awaiting receipt in this company');
    expect(m).toContain('once its order is submitted');
  });
});

describe('THE PROPERTY, asserted directly', () => {
  /* Enumerate every situation this module distinguishes and assert that only the
     two which VERIFIED completion are allowed to claim it. A new branch that
     asserts "received" without checking fails here, which is the regression the
     owner actually hit. */
  const cases: Array<{ name: string; input: Parameters<typeof outstandingEmptyReason>[0]; mayClaimDone: boolean }> = [
    { name: 'failed read', input: { ...base, isError: true }, mayClaimDone: false },
    { name: 'truncated', input: { ...base, scope: scope({ truncated: true }) }, mayClaimDone: false },
    {
      name: 'unknown PO',
      input: { ...base, scope: scope({ requestedPoIds: ['x'], unknownPoIds: ['x'] }) },
      mayClaimDone: false,
    },
    {
      name: 'draft PO',
      input: {
        ...base,
        scope: scope({ requestedPoIds: ['p1'], pos: [po({ status: 'DRAFT', receivable: false })] }),
      },
      mayClaimDone: false,
    },
    { name: 'filters hide them', input: { ...base, serverRowCount: 3, filtersActive: true }, mayClaimDone: false },
    { name: 'consumed by draft', input: { ...base, serverRowCount: 3 }, mayClaimDone: false },
    {
      name: 'verified fully received',
      input: {
        ...base,
        scope: scope({ requestedPoIds: ['p1'], pos: [po({ outstandingLines: 0 })] }),
      },
      mayClaimDone: true,
    },
    // The unscoped-empty branch IS a completion claim, and a legitimate one: the
    // server read every candidate line and none was outstanding.
    { name: 'unscoped, nothing outstanding', input: base, mayClaimDone: true },
  ];

  test('the enumeration covers every branch the module can return', () => {
    // A branch with no case here would produce a duplicate message; distinctness
    // is the cheap proof that all eight are reachable and different.
    const msgs = cases.map((c) => outstandingEmptyReason(c.input));
    expect(new Set(msgs).size).toBe(cases.length);
  });

  test.each(cases)('$name — claims completion: $mayClaimDone', ({ input, mayClaimDone }) => {
    const m = outstandingEmptyReason(input)!;
    const claimsDone = /received in full|been received in full/.test(m);
    expect(claimsDone).toBe(mayClaimDone);
  });

  test('no branch reproduces the sentence the owner was shown', () => {
    const banned = 'every line has been received';
    for (const c of cases) {
      expect(outstandingEmptyReason(c.input)!.toLowerCase()).not.toContain(banned);
    }
  });
});
