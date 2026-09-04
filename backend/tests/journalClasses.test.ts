// The five journals (GL redesign item 7). Pinned:
//   • the fixed map (SI→SALES … STOCKADJ→GENERAL) and reversals following
//     their originals;
//   • the money-side documents split CASH vs BANK by the LINES they touch,
//     using the company's own CASH role — never a guess;
//   • the list endpoint labels every row and ?journal= filters on the label.

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { classifyJournal } from '../src/acc/journal-class';

const CO = 2;

describe('classifyJournal', () => {
  const CASH = '320-0000';
  test('the fixed map, reversals riding with their originals', () => {
    expect(classifyJournal('SI', [], CASH)).toBe('SALES');
    expect(classifyJournal('SI_REVERSAL', [], CASH)).toBe('SALES');
    expect(classifyJournal('PI', [], CASH)).toBe('PURCHASE');
    expect(classifyJournal('CASHUP', [], CASH)).toBe('CASH');
    expect(classifyJournal('SETTLE', [], CASH)).toBe('BANK');
    expect(classifyJournal('SETTLEBANK', [], CASH)).toBe('BANK');
    expect(classifyJournal('SETTLEADJ_REVERSAL', [], CASH)).toBe('BANK');
    expect(classifyJournal('STOCKADJ', [], CASH)).toBe('GENERAL');
    expect(classifyJournal('MANUAL', [], CASH)).toBe('GENERAL');
    expect(classifyJournal('SOMETHING_NEW', ['310-0010'], CASH)).toBe('GENERAL');
  });

  test('money-side documents follow their lines: drawer = CASH, anything else = BANK', () => {
    expect(classifyJournal('SOPAY', ['320-0000', '300-0000'], CASH)).toBe('CASH');
    expect(classifyJournal('SOPAY', ['310-0010', '300-0000'], CASH)).toBe('BANK');
    expect(classifyJournal('SIPAY', ['326-0000', '300-0000'], CASH)).toBe('BANK');
    expect(classifyJournal('PV', ['900-A001', '320-0000'], CASH)).toBe('CASH');
    expect(classifyJournal('PV_REVERSAL', ['900-A001', '310-0010'], CASH)).toBe('BANK');
  });
});

describe('GET /accounting/journal-entries — labelled and filterable', () => {
  async function harness() {
    const sb = fakeSb({
      journal_entries: [
        { id: 'j1', je_no: 'JE-1', entry_date: '2026-08-01', source_type: 'PI', source_doc_no: 'PI-1', total_debit_sen: 100, total_credit_sen: 100, posted: true, reversed: false, company_id: CO },
        { id: 'j2', je_no: 'JE-2', entry_date: '2026-08-02', source_type: 'SOPAY', source_doc_no: 'p1', total_debit_sen: 200, total_credit_sen: 200, posted: true, reversed: false, company_id: CO },
      ],
      journal_entry_lines: [
        { journal_entry_id: 'j1', account_code: '601-0003', company_id: CO },
        { journal_entry_id: 'j1', account_code: '400-0000', company_id: CO },
        { journal_entry_id: 'j2', account_code: '320-0000', company_id: CO },
        { journal_entry_id: 'j2', account_code: '300-0000', company_id: CO },
      ],
      acc_account_roles: [],
    });
    const { journalEntriesList } = await import('../src/scm/routes/accounting');
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('supabase' as never, sb as never);
      c.set('companyId' as never, CO as never);
      c.set('houzsUser' as never, { name: 'T', permissions_set: ['scm.payment_voucher.post'] } as never);
      c.set('allowedCompanyIds' as never, [CO] as never);
      await next();
    });
    app.get('/accounting/journal-entries', journalEntriesList as never);
    return { app };
  }

  test('every row carries its journal_class', async () => {
    const { app } = await harness();
    const res = await app.request('/accounting/journal-entries');
    expect(res.status).toBe(200);
    const body = await res.json() as { journalEntries: Array<{ je_no: string; journal_class: string }> };
    const byNo = new Map(body.journalEntries.map((r) => [r.je_no, r.journal_class]));
    expect(byNo.get('JE-1')).toBe('PURCHASE');
    expect(byNo.get('JE-2')).toBe('CASH'); // a collection into the drawer
  });

  test('?journal= filters on the label', async () => {
    const { app } = await harness();
    const res = await app.request('/accounting/journal-entries?journal=PURCHASE');
    const body = await res.json() as { journalEntries: Array<{ je_no: string }> };
    expect(body.journalEntries.map((r) => r.je_no)).toEqual(['JE-1']);
  });
});
