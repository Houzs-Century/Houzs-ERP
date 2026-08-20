// ac-preflight — the ERP says at SAVE time what the account book will refuse.
//
// Every test here is written to FAIL on the code as it stood before this module
// (origin/main @839fcaed0) and to pass after. The controls matter as much as the
// failures: over-blocking is the failure mode this change can introduce, and a
// gate that refuses a good document is worse than the silence it replaces.
import { describe, expect, test } from 'vitest';
import {
  acAgentProblem, acAgentIsSendable, acNotSentProblems, AC_NOT_SENT,
} from './ac-preflight';
import { collectSoConfirmProblems } from './so-confirm-gate';
import {
  resolveAcAgent, composeDetails, composeCreatePo, MissingCreditorError,
  type ErpLine, type ErpPoHeader,
} from '../../services/autocount-writeback';
import { ItemCodeError } from '../../services/autocount-item-code';
import rawPreflight from './ac-preflight.ts?raw';
import rawOutbox from './autocount-outbox.ts?raw';

const codes = (ps: Array<{ code: string }>) => ps.map((p) => p.code);
const messages = (ps: Array<{ message: string }>) => ps.map((p) => p.message).join(' || ');

/* A confirmable order in every respect EXCEPT the salesperson, so a problem in
   these tests can only have come from the salesperson rule. */
const CONFIRMABLE = {
  salespersonId: 'staff-1' as string | null,
  agent: null as string | null,
  venue: 'PJ Showroom',
  venueId: null,
  lines: [{ itemCode: 'AKEMI APEX MATT (SP)', group: 'mattress' }],
  nonCatalogCodes: [] as string[],
};

// ── THE BLOCK: a salesperson the ACCOUNT BOOK can be given ──────────────────
//
// Refused at save, not five minutes later, because the fix is the Salesperson
// field on the screen the operator is already looking at.
describe('the confirm gate asks the composer its own question', () => {
  /* THE BUG, in one assertion. HC-SO-2607-008's real value. Before this change
     the gate returned NO problem for it and `composeCreateSo` then threw
     MissingAgentError into a `skipped` row — the operator got a 201 and the
     order never reached the accounts. */
  test('"Unassigned" with no salesperson is REFUSED at confirm', () => {
    const problems = collectSoConfirmProblems({
      ...CONFIRMABLE, salespersonId: null, agent: 'Unassigned',
    });
    expect(codes(problems)).toContain('salesperson_required');
    /* And it names the text, not a field the operator has already filled in —
       being told to "assign a salesperson" while the box visibly says
       "Unassigned" is the circle so-location-gate.ts warns about. */
    expect(messages(problems)).toContain('"Unassigned"');
    expect(messages(problems)).toContain('Pick a salesperson');
  });

  /* The OTHER shape production actually holds in `agent`: a bare scm.staff
     UUID (useStaffLookup carries a UUID_RE for exactly this). It is not a
     person's name and `/ensure-masters` would open a sales agent under it. */
  test('a bare staff UUID in `agent` with no salesperson is REFUSED', () => {
    expect(codes(collectSoConfirmProblems({
      ...CONFIRMABLE, salespersonId: null, agent: '3f7c1e2a-0000-4000-8000-000000000000',
    }))).toContain('salesperson_required');
  });

  test('nothing at all still refuses, with the sentence it always had', () => {
    const problems = collectSoConfirmProblems({ ...CONFIRMABLE, salespersonId: null, agent: '  ' });
    expect(codes(problems)).toContain('salesperson_required');
    expect(messages(problems)).toContain('A salesperson must be assigned');
  });

  // ── CONTROLS: what must NOT be refused ────────────────────────────────────
  test('CONTROL — a linked salesperson passes, agent text or none', () => {
    expect(codes(collectSoConfirmProblems(CONFIRMABLE))).not.toContain('salesperson_required');
    expect(codes(collectSoConfirmProblems({ ...CONFIRMABLE, agent: 'Unassigned' })))
      .not.toContain('salesperson_required');
  });

  test('CONTROL — an agent the account book already spells passes', () => {
    for (const agent of ['ZACK', 'Lim', 'kar jiun', 'MEI TING']) {
      expect(codes(collectSoConfirmProblems({ ...CONFIRMABLE, salespersonId: null, agent })))
        .not.toContain('salesperson_required');
    }
  });

  /* THE ANTI-DRIFT ASSERTION, and the reason this module exists. The gate and
     the composer must answer the SAME question about the SAME order — they
     disagreed before, which is how "Unassigned" walked through Save and died
     in the queue. This holds by construction now (the gate calls
     `resolveAcAgent`), and it is pinned so it cannot stop holding. */
  test('CONTROL — gate and composer never disagree about an unlinked order', () => {
    const texts = [
      null, '', '   ', 'Unassigned', 'unassigned', 'ZACK', 'Zack', 'Lim',
      'KAR JIUN', 'Chea Huan', 'Someone Hired Last Week', 'N/A', '-',
      '3f7c1e2a-0000-4000-8000-000000000000',
    ];
    for (const agent of texts) {
      const gateRefuses = codes(collectSoConfirmProblems({
        ...CONFIRMABLE, salespersonId: null, agent,
      })).includes('salesperson_required');
      const composerRefuses = resolveAcAgent(agent, null) === null;
      expect({ agent, gateRefuses }).toEqual({ agent, gateRefuses: composerRefuses });
    }
  });

  /* A rep hired since the 2026-08-05 cutover is in no map. `resolveAcAgent`
     step 3 trusts a real `scm.staff.name` unmapped and /ensure-masters opens
     it, so the gate must not refuse them either — that would be the
     over-blocking this change is most at risk of. */
  test('CONTROL — a salesperson hired since the cutover is not refused', () => {
    expect(acAgentIsSendable(null, 'Nurul Hidayah')).toBe(true);
    expect(acAgentProblem({ salespersonId: null, agent: null, salespersonName: 'Nurul Hidayah' }))
      .toBeNull();
  });
});

// ── THE WARNS: saved, but the accounts will not see it ──────────────────────
//
// Not refused, because the remedy is master data the operator does not own.
// The document is committed by the time these are known; a 422 would be a lie.

/** A line in the shape composeDetails takes. */
const line = (item: string): ErpLine => ({
  item_code: item,
  description: 'a line',
  qty: 1,
  unit_price_sen: 10000,
  location: 'HQ',
} as unknown as ErpLine);

describe('a purchase-order line the accounts cannot pin to one item', () => {
  /* MEASURED against the compiled cutover map, not invented: '9028-1S' is one
     of the 117 ERP codes the cutover collapsed from several AutoCount items,
     and 400-H004 owns none of them. This is the ONE cause the diagnosis found
     still reachable by a document raised today. */
  const AMBIGUOUS = '9028-1S';
  const FOREIGN_CREDITOR = '400-H004';

  const refusalFor = (supplierCode: string | null) => {
    try {
      composeDetails([line(AMBIGUOUS)], { supplierCode });
      return null;
    } catch (e) { return e; }
  };

  test('the composer still refuses it — the cause is live, not a stale record', () => {
    const e = refusalFor(FOREIGN_CREDITOR);
    expect(e).toBeInstanceOf(ItemCodeError);
  });

  test('and the operator is told, with somewhere to go', () => {
    const problems = acNotSentProblems(refusalFor(FOREIGN_CREDITOR), 'purchase order');
    expect(problems).toHaveLength(1);
    expect(problems[0].code).toBe(AC_NOT_SENT);
    expect(problems[0].line).toBe(AMBIGUOUS);
    const m = problems[0].message;
    // says it is NOT in the accounts...
    expect(m).toContain('has NOT reached the accounts');
    // ...names the offending code...
    expect(m).toContain(AMBIGUOUS);
    // ...and names the next step, both halves of it.
    expect(m).toContain('supplier the product is actually bought from');
    expect(m).toContain('retired');
  });

  /* CONTROL, and it is the whole reason this check lives on the PURCHASE side
     only: a sales order names no supplier, and since PR #2119 the resolver
     answers with the ERP's own code for /ensure-masters to open. Warning a
     salesperson about this would be noise, and noise is how an operator learns
     to stop reading warnings. */
  test('CONTROL — the same line on a document with no supplier is not refused', () => {
    expect(refusalFor(null)).toBeNull();
    expect(acNotSentProblems(refusalFor(null), 'sales order')).toEqual([]);
  });

  test('CONTROL — an unambiguous line under the same creditor is not refused', () => {
    expect(refusalFor(FOREIGN_CREDITOR)).toBeInstanceOf(ItemCodeError);
    try {
      composeDetails([line('AKEMI APEX MATT (SP)')], { supplierCode: FOREIGN_CREDITOR });
    } catch (e) { expect(e).toBeNull(); /* must not throw */ }
  });

  /* EVERY failing line, not the first — an operator who fixes one and re-saves
     into the next is how a divergence outlives everyone who remembers it. */
  test('every failing line is named, not just the first', () => {
    let e: unknown = null;
    try { composeDetails([line(AMBIGUOUS), line(AMBIGUOUS)], { supplierCode: FOREIGN_CREDITOR }); }
    catch (err) { e = err; }
    expect(acNotSentProblems(e, 'purchase order')).toHaveLength(2);
  });
});

describe('a supplier with no AutoCount creditor code', () => {
  const poHeader = (creditorCode: string | null): ErpPoHeader => ({
    id: 'po-1',
    company_id: 1,
    supplier_id: 'sup-1',
    po_number: 'HC-PO-2608-001',
    po_date: '2026-08-19',
    creditor_code: creditorCode,
    creditor_name: 'A Supplier',
    agent: 'OTHERS',
    ref: null,
    notes: null,
    linked_ac_docno: null,
  } as unknown as ErpPoHeader);

  const refusalFor = (creditorCode: string | null) => {
    try {
      composeCreatePo(poHeader(creditorCode), [line('AKEMI APEX MATT (SP)')]);
      return null;
    } catch (e) { return e; }
  };

  test('the composer refuses it — so nothing was ever queued, and nothing said so', () => {
    expect(refusalFor(null)).toBeInstanceOf(MissingCreditorError);
    /* A BLANK code is the same hole as a missing one: `present()` drops blank
       keys on the transfer branch, so an empty string reaches AutoCount as an
       absent CreditorCode either way. */
    expect(refusalFor('   ')).toBeInstanceOf(MissingCreditorError);
  });

  test('and the operator is told whose job the fix is', () => {
    const problems = acNotSentProblems(refusalFor(null), 'purchase order');
    expect(problems).toHaveLength(1);
    expect(problems[0].code).toBe(AC_NOT_SENT);
    expect(problems[0].message).toContain('has NOT reached the accounts');
    expect(problems[0].message).toContain('no AutoCount creditor code');
    expect(problems[0].message).toContain('Ask accounts');
  });

  test('CONTROL — a supplier that has a code is not refused and says nothing', () => {
    expect(refusalFor('400-H004')).toBeNull();
    expect(acNotSentProblems(refusalFor('400-H004'), 'purchase order')).toEqual([]);
  });
});

describe('what this module refuses to say', () => {
  /* An operator warned about something that did not happen stops reading
     warnings, so an exception the composer did not raise as a NAMED refusal
     produces no sentence at all. autocount-outbox.ts's own handler takes the
     same view, and this is the line that keeps the two aligned. */
  test('an error the composer never named produces no warning', () => {
    expect(acNotSentProblems(new TypeError('x is not a function'), 'sales order')).toEqual([]);
    expect(acNotSentProblems(null)).toEqual([]);
    expect(acNotSentProblems(undefined)).toEqual([]);
  });

  test('a document that composed cleanly says nothing at all', () => {
    expect(acNotSentProblems(null, 'purchase order')).toEqual([]);
  });
});

/* ── the two lists that must not drift apart ────────────────────────────────
   A refusal is surfaced TWICE and by two different mechanisms, and each one is
   an instanceof chain someone has to remember to extend:

     noteReadFailure (autocount-outbox.ts)  -> the durable outbox row, which is
       what an ENGINEER reads. Anything missing from its chain hits the early
       return: no row, no console line, nothing.
     acNotSentProblems (this module)        -> the sentence the OPERATOR reads.
       Anything missing from its chain returns [] — saved, not sent, nobody told.

   Both were silently incomplete for the same error class on 2026-08-20
   (`AcSoToPoAlignmentError`, added by the SO-to-PO whole-master change), which
   is what this test exists to make impossible to repeat. It reads the two
   SOURCES rather than calling the functions, because the failure is a missing
   branch and a missing branch cannot be provoked by any input. */
describe('every refusal reaches BOTH the queue and the operator', () => {
  /** The error classes an `e instanceof X` chain names, inside one function. */
  const instanceOfChain = (source: string, from: string, to: string): string[] => {
    const a = source.indexOf(from);
    expect(a, `anchor missing: ${from}`).toBeGreaterThanOrEqual(0);
    const b = source.indexOf(to, a + from.length);
    expect(b, `anchor missing after ${from}: ${to}`).toBeGreaterThan(a);
    const body = source.slice(a, b);
    return [...new Set([...body.matchAll(/e instanceof ([A-Za-z0-9_]+)/g)].map((m) => m[1]))].sort();
  };

  test('the outbox row and the operator sentence name the SAME error classes', () => {
    const queue = instanceOfChain(
      rawOutbox.replace(/\r\n/g, '\n'),
      'async function noteReadFailure(',
      'const message = (e as Error).message;',
    );
    const operator = instanceOfChain(
      rawPreflight.replace(/\r\n/g, '\n'),
      'export function acNotSentProblems(',
      'Anything else is not a refusal the composer named',
    );

    /* Named both ways round, so the failure says WHICH side is short rather
       than printing two sorted arrays and leaving the reader to diff them. */
    const noSentence = queue.filter((k) => !operator.includes(k));
    const noQueueRow = operator.filter((k) => !queue.includes(k));
    expect(noSentence, `refused into the outbox with no operator sentence: ${noSentence.join(', ')}`).toEqual([]);
    expect(noQueueRow, `has an operator sentence but is swallowed by the enqueue: ${noQueueRow.join(', ')}`).toEqual([]);
    // A positive control: an empty chain on either side would satisfy both filters.
    expect(queue.length, 'the chain was read, not missed').toBeGreaterThan(5);
  });
});
