/* The empty state must say WHY it is empty, and only a branch that COUNTED may
 * claim the work is finished.
 *
 * The owner's 2026-08-17 report is the negative case that gives this suite its
 * value: a PO that had never been received, scoped in the URL, rendering
 * "every line has been received". Each test below is one of the situations that
 * single sentence used to cover, and the last one asserts the property directly
 * — no branch says "received" unless it checked.
 *
 * The property test is written against the WORDS, not the branch index, because
 * the first version of it passed while the defect stood: it banned the literal
 * "every line has been received" and the unscoped branch said "every SUBMITTED
 * and PARTIALLY_RECEIVED order has been received in full" instead. The ban is
 * now on the CLAIM, in every phrasing this module can produce.
 */
import { describe, expect, test } from 'vitest';
import {
  outstandingEmptyReason, type EmptyReasonInput, type OutstandingScope, type ScopedPo,
} from './outstandingEmptyReason';

const po = (over: Partial<ScopedPo> = {}): ScopedPo => ({
  poId: 'p1', poDocNo: 'PO-2608-001', status: 'SUBMITTED',
  receivable: true, candidateLines: 2, outstandingLines: 1, ...over,
});

const scope = (over: Partial<OutstandingScope> = {}): OutstandingScope => ({
  requestedPoIds: [], pos: [], unknownPoIds: [], truncated: false, scanned: 0, ...over,
});

type Partialish = Partial<EmptyReasonInput>;
const at = (over: Partialish = {}): EmptyReasonInput => {
  const serverRowCount = over.serverRowCount ?? 0;
  return {
    isError: false, isLoading: false, scope: scope(),
    serverRowCount,
    scopedRowCount: over.scopedRowCount ?? serverRowCount,
    visibleRowCount: 0, filtersActive: false, poScopeActive: false,
    ...over,
  };
};

const base = at();

describe('nothing to explain', () => {
  test('rows are visible → no message at all', () => {
    expect(outstandingEmptyReason(at({ serverRowCount: 3, visibleRowCount: 3 }))).toBeNull();
  });
});

describe('a failed read outranks every other reason', () => {
  test('says the list is INCOMPLETE, never that it is finished', () => {
    const m = outstandingEmptyReason(at({ isError: true }))!;
    expect(m).toContain("couldn't load");
    expect(m).not.toMatch(/has been received|has already been received/);
  });

  test('it wins even when the scope would otherwise claim completion', () => {
    const m = outstandingEmptyReason(at({
      isError: true,
      scope: scope({ requestedPoIds: ['p1'], pos: [po({ outstandingLines: 0 })] }),
    }))!;
    expect(m).toContain("couldn't load");
  });
});

describe('the read stopped early — the owner-facing mechanism', () => {
  test('says lines are MISSING and explicitly denies the completion reading', () => {
    const m = outstandingEmptyReason(at({ scope: scope({ truncated: true }) }))!;
    expect(m).toContain('cut short');
    expect(m).toContain('does NOT mean there is nothing left to receive');
  });

  test('it offers the single-PO route, which reads only that order', () => {
    expect(outstandingEmptyReason(at({ scope: scope({ truncated: true }) })))
      .toContain('Open a single Purchase Order');
  });
});

describe('the status lookup failed', () => {
  test('a failed header read is NOT reported as "not in this company"', () => {
    const m = outstandingEmptyReason(at({
      scope: scope({ requestedPoIds: ['p1'], unknownPoIds: ['p1'], headerReadFailed: true }),
    }))!;
    expect(m).toContain("couldn't check the status");
    expect(m).not.toContain("not in this company's books");
    expect(m).not.toMatch(/received in full/);
  });

  test('an absent flag is read as "did not fail", so older payloads behave as before', () => {
    const s = scope({ requestedPoIds: ['p1'], unknownPoIds: ['p1'] });
    delete s.headerReadFailed;
    expect(outstandingEmptyReason(at({ scope: s }))).toContain("not in this company's books");
  });
});

describe('scoped to a PO this company does not hold', () => {
  test('one unknown id names the company problem instead of a completion', () => {
    const m = outstandingEmptyReason(at({
      scope: scope({ requestedPoIds: ['x'], unknownPoIds: ['x'] }),
    }))!;
    expect(m).toContain("not in this company's books");
    expect(m).not.toMatch(/received in full/);
  });

  test('several unknown ids are counted', () => {
    expect(outstandingEmptyReason(at({
      scope: scope({ requestedPoIds: ['x', 'y'], unknownPoIds: ['x', 'y'] }),
    }))).toContain('None of those 2 Purchase Orders');
  });
});

describe('scoped, but the STATUS excludes the PO', () => {
  test('a DRAFT PO is named as a draft, with the fix', () => {
    const m = outstandingEmptyReason(at({
      scope: scope({
        requestedPoIds: ['p1'],
        pos: [po({ status: 'DRAFT', receivable: false, candidateLines: 0, outstandingLines: 0 })],
      }),
    }))!;
    expect(m).toContain('PO-2608-001 is DRAFT');
    expect(m).toContain('Submit the order first');
    expect(m).not.toMatch(/received in full/);
  });

  test('a CANCELLED PO says CANCELLED', () => {
    expect(outstandingEmptyReason(at({
      scope: scope({
        requestedPoIds: ['p1'],
        pos: [po({ status: 'CANCELLED', receivable: false, candidateLines: 0, outstandingLines: 0 })],
      }),
    }))).toContain('is CANCELLED');
  });

  test('a NULL status is reported as unknown, not silently dropped', () => {
    expect(outstandingEmptyReason(at({
      scope: scope({
        requestedPoIds: ['p1'],
        pos: [po({ status: null, receivable: false, candidateLines: 0, outstandingLines: 0 })],
      }),
    }))).toContain('is in an unknown status');
  });

  test('two blocked POs are both named', () => {
    const m = outstandingEmptyReason(at({
      scope: scope({
        requestedPoIds: ['p1', 'p2'],
        pos: [
          po({ status: 'DRAFT', receivable: false, candidateLines: 0, outstandingLines: 0 }),
          po({
            poId: 'p2', poDocNo: 'PO-2608-002', status: 'CANCELLED',
            receivable: false, candidateLines: 0, outstandingLines: 0,
          }),
        ],
      }),
    }))!;
    expect(m).toContain('PO-2608-001 is DRAFT');
    expect(m).toContain('PO-2608-002 is CANCELLED');
  });

  test('a RECEIVED PO whose lines were counted at zero is FINISHED, not obstructed', () => {
    const m = outstandingEmptyReason(at({
      scope: scope({
        requestedPoIds: ['p1'],
        pos: [po({ status: 'RECEIVED', receivable: false, candidateLines: 2, outstandingLines: 0 })],
      }),
    }))!;
    expect(m).toContain('PO-2608-001 is RECEIVED');
    expect(m).toContain('already been received in full');
    expect(m).not.toMatch(/reopen it/);
  });

  test('a closed PO that STILL counts outstanding lines keeps the reopen advice', () => {
    const m = outstandingEmptyReason(at({
      scope: scope({
        requestedPoIds: ['p1'],
        pos: [po({ status: 'RECEIVED', receivable: false, candidateLines: 2, outstandingLines: 1 })],
      }),
    }))!;
    expect(m).toContain('PO-2608-001 is RECEIVED');
    expect(m).toContain('Submit the order first, or reopen it');
    expect(m).not.toMatch(/received in full/);
  });
});

describe('scoped, receivable, and GENUINELY fully received', () => {
  test('the one branch entitled to say the work is done says it about the NAMED document', () => {
    const m = outstandingEmptyReason(at({
      scope: scope({
        requestedPoIds: ['p1'],
        pos: [po({ status: 'PARTIALLY_RECEIVED', outstandingLines: 0, candidateLines: 3 })],
      }),
    }))!;
    expect(m).toBe(
      'Every line on PO-2608-001 has already been received in full, so there is '
      + 'nothing left to put on a Goods Receipt.',
    );
  });

  test('it does NOT fire while a toolbar filter could be the real cause', () => {
    const m = outstandingEmptyReason(at({
      filtersActive: true, serverRowCount: 4,
      scope: scope({ requestedPoIds: ['p1'], pos: [po({ outstandingLines: 0 })] }),
    }))!;
    expect(m).toContain('the filters above hide');
  });

  test('a filter that hid NOTHING still gets the named-document answer', () => {
    const m = outstandingEmptyReason(at({
      filtersActive: true, serverRowCount: 0,
      scope: scope({ requestedPoIds: ['p1'], pos: [po({ outstandingLines: 0, candidateLines: 3 })] }),
    }))!;
    expect(m).toContain('Every line on PO-2608-001');
    expect(m).not.toContain('in this company');
  });

  test('an unnamed PO degrades to a phrase, never to a bare "this PO has been received"', () => {
    expect(outstandingEmptyReason(at({
      scope: scope({ requestedPoIds: ['p1'], pos: [po({ poDocNo: null, outstandingLines: 0 })] }),
    }))).toContain('the PO you came from');
  });

  test('a receivable PO the read found NO lines for does not get a completion claim', () => {
    const m = outstandingEmptyReason(at({
      scope: scope({
        requestedPoIds: ['p1'], pos: [po({ candidateLines: 0, outstandingLines: 0 })],
      }),
    }))!;
    expect(m).toContain('This read found no outstanding lines on PO-2608-001');
    expect(m).toContain('not the same as everything having been received');
    expect(m).not.toMatch(/received in full/);
  });
});

describe('client-side causes, one branch each', () => {
  test("the SCREEN's own PO scope is named as itself, not as the toolbar or the draft", () => {
    const m = outstandingEmptyReason(at({
      serverRowCount: 6, scopedRowCount: 0, poScopeActive: true, scope: null,
    }))!;
    expect(m).toContain('None of the 6 outstanding PO line(s) that loaded match the filters');
    expect(m).toContain('Show all POs');
    expect(m).not.toContain('you are drafting');
  });

  test('without a PO scope it does not point at a control that is not on screen', () => {
    const m = outstandingEmptyReason(at({
      serverRowCount: 2, scopedRowCount: 0, poScopeActive: false, scope: null,
    }))!;
    expect(m).toContain('match the filters');
    expect(m).not.toContain('Show all POs');
  });

  test('the toolbar filters are named, with the row count they are hiding', () => {
    const m = outstandingEmptyReason(at({ serverRowCount: 7, filtersActive: true }))!;
    expect(m).toContain('7 outstanding lines were loaded');
    expect(m).toContain('Clear the category or date filter');
  });

  test('one hidden row reads in the singular', () => {
    expect(outstandingEmptyReason(at({ serverRowCount: 1, filtersActive: true })))
      .toContain('1 outstanding line was loaded');
  });

  test('lines already consumed by the UNSAVED draft say so — not "received"', () => {
    const m = outstandingEmptyReason(at({ serverRowCount: 5 }))!;
    expect(m).toContain('already on the Goods Receipt you are drafting');
    expect(m).not.toMatch(/has been received/);
  });
});

describe('unscoped and genuinely empty', () => {
  /* THE BLOCKER THIS BRANCH USED TO BE. It read "every SUBMITTED and
     PARTIALLY_RECEIVED order has been received in full" — a claim about every
     purchase order in the company, from an empty array. `scopeToCompany` FAILS
     CLOSED (`.in('company_id', [])` → `[]` with `error: null`), so a
     companies-master blip produces that identical empty answer while real
     outstanding orders sit in the operator's own company. #2367 removed exactly
     this sentence from this screen; the wording below is the one it shipped. */
  test('states what the read found and refuses the completion reading', () => {
    const m = outstandingEmptyReason(base)!;
    expect(m).toContain('This search came back with no outstanding PO lines');
    expect(m).toContain('not the same as everything having been received');
    expect(m).toContain('only covers the company you are working in');
    expect(m).not.toMatch(/received in full/);
  });
});

describe('THE PROPERTY, asserted directly', () => {
  const cases: Array<{ name: string; input: EmptyReasonInput; mayClaimDone: boolean }> = [
    { name: 'failed read', input: at({ isError: true }), mayClaimDone: false },
    { name: 'truncated', input: at({ scope: scope({ truncated: true }) }), mayClaimDone: false },
    {
      name: 'header read failed',
      input: at({ scope: scope({ requestedPoIds: ['p1'], unknownPoIds: ['p1'], headerReadFailed: true }) }),
      mayClaimDone: false,
    },
    {
      name: 'unknown PO',
      input: at({ scope: scope({ requestedPoIds: ['x'], unknownPoIds: ['x'] }) }),
      mayClaimDone: false,
    },
    {
      name: 'draft PO',
      input: at({
        scope: scope({
          requestedPoIds: ['p1'],
          pos: [po({ status: 'DRAFT', receivable: false, candidateLines: 0, outstandingLines: 0 })],
        }),
      }),
      mayClaimDone: false,
    },
    {
      name: 'closed PO, lines counted at zero',
      input: at({
        scope: scope({
          requestedPoIds: ['p1'],
          pos: [po({ status: 'RECEIVED', receivable: false, candidateLines: 2, outstandingLines: 0 })],
        }),
      }),
      mayClaimDone: true,
    },
    {
      name: 'receivable PO with NO counted lines',
      input: at({
        scope: scope({ requestedPoIds: ['p1'], pos: [po({ candidateLines: 0, outstandingLines: 0 })] }),
      }),
      mayClaimDone: false,
    },
    {
      name: "the screen's own scope hid them",
      input: at({ serverRowCount: 3, scopedRowCount: 0, poScopeActive: true, scope: null }),
      mayClaimDone: false,
    },
    { name: 'filters hide them', input: at({ serverRowCount: 3, filtersActive: true }), mayClaimDone: false },
    { name: 'consumed by draft', input: at({ serverRowCount: 3 }), mayClaimDone: false },
    {
      name: 'verified fully received',
      input: at({ scope: scope({ requestedPoIds: ['p1'], pos: [po({ outstandingLines: 0 })] }) }),
      mayClaimDone: true,
    },
    { name: 'unscoped, nothing returned', input: base, mayClaimDone: false },
  ];

  test('the enumeration covers every branch the module can return', () => {
    const msgs = cases.map((c) => outstandingEmptyReason(c.input));
    expect(new Set(msgs).size).toBe(cases.length);
  });

  test.each(cases)('$name — claims completion: $mayClaimDone', ({ input, mayClaimDone }) => {
    const m = outstandingEmptyReason(input)!;
    const claimsDone = /received in full/.test(m);
    expect(claimsDone).toBe(mayClaimDone);
  });

  test('no branch makes an unqualified completion claim', () => {
    const banned = [
      'every line has been received',
      'every submitted and partially_received order has been received',
      'there are no outstanding pos',
    ];
    for (const c of cases) {
      const m = outstandingEmptyReason(c.input)!.toLowerCase();
      for (const b of banned) expect(m).not.toContain(b);
    }
  });

  test('every completion claim names the document it is about', () => {
    for (const c of cases) {
      const m = outstandingEmptyReason(c.input)!;
      if (!/received in full/.test(m)) continue;
      expect(m).toMatch(/PO-2608-001|the PO you came from/);
    }
  });
});
