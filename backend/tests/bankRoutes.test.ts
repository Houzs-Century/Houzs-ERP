// The bank reconciliation endpoints, through the same harness shape as
// settlementRoutes.test.ts: a bare Hono app whose middleware injects a fake
// PostgREST client, a company and a set of permissions.
//
// What is pinned here is what a screen and a ledger depend on:
//   • the permission gate answers 403 at THIS end too (前后端各检查一次);
//   • a statement uploaded against the WRONG ACCOUNT is refused — the one
//     mistake in this module that produces a clean-looking wrong answer;
//   • the same file twice is refused, not doubled;
//   • an upload recognises the acquirer credits and leaves the rest alone;
//   • booking a credit goes through LAYER 3's postBatchReceipt, so there is one
//     notion of "the acquirer paid us" and one place that books it;
//   • undo REVERSES rather than deletes, and the money goes back where it was;
//   • one journal entry cannot be reconciled against two bank movements.

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import {
  bankSetup, bankUpload, bankStatements, bankStatementDetail,
  bankLineReceipt, bankLineMatch, bankLineIgnore, bankLineUndo,
} from '../src/scm/routes/accounting-bank';

const CO = 1;
const GL_PERM = 'scm.payment_voucher.post';

const CHART: Row[] = ['320-0000', '330-0000', '930-0000'].map((code) => ({
  account_code: code, account_name: code, account_type: 'ASSET', parent_code: null, is_active: true, company_id: CO,
}));

/* The Maybank current account exactly as it is configured for the real file:
   pipe delimited, integer sen, CR/DR in its own column. */
const MBB_ACCOUNT: Row = {
  id: 1, company_id: CO, account_code: '330-0000', bank_code: 'MBB',
  account_no: '0000564418610346', statement_format: 'CSV', delimiter: '|',
  amount_format: 'integer-sen', credit_indicator: 'CR', is_active: true,
  column_map: {
    date: 'EFFECT DATE', description: 'TRX DESCRIPTION', reference: 'TRX REFERENCE',
    amount: 'AMOUNT', indicator: 'AMOUNT IND',
  },
};

const RULES: Row[] = [
  { id: 1, acquirer_code: 'MBB', pattern: 'CARD SALES', match_field: 'both', trading_date_pattern: 'DATED\\s*(\\d{8})', merchant_pattern: 'M/?N\\s*(\\d+)', sort_order: 10, is_active: true },
  { id: 2, acquirer_code: 'AEON', pattern: 'AEON CREDIT SERVICE', match_field: 'both', trading_date_pattern: null, merchant_pattern: null, sort_order: 30, is_active: true },
];

const HEAD = 'BATCH DATE|ACCOUNT NO.|PROD TYPE|EFFECT DATE|EFFECT TIME|BRANCH|TELLER|CODE|SOURCE CODE|AMOUNT|AMOUNT IND|TRX DESCRIPTION|TRX REFERENCE';
const row = (date: string, sen: string, ind: string, desc: string, ref: string) =>
  `${date}|0000564418610346|CA|${date}|103009|2988|CEB4PHON|7610|003|${sen}|${ind}|${desc}|${ref}`;

/* Two card credits and one customer transfer — the mix every real statement is. */
const STATEMENT = [
  HEAD,
  row('20260803', '000000000728448', 'CR', 'CR/CARD SALES MN 32410011 DATED 31072026', '00113107'),
  row('20260803', '000000000171000', 'CR', 'LAU LEE YEN        *', 'Jaslyn'),
  row('20260809', '000000000087500', 'CR', 'DR/CARD SALES M/N 2259020 DATED 08082026', 'D90200808'),
  row('20260809', '000000000000394', 'DR', 'DR/CARD SALES M/N 2259020 DATED 08082026', 'D90200808'),
  row('20260812', '000000000002500', 'DR', 'SERVICE CHARGE', 'BCHARGE1'),
].join('\n');

/* A reconciled merchant statement owed exactly what the first credit pays. */
const BATCH: Row = {
  id: 1, company_id: CO, acquirer_code: 'MBB', file_name: 'mbb-0731.csv',
  period_from: '2026-07-31', period_to: '2026-07-31',
  net_sen: 728448, stated_net_sen: null, adjustment_sen: 0, status: 'OPEN',
};
const CONFIRMED_ROW: Row = {
  id: 1, batch_id: 1, company_id: CO, acquirer_code: 'MBB', line_no: 1,
  txn_date: '2026-07-31', gross_sen: 740000, fee_sen: 11552, net_sen: 728448,
  bucket: 'MATCHED', confirmed_at: '2026-08-01T00:00:00Z',
};

const ACQ: Row = {
  company_id: CO, code: 'MBB', display_name: 'MBB',
  transit_account_code: '320-0000', fee_account_code: '930-0000', bank_account_code: '330-0000',
  statement_format: 'CSV', has_unique_ref: true, fee_method: 'stated',
  date_tolerance_days: 3, is_active: true, column_map: {},
};

function harness(tables: Record<string, Row[]> = {}, perms: readonly string[] = [GL_PERM]) {
  const sb = fakeSb(
    {
      accounts: CHART, acc_account_roles: [],
      acc_acquirers: [ACQ], acc_acquirer_config: [], acc_company_acquirers: [],
      acc_bank_statement_config: [MBB_ACCOUNT],
      acc_bank_recognition_rules: RULES,
      acc_bank_statements: [], acc_bank_statement_lines: [], acc_bank_statement_matches: [],
      acc_settlement_batches: [], acc_settlement_rows: [], acc_settlement_matches: [], acc_settlement_receipts: [],
      journal_entries: [], journal_entry_lines: [], v_gl_entries: [],
      ...tables,
    },
    {},
    [
      { table: 'acc_bank_statements', column: 'file_hash', name: 'acc_bank_stmt_once' },
      { table: 'acc_bank_statement_matches', column: 'je_no', name: 'acc_bank_je_once' },
    ],
    /* Integer ids, or SETTLEBANK-<batch>-<receipt> keys off a 'row-1' string
       become NaN and the second credit silently collides with the first — the
       bug layer 3 hit on this same rig. */
    ['acc_bank_statements', 'acc_bank_statement_lines', 'acc_bank_statement_matches',
      'acc_settlement_batches', 'acc_settlement_rows', 'acc_settlement_matches', 'acc_settlement_receipts'],
  );
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('houzsUser' as never, { name: 'Tester', permissions_set: perms } as never);
    c.set('allowedCompanyIds' as never, [1, 2] as never);
    await next();
  });
  app.get('/bank/setup', bankSetup as never);
  app.post('/bank/statements', bankUpload as never);
  app.get('/bank/statements', bankStatements as never);
  app.get('/bank/statements/:id', bankStatementDetail as never);
  app.post('/bank/lines/:id/receipt', bankLineReceipt as never);
  app.post('/bank/lines/:id/match', bankLineMatch as never);
  app.post('/bank/lines/:id/ignore', bankLineIgnore as never);
  app.post('/bank/lines/:id/undo', bankLineUndo as never);
  return { app, sb };
}

const post = (app: Hono, path: string, body: Record<string, unknown> = {}) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const upload = (app: Hono, over: Record<string, unknown> = {}) =>
  post(app, '/bank/statements', { accountCode: '330-0000', fileName: 'aug.csv', content: STATEMENT, ...over });

describe('the permission gate answers at this end too', () => {
  test('every endpoint refuses without the GL key', async () => {
    const { app } = harness({}, []);
    for (const [method, path] of [
      ['GET', '/bank/setup'], ['GET', '/bank/statements'], ['GET', '/bank/statements/1'],
      ['POST', '/bank/statements'], ['POST', '/bank/lines/1/receipt'],
      ['POST', '/bank/lines/1/match'], ['POST', '/bank/lines/1/ignore'], ['POST', '/bank/lines/1/undo'],
    ] as const) {
      const res = method === 'GET' ? await app.request(path) : await post(app, path);
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });
});

describe('uploading a statement', () => {
  test('reads it, joins the split payout, and recognises only the card credits', async () => {
    const { app } = harness();
    const res = await upload(app);
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    /* Five lines in, four movements out: the credit and its charge are one. */
    expect(body.lines).toBe(4);
    expect(body.joinedPairs).toBe(1);
    expect(body.periodFrom).toBe('2026-08-03');
    expect(body.periodTo).toBe('2026-08-12');
    /* Nothing is owed yet, so both card credits are payouts with no batch —
       and the customer transfer is not a payout at all. */
    expect(body.kinds.PAYOUT_NO_BATCH).toBe(2);
    expect(body.kinds.OTHER).toBe(2);
  });

  test('claims the reconciled statement that is owed exactly that credit', async () => {
    const { app } = harness({ acc_settlement_batches: [BATCH], acc_settlement_rows: [CONFIRMED_ROW] });
    const body = await (await upload(app)).json() as any;
    expect(body.kinds.PAYOUT).toBe(1);
  });

  /* THE MISTAKE THAT LOOKS CLEAN. Every number computes; the answer is about
     somebody else's money. */
  test('refuses a file that does not mention the account it was uploaded against', async () => {
    const { app } = harness();
    const res = await upload(app, { content: STATEMENT.replace(/0000564418610346/g, '0000999999999999') });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toBe('wrong_account');
    expect(body.message).toMatch(/0000564418610346/);
  });

  test('refuses the same file twice rather than doubling the movements', async () => {
    const { app } = harness();
    expect((await upload(app)).status).toBe(200);
    const again = await upload(app);
    expect(again.status).toBe(409);
    expect((await again.json() as any).error).toBe('already_uploaded');
  });

  test('refuses a file it cannot read, naming the heading it wanted', async () => {
    const { app } = harness();
    /* Carries the right account number, so the account guard passes and it is
       the READER that has to refuse it. */
    const res = await upload(app, {
      content: 'ACCOUNT NO.|0000564418610346\nInvoice No|Customer|Total\nINV-1|Ali|100.00',
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toBe('unreadable_statement');
    expect(body.message).toMatch(/EFFECT DATE/);
  });

  test('names the accounts that ARE configured when the chosen one is not', async () => {
    const { app } = harness();
    const res = await upload(app, { accountCode: '999-0000' });
    expect(res.status).toBe(400);
    expect((await res.json() as any).message).toMatch(/330-0000 \(MBB\)/);
  });
});

describe('booking a credit against the merchant statement it pays', () => {
  const ready = () => harness({ acc_settlement_batches: [BATCH], acc_settlement_rows: [CONFIRMED_ROW] });

  const firstPayout = async (app: Hono, statementId: number) => {
    const detail = await (await app.request(`/bank/statements/${statementId}`)).json() as any;
    return detail.lines.find((l: any) => l.kind === 'PAYOUT');
  };

  test('posts through layer 3, on the BANK date, for the BANK amount', async () => {
    const { app, sb } = ready();
    const up = await (await upload(app)).json() as any;
    const line = await firstPayout(app, up.statementId);
    expect(line).toBeTruthy();

    const res = await post(app, `/bank/lines/${line.id}/receipt`, { batchId: 1 });
    expect(res.status).toBe(200);

    /* One receipt, carrying the date and the reference off the statement —
       nobody retyped either. */
    const receipts = sb.tables.acc_settlement_receipts as Row[];
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.received_on).toBe('2026-08-03');
    expect(receipts[0]!.amount_sen).toBe(728448);
    expect(receipts[0]!.bank_ref).toBe('00113107');
  });

  test('a second attempt on the same movement is refused, not doubled', async () => {
    const { app } = ready();
    const up = await (await upload(app)).json() as any;
    const line = await firstPayout(app, up.statementId);
    expect((await post(app, `/bank/lines/${line.id}/receipt`, { batchId: 1 })).status).toBe(200);
    const again = await post(app, `/bank/lines/${line.id}/receipt`, { batchId: 1 });
    expect(again.status).toBe(409);
    expect((await again.json() as any).error).toBe('not_open');
  });

  test('undo REVERSES the entry and puts the movement back', async () => {
    const { app, sb } = ready();
    const up = await (await upload(app)).json() as any;
    const line = await firstPayout(app, up.statementId);
    await post(app, `/bank/lines/${line.id}/receipt`, { batchId: 1 });

    const res = await post(app, `/bank/lines/${line.id}/undo`);
    expect(res.status).toBe(200);
    /* The receipt is gone and a CONTRA entry exists — the way out of the
       ledger is a journal, never a delete. */
    expect(sb.tables.acc_settlement_receipts).toHaveLength(0);
    const sources = (sb.tables.journal_entries as Row[]).map((j) => j.source_type);
    expect(sources).toContain('SETTLEBANK_REVERSAL');
  });

  test('will not book a movement that takes money OUT', async () => {
    const { app } = ready();
    const up = await (await upload(app)).json() as any;
    const detail = await (await app.request(`/bank/statements/${up.statementId}`)).json() as any;
    /* The standalone SERVICE CHARGE debit — money leaving the account. Nothing
       about it can be a merchant paying us, whatever batch is named. */
    const out = detail.lines.find((l: any) => Number(l.amount_sen) < 0);
    expect(out).toBeTruthy();
    const res = await post(app, `/bank/lines/${out.id}/receipt`, { batchId: 1 });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBe('not_a_receipt');
  });
});

describe('the rest of banking life', () => {
  test('a movement can be matched to a journal entry, but only once', async () => {
    const { app } = harness();
    const up = await (await upload(app)).json() as any;
    const detail = await (await app.request(`/bank/statements/${up.statementId}`)).json() as any;
    const [a, b] = detail.lines;

    expect((await post(app, `/bank/lines/${a.id}/match`, { jeNo: 'JE-2608-0001' })).status).toBe(200);
    const twice = await post(app, `/bank/lines/${b.id}/match`, { jeNo: 'JE-2608-0001' });
    expect(twice.status).toBe(409);
    expect((await twice.json() as any).message).toMatch(/cannot account for two/);
  });

  test('ignoring demands a reason, because it leaves the difference for ever', async () => {
    const { app } = harness();
    const up = await (await upload(app)).json() as any;
    const detail = await (await app.request(`/bank/statements/${up.statementId}`)).json() as any;
    const line = detail.lines[0];

    const bare = await post(app, `/bank/lines/${line.id}/ignore`, {});
    expect(bare.status).toBe(400);
    expect((await bare.json() as any).error).toBe('no_reason');

    const given = await post(app, `/bank/lines/${line.id}/ignore`, { note: 'own transfer, booked from the other side' });
    expect(given.status).toBe(200);
  });
});

describe('the reconciliation the detail returns', () => {
  test('shows the bank ahead of the books by exactly what is unposted', async () => {
    const { app } = harness();
    const up = await (await upload(app)).json() as any;
    const detail = await (await app.request(`/bank/statements/${up.statementId}`)).json() as any;
    const r = detail.reconciliation;

    /* Nothing is posted, so everything on the statement is "bank has, books
       do not" — and the ledger side is empty. */
    expect(r.bankNotInBooks.count).toBe(4);
    expect(r.bankNotInBooks.sen).toBe(728448 + 171000 + 87106 - 2500);
    expect(r.booksNotOnBank.count).toBe(0);
    expect(r.reconciled).toBe(false);
    /* This file prints no balances, so there is no difference to report —
       and a null must not read as a reconciled zero. */
    expect(r.differenceSen).toBeNull();
    expect(r.consistent).toBe(true);
  });

  test('the list says how much of each statement is still undecided', async () => {
    const { app } = harness();
    await upload(app);
    const list = await (await app.request('/bank/statements')).json() as any;
    expect(list.statements).toHaveLength(1);
    expect(list.statements[0].open_count).toBe(4);
    expect(list.statements[0].open_payout_count).toBe(2);
  });
});

describe('the setup the screen reads before an upload', () => {
  test('names the accounts, and which acquirers can be recognised at all', async () => {
    const { app } = harness();
    const body = await (await app.request('/bank/setup')).json() as any;
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0].ready).toBe(true);
    expect(body.recognises).toEqual(['MBB', 'AEON']);
  });

  /* An acquirer with no recognition rule is one whose money reads as
     "not a card payout" for ever — the screen has to be able to say so. */
  test('a config that cannot read anything is not ready', async () => {
    const { app } = harness({
      acc_bank_statement_config: [{ ...MBB_ACCOUNT, column_map: { date: 'EFFECT DATE' } }],
    });
    const body = await (await app.request('/bank/setup')).json() as any;
    expect(body.accounts[0].ready).toBe(false);
  });
});

/* The defect the local rig caught before any screen existed: the matcher works
   out WHICH statement a credit settles, and the route threw that away. The
   screen then had only a candidate list, picked the first of the acquirer, and
   booked the second credit against a statement that was already paid in full —
   confidently, and wrongly. The decision is stored now. */
describe('the matcher decision survives the round trip', () => {
  const TWO_BATCHES = {
    acc_settlement_batches: [
      BATCH,
      { ...BATCH, id: 2, file_name: 'mbb-0808.csv', period_from: '2026-08-08', period_to: '2026-08-08', net_sen: 87106 },
    ],
    acc_settlement_rows: [
      CONFIRMED_ROW,
      { ...CONFIRMED_ROW, id: 2, batch_id: 2, txn_date: '2026-08-08', net_sen: 87106 },
    ],
  };

  test('each credit carries the statement whose day and amount agreed, not the first of the acquirer', async () => {
    const { app } = harness(TWO_BATCHES);
    const up = await (await upload(app)).json() as any;
    const detail = await (await app.request(`/bank/statements/${up.statementId}`)).json() as any;

    const byRef = (ref: string) => detail.lines.find((l: any) => l.reference === ref);
    /* Two candidates for both, and they must NOT get the same answer. */
    expect(byRef('00113107').candidates.length).toBe(2);
    expect(byRef('00113107').matched_batch_id).toBe(1);
    expect(byRef('D90200808').matched_batch_id).toBe(2);
  });

  test('booking each against its own statement pays both off', async () => {
    const { app } = harness(TWO_BATCHES);
    const up = await (await upload(app)).json() as any;
    const detail = await (await app.request(`/bank/statements/${up.statementId}`)).json() as any;

    for (const l of detail.lines.filter((x: any) => x.kind === 'PAYOUT')) {
      const res = await post(app, `/bank/lines/${l.id}/receipt`, { batchId: l.matched_batch_id });
      expect(res.status, `line ${l.line_no}`).toBe(200);
      expect((await res.json() as any).outstandingSen).toBe(0);
    }
  });
});
