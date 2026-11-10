/* The voucher a bank line names is its match (owner 2026-11-10, 2990's Hong Leong
   October: 「银行单上写着 PV 号码的，直接配那张 PV，不管差几天」 — 可以).
   Five payments printed their voucher's number, four the formal one and one the
   Draft number they went out under, 12 to 24 days after the voucher: past the
   week an equal amount is offered in, so each sat under "No entry found" with
   its voucher under "Not on the bank yet". Pinned at the routes:
     • an upload matches a line to the voucher its words name, whatever the days,
       reason "amount+document" — a Draft number read through the audit trail to
       the number the voucher took at Checked;
     • a line naming a voucher of another amount, or none, stays for a person;
     • an entry another line already holds is never taken;
     • "Match the obvious ones now" (POST /bank/statements/:id/auto-match) does
       the same for a statement uploaded before the voucher posted;
     • a voucher posting after its payment is on the bank finds its line itself
       (matchBankLinesNamingVoucher, called from the voucher's post).
   The rule itself is pinned in src/acc/bank-match.test.ts. Real handlers, fake
   PostgREST. The prints and the vouchers are the live ones. */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { bankStatementAutoMatch, bankStatementDetail, bankUpload, matchBankLinesNamingVoucher } from '../src/scm/routes/accounting-bank';

const CO = 2;
const GL_PERM = 'scm.payment_voucher.post';
const ACCOUNT = '310-0020';

const ACCOUNT_SETUP: Row = {
  id: 1, company_id: CO, account_code: ACCOUNT, bank_code: 'MBB',
  account_no: '0000564418610346', statement_format: 'CSV', delimiter: '|',
  amount_format: 'integer-sen', credit_indicator: 'CR', is_active: true,
  column_map: {
    date: 'EFFECT DATE', description: 'TRX DESCRIPTION', reference: 'TRX REFERENCE',
    amount: 'AMOUNT', indicator: 'AMOUNT IND',
  },
};
const HEAD = 'BATCH DATE|ACCOUNT NO.|PROD TYPE|EFFECT DATE|EFFECT TIME|BRANCH|TELLER|CODE|SOURCE CODE|AMOUNT|AMOUNT IND|TRX DESCRIPTION|TRX REFERENCE';
const row = (date: string, sen: number, desc: string, ref: string) =>
  `${date}|0000564418610346|CA|${date}|103009|2988|CEB4PHON|7610|003|${String(sen).padStart(15, '0')}|DR|${desc}|${ref}`;

/* The month-end file's payments, as stored. */
const FILE = [
  HEAD,
  row('20261027', 266711, 'Fund Trf fr CA to CA-Internet(B)', '10-0015 0017 0026 2990-HPV-2610-018 HOUZS VENTURE HOLDING'),
  row('20261030', 1802079, 'CIB Instant Transfer at DIO', 'SHOWROOM_DECO 2990-Draft-2610-006 LOO WEN WEI 20261030HLBBMYKL010OCB4'),
  /* RM 1,689.33 paid against a RM 1,698.33 voucher — no number, another amount. */
  row('20261030', 168933, 'Fund Trf fr CA to CA-Internet(B)', 'Payment HOUZS VENTURE HOLDING SDN. BHD.'),
  /* RM 9.00 naming a RM 1,140.06 voucher. */
  row('20261106', 900, 'Fund Trf fr CA to CA-Internet(B)', 'HOUZS VENTURE HOLDING SDN. BHD. Short Transfer 2990-HPV-2611-011'),
].join('\n');

const pvEntry = (jeNo: string, entryDate: string, doc: string, creditSen: number, party: string): Row => ({
  company_id: CO, account_code: ACCOUNT, je_no: jeNo, entry_date: entryDate, source_type: 'PV', source_doc_no: doc,
  debit_sen: 0, credit_sen: creditSen, party_name: party, notes: `Payment voucher ${doc} — ${party}`, reversed: false, reversed_by_je: null,
});
const LEDGER = [
  pvEntry('2990-JE-2610-0362', '2026-10-15', '2990-HPV-2610-018', 266711, 'HOUZS VENTURE HOLDING SDN BHD'),
  pvEntry('2990-JE-2610-0447', '2026-10-06', '2990-HPV-2610-009', 1802079, 'LOO WEN WEI'),
  pvEntry('2990-JE-2610-0445', '2026-10-28', '2990-HPV-2610-033', 169833, 'HOUZS VENTURE HOLDING SDN BHD'),
  pvEntry('2990-JE-2611-0135', '2026-11-02', '2990-HPV-2611-011', 114006, 'GENERALI INSURANCE MALAYSIA BERHAD'),
];
/* The voucher's check, as the audit trail recorded it: Draft → formal. */
const CHECKED: Row = {
  id: 'audit-1', company_id: null, entity_type: 'PAYMENT_VOUCHER', entity_id: 'pv-9', entity_doc_no: '2990-HPV-2610-009', action: 'CHECK',
  field_changes: [{ field: 'checked_by', from: null, to: 'Chew' }, { field: 'pv_number', from: '2990-Draft-2610-006', to: '2990-HPV-2610-009' }],
  created_at: '2026-10-07T03:00:00Z',
};
/* The any-day file before it — the account's statements begin 1 October, so the
   books' entries from then on are the bank's to answer. */
const ANY_DAY: Row = {
  id: 16, company_id: CO, account_code: ACCOUNT, file_name: 'Transaction_Statement_20261001_20261026.csv', file_hash: 'any-day',
  period_from: '2026-10-01', period_to: '2026-10-26', line_count: 0, opening_balance_sen: null, closing_balance_sen: null,
};

function harness(tables: Record<string, Row[]> = {}) {
  const sb = fakeSb(
    {
      accounts: [{ account_code: ACCOUNT, account_name: 'HLB', account_type: 'ASSET', parent_code: null, is_active: true, company_id: CO }],
      acc_account_roles: [], acc_acquirers: [], acc_acquirer_config: [], acc_company_acquirers: [],
      acc_bank_statement_config: [ACCOUNT_SETUP], acc_bank_recognition_rules: [],
      acc_bank_statements: [{ ...ANY_DAY }], acc_bank_statement_lines: [], acc_bank_statement_matches: [],
      acc_bank_month_balances: [], acc_bank_month_locks: [],
      acc_settlement_batches: [], acc_settlement_rows: [], acc_settlement_matches: [], acc_settlement_receipts: [],
      acc_official_receipts: [],
      journal_entries: [], journal_entry_lines: [], v_gl_entries: [], entity_audit_log: [],
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
  app.post('/bank/statements/:id/auto-match', bankStatementAutoMatch as never);
  return { app, sb };
}

const post = (app: Hono, path: string, body: Record<string, unknown> = {}) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const upload = (app: Hono) => post(app, '/bank/statements', { accountCode: ACCOUNT, fileName: 'acs_23600602788_31102026.csv', content: FILE });
const lineOf = (sb: ReturnType<typeof harness>['sb'], amountSen: number) =>
  (sb.tables.acc_bank_statement_lines as Row[]).find((l) => Number(l.amount_sen) === -amountSen)!;

describe('a payment matched to the voucher its line names', () => {
  test('on upload: the formal number and the Draft number, 12 and 24 days on; the rest wait', async () => {
    const { app, sb } = harness({ v_gl_entries: LEDGER.map((e) => ({ ...e })), entity_audit_log: [{ ...CHECKED }] });
    const res = await upload(app);
    expect(res.status).toBe(200);
    const up = await res.json() as any;
    expect(up.autoMatched).toBe(2);
    expect(lineOf(sb, 266711)).toMatchObject({ state: 'POSTED', posted_je_no: '2990-JE-2610-0362' });
    expect(lineOf(sb, 1802079)).toMatchObject({ state: 'POSTED', posted_je_no: '2990-JE-2610-0447' });
    expect(lineOf(sb, 168933).state).toBe('OPEN');
    expect(lineOf(sb, 900).state).toBe('OPEN');
    expect((sb.tables.acc_bank_statement_matches as Row[]).map((m) => [m.je_no, Number(m.amount_sen), m.match_reason])).toEqual([
      ['2990-JE-2610-0362', -266711, 'amount+document'],
      ['2990-JE-2610-0447', -1802079, 'amount+document'],
    ]);
    /* The statement shows them dealt with, saying how. */
    const detail = await (await app.request(`/bank/statements/${up.statementId}`)).json() as any;
    const shown = detail.lines.find((l: any) => Number(l.amount_sen) === -266711);
    expect(shown.state).toBe('POSTED');
    expect(shown.matches[0].match_reason).toBe('amount+document');
  });

  test('an entry another line already holds is never taken', async () => {
    const held: Row = { id: 900, statement_id: 16, company_id: CO, line_no: 1, booked_on: '2026-10-16', amount_sen: -266711, description: 'Fund Trf', reference: 'earlier', state: 'POSTED', kind: 'OTHER', posted_je_no: '2990-JE-2610-0362' };
    const { app, sb } = harness({
      v_gl_entries: LEDGER.map((e) => ({ ...e })), entity_audit_log: [{ ...CHECKED }],
      acc_bank_statement_lines: [held],
      acc_bank_statement_matches: [{ id: 1, bank_line_id: 900, company_id: CO, je_no: '2990-JE-2610-0362', amount_sen: -266711, match_reason: 'manual' }],
    });
    expect((await upload(app)).status).toBe(200);
    const fresh = (sb.tables.acc_bank_statement_lines as Row[]).find((l) => Number(l.amount_sen) === -266711 && l.id !== 900)!;
    expect(fresh.state).toBe('OPEN');
    expect(lineOf(sb, 1802079).state).toBe('POSTED');
  });

  test('without the audit trail, a Draft number names nothing', async () => {
    const { app, sb } = harness({ v_gl_entries: LEDGER.map((e) => ({ ...e })) });
    expect(((await (await upload(app)).json()) as any).autoMatched).toBe(1);
    expect(lineOf(sb, 1802079).state).toBe('OPEN');
  });

  test('"Match the obvious ones now" does it for a statement uploaded before the vouchers posted', async () => {
    const { app, sb } = harness();
    const up = await (await upload(app)).json() as any;
    expect(up.autoMatched).toBe(0);
    for (const e of LEDGER) sb.tables.v_gl_entries.push({ ...e });
    sb.tables.entity_audit_log.push({ ...CHECKED });
    const res = await post(app, `/bank/statements/${up.statementId}/auto-match`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, matched: 2, jeNos: ['2990-JE-2610-0362', '2990-JE-2610-0447'] });
    expect(await (await post(app, `/bank/statements/${up.statementId}/auto-match`)).json()).toMatchObject({ matched: 0 });
  });
});

describe('a voucher posting after its payment is on the bank', () => {
  test('finds the line that names it — its formal number or the Draft it went out under', async () => {
    const { app, sb } = harness();
    await upload(app);
    /* The vouchers post afterwards: their entries arrive, then each looks for its line. */
    for (const e of LEDGER) sb.tables.v_gl_entries.push({ ...e });
    sb.tables.entity_audit_log.push({ ...CHECKED });
    expect(await matchBankLinesNamingVoucher(sb as never, CO, { pvNumber: '2990-HPV-2610-018', creditAccountCode: ACCOUNT }, 'Chew'))
      .toMatchObject({ matched: 1, jeNos: ['2990-JE-2610-0362'] });
    expect(await matchBankLinesNamingVoucher(sb as never, CO, { pvNumber: '2990-HPV-2610-009', creditAccountCode: ACCOUNT }, 'Chew'))
      .toMatchObject({ matched: 1, jeNos: ['2990-JE-2610-0447'] });
    expect(lineOf(sb, 266711)).toMatchObject({ state: 'POSTED', posted_je_no: '2990-JE-2610-0362' });
    expect(lineOf(sb, 1802079)).toMatchObject({ state: 'POSTED', posted_je_no: '2990-JE-2610-0447' });
    expect((sb.tables.acc_bank_statement_matches as Row[]).every((m) => m.match_reason === 'amount+document')).toBe(true);
  });

  test('a voucher no line names, or one paid from another bank, touches nothing', async () => {
    const { app, sb } = harness();
    await upload(app);
    for (const e of LEDGER) sb.tables.v_gl_entries.push({ ...e });
    expect(await matchBankLinesNamingVoucher(sb as never, CO, { pvNumber: '2990-HPV-2610-033', creditAccountCode: ACCOUNT }, 'Chew')).toMatchObject({ matched: 0 });
    expect(await matchBankLinesNamingVoucher(sb as never, CO, { pvNumber: '2990-HPV-2610-018', creditAccountCode: '310-0030' }, 'Chew')).toMatchObject({ matched: 0 });
    expect(sb.tables.acc_bank_statement_matches).toHaveLength(0);
    expect((sb.tables.acc_bank_statement_lines as Row[]).every((l) => l.state === 'OPEN')).toBe(true);
  });
});
