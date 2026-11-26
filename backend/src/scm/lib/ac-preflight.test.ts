import { describe, expect, test } from 'vitest';
import {
  acAgentProblem, acAgentIsSendable, acNotSentProblems, AC_NOT_SENT,
  acNotCarriedProblems, AC_SENT_INCOMPLETE,
} from './ac-preflight';
import { downstreamNotCarried } from './autocount-convert-lines';
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

const CONFIRMABLE = {
  salespersonId: 'staff-1' as string | null,
  agent: null as string | null,
  venue: 'PJ Showroom',
  venueId: null,
  lines: [{ itemCode: 'AKEMI APEX MATT (SP)', group: 'mattress' }],
  nonCatalogCodes: [] as string[],
};

describe('the confirm gate asks the composer its own question', () => {
  test('"Unassigned" with no salesperson is REFUSED at confirm', () => {
    const problems = collectSoConfirmProblems({
      ...CONFIRMABLE, salespersonId: null, agent: 'Unassigned',
    });
    expect(codes(problems)).toContain('salesperson_required');
    expect(messages(problems)).toContain('"Unassigned"');
    expect(messages(problems)).toContain('Pick a salesperson');
  });

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

  test('CONTROL — a salesperson hired since the cutover is not refused', () => {
    expect(acAgentIsSendable(null, 'Nurul Hidayah')).toBe(true);
    expect(acAgentProblem({ salespersonId: null, agent: null, salespersonName: 'Nurul Hidayah' }))
      .toBeNull();
  });
});


const line = (item: string): ErpLine => ({
  item_code: item,
  description: 'a line',
  qty: 1,
  unit_price_sen: 10000,
  location: 'HQ',
} as unknown as ErpLine);

describe('a purchase-order line the accounts cannot pin to one item', () => {
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
    expect(m).toContain('has NOT reached the accounts');
    expect(m).toContain(AMBIGUOUS);
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
    } catch (e) { expect(e).toBeNull(); }
  });

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
  test('an error the composer never named produces no warning', () => {
    expect(acNotSentProblems(new TypeError('x is not a function'), 'sales order')).toEqual([]);
    expect(acNotSentProblems(null)).toEqual([]);
    expect(acNotSentProblems(undefined)).toEqual([]);
  });

  test('a document that composed cleanly says nothing at all', () => {
    expect(acNotSentProblems(null, 'purchase order')).toEqual([]);
  });
});

describe('it IS in the accounts, and part of it is not', () => {
  test('its own code, because the other one would be a false sentence', () => {
    expect(AC_SENT_INCOMPLETE).toBe('ac_sent_incomplete');
    expect(AC_SENT_INCOMPLETE).not.toBe(AC_NOT_SENT);
    const [p] = acNotCarriedProblems(['Ref: the ERP document has none'], 'goods receipt');
    expect(p.code).toBe(AC_SENT_INCOMPLETE);
    expect(p.message).toContain('IS in the accounts');
    expect(p.message).toContain('goods receipt');
    expect(p.message).not.toContain('NOT reached');
  });

  test('one problem per field, never one listing them all', () => {
    const ps = acNotCarriedProblems(['A: x', 'B: y', 'C: z'], 'delivery order');
    expect(ps).toHaveLength(3);
    expect(codes(ps)).toEqual([AC_SENT_INCOMPLETE, AC_SENT_INCOMPLETE, AC_SENT_INCOMPLETE]);
    expect(messages(ps)).toContain('A: x');
    expect(messages(ps)).toContain('C: z');
  });

  test('CONTROL — a document carrying everything says nothing at all', () => {
    expect(acNotCarriedProblems([], 'delivery order')).toEqual([]);
    expect(acNotCarriedProblems([])).toEqual([]);
  });

  test('the wording comes from the composer, and both silences reach the operator', () => {
    const bare = { id: 'x', grn_number: 'GR-1', received_at: '2026-08-18' };
    const ps = acNotCarriedProblems(downstreamNotCarried('GR', bare), 'goods receipt');
    expect(ps.length).toBeGreaterThan(0);
    expect(messages(ps)).toContain('SupplierDONo: the ERP document has none');
    const sales = acNotCarriedProblems(
      downstreamNotCarried('DO', { id: 'x', do_number: 'DO-1', do_date: '2026-08-19' }),
      'delivery order',
    );
    expect(messages(sales)).toContain('the ERP document has none');
  });
});

describe('every refusal reaches BOTH the queue and the operator', () => {
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
      '\n  return [];\n}\n',
    );

    const noSentence = queue.filter((k) => !operator.includes(k));
    const noQueueRow = operator.filter((k) => !queue.includes(k));
    expect(noSentence, `refused into the outbox with no operator sentence: ${noSentence.join(', ')}`).toEqual([]);
    expect(noQueueRow, `has an operator sentence but is swallowed by the enqueue: ${noQueueRow.join(', ')}`).toEqual([]);
    expect(queue.length, 'the chain was read, not missed').toBeGreaterThan(5);
  });
});
