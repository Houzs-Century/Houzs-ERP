// ac-not-sent — reading "the accounts have not got it" off a save response.
//
// The controls here are the point. This runs on the SUCCESS path of every
// create, so the one thing it must never do is turn a clean save into a popup
// — an operator who is shown a warning after an ordinary order stops reading
// warnings, and the next real one goes past them.
import { describe, expect, test } from 'vitest';
import {
  acNotSentProblemsOf, acNotSentTitle, notifyAcNotSent,
  acSentIncompleteTitle, acTitleFor,
  AC_NOT_SENT_KEY, AC_NOT_SENT_TONE, AC_SENT_INCOMPLETE_CODE,
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

describe('showing it', () => {
  const spy = () => {
    const calls: Array<{ title: string; tone?: string }> = [];
    return {
      calls,
      notify: async (o: { title: string; tone?: 'info' | 'error' }) => {
        calls.push({ title: o.title, tone: o.tone });
      },
    };
  };

  test('a refused document opens one dialog, titled for the document', async () => {
    const s = spy();
    await notifyAcNotSent(s.notify, { acNotSent: [PROBLEM] }, 'Purchase order');
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].title).toBe(acNotSentTitle('Purchase order'));
    expect(s.calls[0].tone).toBe(AC_NOT_SENT_TONE);
  });

  /* THE CONTROL THAT MATTERS MOST. This runs on the success path of every
     create in the system; a dialog after an ordinary save is how an operator
     learns to click through warnings without reading them. */
  test('CONTROL — an ordinary save opens nothing at all', async () => {
    for (const res of [{ docNo: 'HC-SO-1' }, { acNotSent: [] }, null, undefined]) {
      const s = spy();
      await notifyAcNotSent(s.notify, res, 'Sales order');
      expect(s.calls).toEqual([]);
    }
  });
});

/* ── THE SECOND VERDICT ──────────────────────────────────────────────────────
   A TRANSFERRED document reaches the accounts and can still arrive without some
   of its fields: `SalesHeader` / `PurchaseHeader` apply a strictly narrower set
   than `/edit` does, and a value the ERP has none of is omitted rather than
   sent blank. That is a different fact from "the accounts have not got it", and
   showing it under the other title would send someone to re-raise a receipt the
   book already holds. */
describe('it IS in the accounts, and part of it is not', () => {
  const INCOMPLETE = {
    code: AC_SENT_INCOMPLETE_CODE,
    message: 'Saved, and this goods receipt IS in the accounts — but not all of it: '
      + 'SupplierDONo: the ERP document has none, so AutoCount keeps its own.',
  };

  test('the title says it arrived, and that not all of it did', () => {
    const t = acSentIncompleteTitle('Goods receipt');
    expect(t).toContain('Goods receipt');
    expect(t).toContain('sent');
    /* THE CONTROL. The other title's sentence would be false here, and a false
       reassurance is worse than none — it is what sends a person to enter the
       document a second time. */
    expect(t).not.toContain('have not got it');
    expect(t.toLowerCase()).not.toContain('failed');
  });

  test('the frame is chosen by the problems, not by the caller', () => {
    expect(acTitleFor([INCOMPLETE], 'Goods receipt')).toBe(acSentIncompleteTitle('Goods receipt'));
    expect(acTitleFor([PROBLEM], 'Purchase order')).toBe(acNotSentTitle('Purchase order'));
  });

  /* MIXED FALLS TO THE SAFER HEADLINE. Someone who checks a document that is
     actually there loses a minute; someone who does not check one that is
     missing loses it from the books. */
  test('a response carrying both verdicts uses the not-sent headline', () => {
    expect(acTitleFor([INCOMPLETE, PROBLEM], 'Invoice')).toBe(acNotSentTitle('Invoice'));
  });

  test('an empty list has no headline to choose and still opens nothing', async () => {
    expect(acTitleFor([], 'Invoice')).toBe(acNotSentTitle('Invoice'));
    const calls: Array<{ title: string }> = [];
    await notifyAcNotSent(async (o) => { calls.push({ title: o.title }); }, { acNotSent: [] }, 'Invoice');
    expect(calls).toEqual([]);
  });

  test('a transferred document opens ONE dialog, under the arrived-incomplete title', async () => {
    const calls: Array<{ title: string; tone?: string }> = [];
    await notifyAcNotSent(
      async (o) => { calls.push({ title: o.title, tone: o.tone }); },
      { acNotSent: [INCOMPLETE] },
      'Goods receipt',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].title).toBe(acSentIncompleteTitle('Goods receipt'));
    /* Still not the error tone: nothing failed. */
    expect(calls[0].tone).toBe(AC_NOT_SENT_TONE);
  });

  test('the code is the one the backend writes', () => {
    expect(AC_SENT_INCOMPLETE_CODE).toBe('ac_sent_incomplete');
    expect(AC_NOT_SENT_KEY).toBe('acNotSent');
  });
});
