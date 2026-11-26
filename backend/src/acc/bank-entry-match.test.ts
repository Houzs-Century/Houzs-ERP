
import { describe, it, expect } from 'vitest';
import {
  entryCandidatesFor, ENTRY_MATCH_WINDOW_DAYS,
  type EntryCandidateSource,
} from './bank-match';

const entry = (over: Partial<EntryCandidateSource> = {}): EntryCandidateSource => ({
  jeNo: '2990-JE-2602-0002',
  entryDate: '2026-02-07',
  sourceType: 'RCT',
  sourceDocNo: '2990-OR-2609-001',
  debitSen: 300000,
  creditSen: 0,
  ...over,
});

/* The owner's own screen, 2026-09-09: a RM 3,000 transfer into the bank on
   2026-02-07 and the RM 3,000 receipt posted the same day. */
const MOVEMENT = { bookedOn: '2026-02-07', amountSen: 300000 };

describe('the entry a movement plainly is', () => {
  it('is offered, with its direction and its distance named', () => {
    const [c] = entryCandidatesFor(MOVEMENT, [entry()], new Set());
    expect(c).toBeTruthy();
    expect(c!.jeNo).toBe('2990-JE-2602-0002');
    expect(c!.amountSen).toBe(300000);
    expect(c!.daysApart).toBe(0);
  });

  it('carries the source through, because a je number alone identifies nothing', () => {
    const [c] = entryCandidatesFor(MOVEMENT, [entry()], new Set());
    expect(c!.sourceType).toBe('RCT');
    expect(c!.sourceDocNo).toBe('2990-OR-2609-001');
  });
});

describe('the amount', () => {
  it('must agree to the sen — fifty sen out is not a candidate', () => {
    expect(entryCandidatesFor(MOVEMENT, [entry({ debitSen: 300050 })], new Set())).toEqual([]);
    expect(entryCandidatesFor(MOVEMENT, [entry({ debitSen: 299950 })], new Set())).toEqual([]);
  });

  it('must agree in DIRECTION — money out is not money in', () => {
    const paidOut = entry({ debitSen: 0, creditSen: 300000 });
    expect(entryCandidatesFor(MOVEMENT, [paidOut], new Set())).toEqual([]);
    const found = entryCandidatesFor({ bookedOn: '2026-02-07', amountSen: -300000 }, [paidOut], new Set());
    expect(found).toHaveLength(1);
    expect(found[0]!.amountSen).toBe(-300000);
  });

  it('reads an entry that touches the account twice as its net', () => {
    const both = entry({ debitSen: 500000, creditSen: 200000 });
    expect(entryCandidatesFor(MOVEMENT, [both], new Set())).toHaveLength(1);
  });
});

describe('an entry another movement already claims', () => {
  it('is not offered at all', () => {
    expect(entryCandidatesFor(MOVEMENT, [entry()], new Set(['2990-JE-2602-0002']))).toEqual([]);
  });

  it('does not hide the others', () => {
    const list = entryCandidatesFor(MOVEMENT, [
      entry(),
      entry({ jeNo: '2990-JE-2602-0009' }),
    ], new Set(['2990-JE-2602-0002']));
    expect(list.map((c) => c.jeNo)).toEqual(['2990-JE-2602-0009']);
  });
});

describe('the window', () => {
  it('reaches a cheque banked on Friday and cleared on Monday', () => {
    const later = entry({ entryDate: '2026-02-04' });
    const [c] = entryCandidatesFor(MOVEMENT, [later], new Set());
    expect(c!.daysApart).toBe(3);
  });

  it('reaches exactly as far as it says and no further', () => {
    const edge = entry({ entryDate: '2026-01-31' });
    const beyond = entry({ jeNo: 'X', entryDate: '2026-01-30' });
    expect(ENTRY_MATCH_WINDOW_DAYS).toBe(7);
    expect(entryCandidatesFor(MOVEMENT, [edge], new Set())).toHaveLength(1);
    expect(entryCandidatesFor(MOVEMENT, [beyond], new Set())).toEqual([]);
  });

  it('reaches both ways — an entry posted after the bank saw it still counts', () => {
    const after = entry({ entryDate: '2026-02-10' });
    expect(entryCandidatesFor(MOVEMENT, [after], new Set())).toHaveLength(1);
  });
});

describe('the order they are offered in', () => {
  it('puts the closest day first, and breaks a tie by the older entry', () => {
    const list = entryCandidatesFor(MOVEMENT, [
      entry({ jeNo: 'far', entryDate: '2026-02-11' }),
      entry({ jeNo: 'same-b', entryDate: '2026-02-07' }),
      entry({ jeNo: 'near', entryDate: '2026-02-08' }),
      entry({ jeNo: 'same-a', entryDate: '2026-02-07' }),
    ], new Set());
    expect(list.map((c) => c.jeNo)).toEqual(['same-a', 'same-b', 'near', 'far']);
  });
});

describe('what it refuses to guess about', () => {
  it('offers nothing for a movement with no date', () => {
    expect(entryCandidatesFor({ bookedOn: '', amountSen: 300000 }, [entry()], new Set())).toEqual([]);
    expect(entryCandidatesFor({ bookedOn: '2026-02', amountSen: 300000 }, [entry()], new Set())).toEqual([]);
  });

  it('skips an entry whose own date is unreadable rather than treating it as today', () => {
    expect(entryCandidatesFor(MOVEMENT, [entry({ entryDate: '' })], new Set())).toEqual([]);
  });

  it('offers nothing when the books hold nothing like it', () => {
    expect(entryCandidatesFor(MOVEMENT, [], new Set())).toEqual([]);
  });
});
