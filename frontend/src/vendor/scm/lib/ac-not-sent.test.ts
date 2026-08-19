// ac-not-sent — reading "the accounts have not got it" off a save response.
//
// The controls here are the point. This runs on the SUCCESS path of every
// create, so the one thing it must never do is turn a clean save into a popup
// — an operator who is shown a warning after an ordinary order stops reading
// warnings, and the next real one goes past them.
import { describe, expect, test } from 'vitest';
import {
  acNotSentProblemsOf, acNotSentTitle, AC_NOT_SENT_KEY, AC_NOT_SENT_TONE,
} from './ac-not-sent';

const PROBLEM = {
  code: 'ac_not_sent',
  message: 'Saved. This purchase order is in the ERP, but it has NOT reached the accounts…',
  field: 'Supplier',
};

describe('what the response says', () => {
  test('a refused document yields its reasons, verbatim', () => {
    const out = acNotSentProblemsOf({ id: 'po-1', poNumber: 'HC-PO-1', acNotSent: [PROBLEM] });
    expect(out).toEqual([PROBLEM]);
    /* VERBATIM matters: the sentence is written by the backend module that also
       decides the document is unsendable, so a surface that reworded it would
       be describing a rule it does not own. */
    expect(out[0].message).toBe(PROBLEM.message);
  });

  test('every reason, not the first — one fix at a time is the shape being fixed', () => {
    const two = [PROBLEM, { ...PROBLEM, line: '9028-1S' }];
    expect(acNotSentProblemsOf({ acNotSent: two })).toHaveLength(2);
  });

  // ── CONTROLS: the ordinary save must stay silent ──────────────────────────
  test('CONTROL — a clean save says nothing', () => {
    expect(acNotSentProblemsOf({ docNo: 'HC-SO-1' })).toEqual([]);
    expect(acNotSentProblemsOf({ id: 'po-1', poNumber: 'HC-PO-1' })).toEqual([]);
  });

  test('CONTROL — an empty list is not a warning', () => {
    expect(acNotSentProblemsOf({ docNo: 'HC-SO-1', acNotSent: [] })).toEqual([]);
  });

  test('CONTROL — nothing here may throw on the success path', () => {
    for (const res of [null, undefined, 'text', 42, [], { acNotSent: 'nope' }, { acNotSent: null }]) {
      expect(acNotSentProblemsOf(res)).toEqual([]);
    }
  });

  test('CONTROL — an entry with no message is dropped, not rendered blank', () => {
    expect(acNotSentProblemsOf({ acNotSent: [{ code: 'x' }, null, PROBLEM] })).toEqual([PROBLEM]);
  });
});

describe('the frame around the reasons', () => {
  /* Both halves, because half of it is good news. A title that said only
     "failed" sends someone to re-enter a document that already exists. */
  test('the title says the document EXISTS and the accounts have not got it', () => {
    const t = acNotSentTitle('Purchase order');
    expect(t).toContain('Purchase order');
    expect(t).toContain('saved');
    expect(t).toContain('accounts have not got it');
    expect(t.toLowerCase()).not.toContain('failed');
  });

  test('the tone is not the error tone — the save succeeded', () => {
    expect(AC_NOT_SENT_TONE).toBe('info');
  });

  /* The backend writes this exact key (backend/tests/acNotSentWiring.test.ts is
     the referee across the two packages); pinned here too so a rename inside
     this module is caught by its own suite first. */
  test('the key is the one the backend writes', () => {
    expect(AC_NOT_SENT_KEY).toBe('acNotSent');
  });
});
