/* A month-end statement that repeats the any-day export (owner 2026-10-14, 2990's
   Hong Leong September: 「这个我重新上传会需要重新match 过？」 then 「B，做」).
   The month-end file printed 42 movements with more words ("… at KLM", a
   DuitNow id) and they came in again as still to decide. Pinned at the routes:
     • an upload leaves out a movement an earlier file recorded even when its
       print carries more words, naming where it is recorded; a new movement
       stays to decide;
     • POST /bank/statements/:id/repeats files the repeats of a statement already
       in the same way — the earlier file untouched, a different payee on the same
       day and amount left alone, a second press finding nothing;
     • the month says how many repeats wait, and of which files;
     • a closed month refuses, and nothing moves.
   The rule itself is pinned in src/acc/bank-repeats.test.ts. Real handlers, fake
   PostgREST. */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { bankUpload, bankStatementDetail, bankStatementRepeats } from '../src/scm/routes/accounting-bank';
import { bankMonthDetail } from '../src/scm/routes/accounting-bank-months';

const CO = 1;
const GL_PERM = 'scm.payment_voucher.post';
const ACCOUNT = '330-0000';

const MBB_ACCOUNT: Row = {
  id: 1, company_id: CO, account_code: ACCOUNT, bank_code: 'MBB',
  account_no: '0000564418610346', statement_format: 'CSV', delimiter: '|',
  amount_format: 'integer-sen', credit_indicator: 'CR', is_active: true,
  column_map: {
    date: 'EFFECT DATE', description: 'TRX DESCRIPTION', reference: 'TRX REFERENCE',
    amount: 'AMOUNT', indicator: 'AMOUNT IND',
  },
};
const HEAD = 'BATCH DATE|ACCOUNT NO.|PROD TYPE|EFFECT DATE|EFFECT TIME|BRANCH|TELLER|CODE|SOURCE CODE|AMOUNT|AMOUNT IND|TRX DESCRIPTION|TRX REFERENCE';
const row = (date: string, sen: string, ind: string, desc: string, ref: string) =>
  `${date}|0000564418610346|CA|${date}|103009|2988|CEB4PHON|7610|003|${sen}|${ind}|${desc}|${ref}`;

/* The any-day export: a card payout in, a claim paid out. */
const ANY_DAY = [
  HEAD,
  row('20260901', '000000000705426', 'CR', 'Cr Adv-Interbank GIRO', 'DMS A3 (FOR GHL) 161320P226260901 /GHL/6600030486'),
  row('20260902', '000000000500000', 'DR', 'CIB Instant Transfer', 'LOO WEN WEI Claim'),
].join('\n');
/* The month-end statement: the same two as Hong Leong prints them at month end,
   and one movement the export never carried. */
const MONTH_END = [
  HEAD,
  row('20260901', '000000000705426', 'CR', 'Cr Adv-Interbank GIRO at KLM', '161320P226260901 /GHL/6600030486 DMS A3 (FOR GHL)'),
  row('20260902', '000000000500000', 'DR', 'CIB Instant Transfer at DIO', 'Claim LOO WEN WEI 20260902HLBBMYKL010OCB90268183'),
  row('20260930', '000000000002500', 'DR', 'SERVICE CHARGE', 'BCHARGE9'),
].join('\n');

function harness(tables: Record<string, Row[]> = {}) {
  const sb = fakeSb(
    {
      accounts: [{ account_code: ACCOUNT, account_name: 'MAYBANK', account_type: 'ASSET', parent_code: null, is_active: true, company_id: CO }],
      acc_account_roles: [], acc_acquirers: [], acc_acquirer_config: [], acc_company_acquirers: [],
      acc_bank_statement_config: [MBB_ACCOUNT], acc_bank_recognition_rules: [],
      acc_bank_statements: [], acc_bank_statement_lines: [], acc_bank_statement_matches: [],
      acc_bank_month_balances: [], acc_bank_month_locks: [],
      acc_settlement_batches: [], acc_settlement_rows: [], acc_settlement_matches: [], acc_settlement_receipts: [],
      journal_entries: [], journal_entry_lines: [], v_gl_entries: [],
      ...tables,
    },
    {},
    [{ table: 'acc_bank_statements', column: 'file_hash', name: 'acc_bank_stmt_once' }],
    ['acc_bank_statements', 'acc_bank_statement_lines', 'acc_bank_statement_matches', 'acc_bank_month_balances',
      'acc_settlement_batches', 'acc_settlement_rows', 'acc_settlement_matches', 'acc_settlement_receipts'],
  );
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('houzsUser' as never, { name: 'Tester', permissions_set: [GL_PERM] } as never);
    c.set('allowedCompanyIds' as never, [1, 2] as never);
    await next();
  });
  app.post('/bank/statements', bankUpload as never);
  app.get('/bank/statements/:id', bankStatementDetail as never);
  app.post('/bank/statements/:id/repeats', bankStatementRepeats as never);
  app.get('/bank/months/:accountCode/:month', bankMonthDetail as never);
  return { app, sb };
}

const post = (app: Hono, path: string, body: Record<string, unknown> = {}) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const linesOf = (sb: ReturnType<typeof harness>['sb'], statementId: number) =>
  (sb.tables.acc_bank_statement_lines as Row[]).filter((l) => Number(l.statement_id) === statementId).sort((a, b) => Number(a.line_no) - Number(b.line_no));

describe('an upload after the any-day export', () => {
  test('the movements it repeats are left out, naming where they are; the new one waits', async () => {
    const { app, sb } = harness();
    const first = await (await post(app, '/bank/statements', { accountCode: ACCOUNT, fileName: 'Transaction_Statement_20260901_20260928.csv', content: ANY_DAY })).json() as any;
    const second = await post(app, '/bank/statements', { accountCode: ACCOUNT, fileName: 'acs_30092026.csv', content: MONTH_END });
    expect(second.status, await second.clone().text()).toBe(200);
    const { statementId } = await second.json() as any;
    expect(statementId).not.toBe(first.statementId);
    const lines = linesOf(sb, statementId);
    expect(lines.map((l) => [l.amount_sen, l.kind, l.state])).toEqual([
      [705426, 'DUPLICATE', 'IGNORED'], [-500000, 'DUPLICATE', 'IGNORED'], [-2500, 'OTHER', 'OPEN'],
    ]);
    expect(String(lines[0]!.note)).toContain('Transaction_Statement_20260901_20260928.csv (still open there)');
    expect(String(lines[0]!.note)).toContain('Leave it out unless the bank really paid twice.');
  });
});

describe('POST /bank/statements/:id/repeats — a statement already in', () => {
  /* Production's shape on 2026-10-14: the export's movement booked, the month-end
     file's print of it still to decide, plus a new movement and a different
     payee on the same day and amount. */
  const STATEMENTS: Row[] = [
    { id: 13, company_id: CO, account_code: ACCOUNT, file_name: 'Transaction_Statement_20260901_20260928.csv', period_from: '2026-09-01', period_to: '2026-09-30', line_count: 1, created_at: '2026-09-29T08:27:00Z' },
    { id: 14, company_id: CO, account_code: ACCOUNT, file_name: 'acs_23600602788_30092026.csv', period_from: '2026-09-01', period_to: '2026-09-30', line_count: 3, created_at: '2026-10-14T08:26:00Z' },
  ];
  const line = (id: number, statementId: number, over: Row): Row => ({
    id, statement_id: statementId, company_id: CO, line_no: id, booked_on: '2026-09-01', amount_sen: 705426, charge_sen: 0,
    kind: 'OTHER', state: 'OPEN', posted_je_no: null, note: null, acquirer_code: null, trading_date: null, merchant_no: null,
    matched_batch_id: null, split: null, contra_line_id: null, ...over,
  });
  const LINES = (): Row[] => [
    line(289, 13, { description: 'Cr Adv-Interbank GIRO', reference: 'DMS A3 (FOR GHL) 161320P226260901 /GHL/6600030486', state: 'POSTED', posted_je_no: '2990-JE-2609-0336' }),
    line(292, 14, { description: 'Cr Adv-Interbank GIRO at KLM', reference: '161320P226260901 /GHL/6600030486 DMS A3 (FOR GHL)', kind: 'PAYOUT_UNSURE' }),
    line(293, 14, { description: 'Instant Transfer at KLM', reference: 'AHMAD BIN ALI 20260901MBBEMYKL010ORM1' }),
    line(294, 14, { booked_on: '2026-09-30', amount_sen: -2500, description: 'SERVICE CHARGE', reference: 'BCHARGE9' }),
  ];

  test('files the repeat as a fresh upload would; the earlier file and the rest stay; a second press finds nothing', async () => {
    const { app, sb } = harness({ acc_bank_statements: STATEMENTS.map((s) => ({ ...s })), acc_bank_statement_lines: LINES() });
    const res = await post(app, '/bank/statements/14/repeats');
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ ok: true, leftOut: 1, lineIds: [292] });
    const byId = new Map((sb.tables.acc_bank_statement_lines as Row[]).map((l) => [Number(l.id), l]));
    expect(byId.get(292)).toMatchObject({ kind: 'DUPLICATE', state: 'IGNORED' });
    expect(String(byId.get(292)!.note)).toContain('2990-JE-2609-0336');
    expect(byId.get(289)).toMatchObject({ state: 'POSTED', posted_je_no: '2990-JE-2609-0336', kind: 'OTHER' });
    expect([byId.get(293)!.state, byId.get(294)!.state]).toEqual(['OPEN', 'OPEN']);
    expect(await (await post(app, '/bank/statements/14/repeats')).json()).toEqual({ ok: true, leftOut: 0, lineIds: [] });
    /* The earlier file has nothing earlier than itself to repeat. */
    expect(await (await post(app, '/bank/statements/13/repeats')).json()).toEqual({ ok: true, leftOut: 0, lineIds: [] });
  });

  test('the month says how many repeats wait, and of which files; none once they are left out', async () => {
    const { app } = harness({ acc_bank_statements: STATEMENTS.map((s) => ({ ...s })), acc_bank_statement_lines: LINES() });
    const before = await app.request(`/bank/months/${ACCOUNT}/2026-09`);
    expect(before.status, await before.clone().text()).toBe(200);
    expect((await before.json() as any).repeats).toEqual({ count: 1, statementIds: [14] });
    await post(app, '/bank/statements/14/repeats');
    expect((await (await app.request(`/bank/months/${ACCOUNT}/2026-09`)).json() as any).repeats).toEqual({ count: 0, statementIds: [] });
  });

  test('a closed month refuses, and nothing moves', async () => {
    const { app, sb } = harness({
      acc_bank_statements: STATEMENTS.map((s) => ({ ...s })),
      acc_bank_statement_lines: LINES(),
      acc_bank_month_locks: [{
        id: 1, company_id: CO, account_code: ACCOUNT, period_month: '2026-09-01', locked_by: 'Chew', locked_at: '2026-10-14T09:00:00Z',
        lock_note: null, closing_statement_sen: null, closing_ledger_sen: null, difference_sen: null, statement_count: 2, was_complete: true, released_at: null,
      }],
    });
    const res = await post(app, '/bank/statements/14/repeats');
    expect(res.status).toBe(409);
    expect((sb.tables.acc_bank_statement_lines as Row[]).find((l) => l.id === 292)!.state).toBe('OPEN');
  });
});

/* 2990's Hong Leong October (owner 2026-11-10: 「已经match 的就不需要去理会」). The
   month-end CSV printed three movements the any-day export had already matched
   in words neither inside the other's — a description cut short, a reference
   reordered — and they came in still to decide, the month RM 9,095.10 apart.
   Each pair carries the same transaction number, biller account or document
   number. The prints, statement and line numbers as stored. */
describe('October: the same movement worded differently is still a repeat', () => {
  const STATEMENTS: Row[] = [
    { id: 16, company_id: CO, account_code: ACCOUNT, file_name: 'Transaction_Statement_20261001_20261026.csv', period_from: '2026-10-01', period_to: '2026-10-31', line_count: 59, created_at: '2026-10-27T08:38:00Z' },
    { id: 23, company_id: CO, account_code: ACCOUNT, file_name: 'acs_23600602788_31102026 (1).csv', period_from: '2026-10-01', period_to: '2026-10-31', line_count: 80, created_at: '2026-11-10T02:53:00Z' },
  ];
  const line = (id: number, statementId: number, lineNo: number, bookedOn: string, amountSen: number, description: string, reference: string, over: Row = {}): Row => ({
    id, statement_id: statementId, company_id: CO, line_no: lineNo, booked_on: bookedOn, amount_sen: amountSen, charge_sen: 0, description, reference,
    kind: 'OTHER', state: 'OPEN', posted_je_no: null, note: null, acquirer_code: null, trading_date: null, merchant_no: null,
    matched_batch_id: null, split: null, contra_line_id: null, ...over,
  });
  const LINES = (): Row[] => [
    line(431, 16, 67, '2026-10-02', -7210, 'JomPAY Bill Payment', 'U MOBILE SDN BHD 30515721824 DA203JNP22610021822Y', { state: 'POSTED', posted_je_no: '2990-JE-2609-0379' }),
    line(429, 16, 65, '2026-10-02', -70000, 'Fund Trf fr CA to CA-Internet(B)', 'THE CONTS SDN. BHD. I-2608-063 2990-Draft-2609-030', { state: 'POSTED', posted_je_no: '2990-JE-2609-0377' }),
    line(403, 16, 39, '2026-10-12', -832300, 'Fund Trf from CA to SA via Internet (B)', 'CHOW WAI MAN TNB DEPOSIT n PRINT 2990-HPV-2610-013', { state: 'POSTED', posted_je_no: '2990-JE-2610-0204' }),
    line(1130, 23, 6, '2026-10-02', -7210, 'JomPAY Bill Payment at DIO', '30515721824 DA203JNP22610021822Y U MOBILE SDN BHD CIBJOM29092026039886'),
    line(1132, 23, 8, '2026-10-02', -70000, 'Fund Trf fr CA to CA-Internet(B)', 'I-2608-063 2990-Draft-2609-030 THE CONTS SDN. BHD.'),
    line(1158, 23, 34, '2026-10-12', -832300, 'Fund Trf from CA to SA via Intern', 'TNB DEPOSIT n PRINT 2990-HPV-2610-013 CHOW WAI MAN'),
    /* The next month's U Mobile bill: the same biller account, its own movement. */
    line(1192, 23, 68, '2026-10-27', -7210, 'JomPAY Bill Payment at DIO', '30515721824 DASMRCEV22610271127Y U MOBILE SDN BHD CIBJOM16102026050909'),
  ];

  test('"Leave out already recorded" files the three, naming the entry each is matched to; the later bill stays', async () => {
    const { app, sb } = harness({ acc_bank_statements: STATEMENTS.map((s) => ({ ...s })), acc_bank_statement_lines: LINES() });
    const res = await post(app, '/bank/statements/23/repeats');
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ ok: true, leftOut: 3, lineIds: [1130, 1132, 1158] });
    const byId = new Map((sb.tables.acc_bank_statement_lines as Row[]).map((l) => [Number(l.id), l]));
    expect([1130, 1132, 1158].map((id) => [byId.get(id)!.kind, byId.get(id)!.state])).toEqual([['DUPLICATE', 'IGNORED'], ['DUPLICATE', 'IGNORED'], ['DUPLICATE', 'IGNORED']]);
    expect(String(byId.get(1130)!.note)).toContain('2990-JE-2609-0379');
    expect(String(byId.get(1132)!.note)).toContain('2990-JE-2609-0377');
    expect(String(byId.get(1158)!.note)).toContain('2990-JE-2610-0204');
    expect(byId.get(1192)!.state).toBe('OPEN');
  });

  test('and an upload of the month-end file leaves them out on the way in', async () => {
    const { app, sb } = harness();
    const anyDay = [HEAD,
      row('20261002', '000000000007210', 'DR', 'JomPAY Bill Payment', 'U MOBILE SDN BHD 30515721824 DA203JNP22610021822Y'),
      row('20261002', '000000000070000', 'DR', 'Fund Trf fr CA to CA-Internet(B)', 'THE CONTS SDN. BHD. I-2608-063 2990-Draft-2609-030'),
      row('20261012', '000000000832300', 'DR', 'Fund Trf from CA to SA via Internet (B)', 'CHOW WAI MAN TNB DEPOSIT n PRINT 2990-HPV-2610-013'),
    ].join('\n');
    const monthEnd = [HEAD,
      row('20261002', '000000000007210', 'DR', 'JomPAY Bill Payment at DIO', '30515721824 DA203JNP22610021822Y U MOBILE SDN BHD CIBJOM29092026039886'),
      row('20261002', '000000000070000', 'DR', 'Fund Trf fr CA to CA-Internet(B)', 'I-2608-063 2990-Draft-2609-030 THE CONTS SDN. BHD.'),
      row('20261012', '000000000832300', 'DR', 'Fund Trf from CA to SA via Intern', 'TNB DEPOSIT n PRINT 2990-HPV-2610-013 CHOW WAI MAN'),
      row('20261027', '000000000007210', 'DR', 'JomPAY Bill Payment at DIO', '30515721824 DASMRCEV22610271127Y U MOBILE SDN BHD CIBJOM16102026050909'),
    ].join('\n');
    expect((await post(app, '/bank/statements', { accountCode: ACCOUNT, fileName: 'Transaction_Statement_20261001_20261026.csv', content: anyDay })).status).toBe(200);
    const second = await post(app, '/bank/statements', { accountCode: ACCOUNT, fileName: 'acs_23600602788_31102026.csv', content: monthEnd });
    expect(second.status, await second.clone().text()).toBe(200);
    const up = await second.json() as any;
    expect(up.alreadyRecorded).toBe(3);
    expect(linesOf(sb, up.statementId).map((l) => [l.booked_on, l.amount_sen, l.kind, l.state])).toEqual([
      ['2026-10-02', -7210, 'DUPLICATE', 'IGNORED'], ['2026-10-02', -70000, 'DUPLICATE', 'IGNORED'],
      ['2026-10-12', -832300, 'DUPLICATE', 'IGNORED'], ['2026-10-27', -7210, 'OTHER', 'OPEN'],
    ]);
  });
});
