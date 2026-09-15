/* A reversed journal and the contra that undid it are one correction, and the
   books show neither side (owner 2026-09-15: 照理就是对冲掉，所以都不应该显示，je
   可以留记录就好 — docs/bugs/0923). Pinned here, on the two readers that live in
   routes/accounting.ts:
     • GET /gl leaves both sides out, whatever period it is cut to — a contra
       dated in a later month is not that month's movement — and hands them
       back, flags and all, only when asked with showReversed=1;
     • GET /daily-bank counts neither side: an original dated on the board day
       whose contra came a fortnight later is not a receipt of that day.
   Real handlers, fake PostgREST (fakeSb). The statements and the receipts &
   payments carry the same rule in their own suites (accountingReports,
   rpReport); the reconciliation had it already (docs/bugs/0802). */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { dailyBankHandler, glStreamHandler } from '../src/scm/routes/accounting';

const CO = 2;
let lineId = 0;
const gl = (jeNo: string, date: string, source: string, code: string, dr: number, cr: number, extra: Row = {}): Row => ({
  line_id: ++lineId, company_id: CO, je_no: jeNo, entry_date: date, source_type: source, source_doc_no: null,
  line_no: 1, account_code: code, account_name: code, account_type: code.startsWith('3') ? 'ASSET' : 'INCOME',
  debit_sen: dr, credit_sen: cr, party_type: null, party_code: null, party_name: null, notes: null,
  posted: true, posted_at: `${date}T10:00:00Z`, reversed: false, reversed_by_je: null, ...extra,
});

/* An August sale of RM 1,000 (the books); an RM 500 sale keyed twice on the
   31st — its original flagged reversed and pointing at the contra, the contra
   dated 15 September pointing back (the shape acc/engine.ts reverseJournal
   writes). */
const LEDGER: Row[] = [
  gl('JE-2608-0001', '2026-08-31', 'SOPAY', '310-0010', 100_000, 0),
  gl('JE-2608-0001', '2026-08-31', 'SOPAY', '501-0000', 0, 100_000),
  gl('JE-2608-0002', '2026-08-31', 'SOPAY', '310-0010', 50_000, 0, { reversed: true, reversed_by_je: 'je-contra' }),
  gl('JE-2608-0002', '2026-08-31', 'SOPAY', '501-0000', 0, 50_000, { reversed: true, reversed_by_je: 'je-contra' }),
  gl('JE-2609-0007', '2026-09-15', 'SOPAY_REVERSAL', '501-0000', 50_000, 0, { reversed_by_je: 'je-original' }),
  gl('JE-2609-0007', '2026-09-15', 'SOPAY_REVERSAL', '310-0010', 0, 50_000, { reversed_by_je: 'je-original' }),
];

function harness() {
  const sb = fakeSb({
    v_gl_entries: LEDGER.map((r) => ({ ...r })),
    accounts: [
      { company_id: CO, account_code: '310-0010', account_name: 'CASH AT BANK - MAYBANK', account_type: 'ASSET', acc_money: true, is_active: true },
      { company_id: CO, account_code: '326-0000', account_name: 'CARD CLEARING', account_type: 'ASSET', acc_money: false, is_active: true },
      { company_id: CO, account_code: '501-0000', account_name: 'SALES', account_type: 'INCOME', acc_money: false, is_active: true },
    ],
    acc_acquirers: [],
    acc_account_roles: [],
    payment_vouchers: [],
  });
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('houzsUser' as never, { name: 'T', permissions_set: ['scm.payment_voucher.post'] } as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    await next();
  });
  app.get('/accounting/gl', glStreamHandler as never);
  app.get('/accounting/daily-bank', dailyBankHandler as never);
  return app;
}

type GlRow = { je_no: string; account_code: string; reversed: boolean; reversed_by_je: string | null };
const jeNos = (rows: GlRow[]) => [...new Set(rows.map((r) => r.je_no))].sort();

describe('GET /accounting/gl — a reversal pair is left out of the stream', () => {
  test('neither the reversed original nor its contra comes back, whatever the period', async () => {
    const app = harness();
    const all = (await (await app.request('/accounting/gl')).json()) as { glEntries: GlRow[] };
    expect(jeNos(all.glEntries)).toEqual(['JE-2608-0001']);
    /* Cut to September alone: the contra is the only entry of the month, and it is still nothing. */
    const sep = (await (await app.request('/accounting/gl?from=2026-09-01&to=2026-09-30')).json()) as { glEntries: GlRow[] };
    expect(sep.glEntries).toEqual([]);
    /* Cut to one account: the same rule. */
    const bank = (await (await app.request('/accounting/gl?accountCode=310-0010')).json()) as { glEntries: GlRow[] };
    expect(bank.glEntries.map((r) => r.je_no)).toEqual(['JE-2608-0001']);
  });

  test('asked for with showReversed=1, both sides come back carrying their flags — the journal keeps the record', async () => {
    const app = harness();
    const res = await app.request('/accounting/gl?showReversed=1');
    expect(res.status).toBe(200);
    const b = (await res.json()) as { glEntries: GlRow[] };
    expect(jeNos(b.glEntries)).toEqual(['JE-2608-0001', 'JE-2608-0002', 'JE-2609-0007']);
    const original = b.glEntries.filter((r) => r.je_no === 'JE-2608-0002');
    const contra = b.glEntries.filter((r) => r.je_no === 'JE-2609-0007');
    expect(original.every((r) => r.reversed === true && r.reversed_by_je === 'je-contra')).toBe(true);
    expect(contra.every((r) => r.reversed === false && r.reversed_by_je === 'je-original')).toBe(true);
    const books = b.glEntries.filter((r) => r.je_no === 'JE-2608-0001');
    expect(books.every((r) => r.reversed === false && r.reversed_by_je === null)).toBe(true);
  });
});

describe('GET /accounting/daily-bank — the board counts neither side', () => {
  test('an original dated on the board day, undone a fortnight later, is not that day\'s receipt', async () => {
    const app = harness();
    const res = await app.request('/accounting/daily-bank?date=2026-08-31');
    expect(res.status).toBe(200);
    const b = (await res.json()) as { blocks: Array<{ accountCode: string; receipts: Array<{ jeNo: string; amountSen: number }>; inSen: number; closingSen: number }>; totalClosingSen: number };
    const bank = b.blocks.find((x) => x.accountCode === '310-0010');
    expect(bank).toBeDefined();
    expect(bank!.receipts.map((r) => [r.jeNo, r.amountSen])).toEqual([['JE-2608-0001', 100_000]]);
    expect(bank!.inSen).toBe(100_000);
    expect(bank!.closingSen).toBe(100_000);
    expect(b.totalClosingSen).toBe(100_000);
  });
});
