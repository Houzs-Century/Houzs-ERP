// Voucher numbering config (GL redesign item 8a). Pinned:
//   • letters: 1-3 upper letters, money accounts of THIS company only, one
//     letter one account (a shared letter = a shared series — refused with
//     the letter named, in-save and against the stored set);
//   • digits: 3-5 only, upserted per company;
//   • GET answers every ACTIVE money account with its letter or null;
//   • the doc-no minters take the width without renumbering anything.

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { numberingGet, numberingPut } from '../src/scm/routes/accounting-numbering';
import { nextMonthlyDocNo } from '../src/scm/lib/doc-no';

const CO = 2;

const MONEY: Row[] = [
  { company_id: CO, account_code: '310-0010', account_name: 'MAYBANK', acc_money: true, is_active: true },
  { company_id: CO, account_code: '310-0020', account_name: 'ALLIANCE', acc_money: true, is_active: true },
  { company_id: CO, account_code: '320-0000', account_name: 'CASH IN HAND', acc_money: true, is_active: true },
  { company_id: CO, account_code: '900-A001', account_name: 'ADVERT', acc_money: false, is_active: true },
];

function harness(tables: Record<string, Row[]> = {}, perms: readonly string[] = ['scm.payment_voucher.post']) {
  const sb = fakeSb(
    { accounts: MONEY.map((r) => ({ ...r })), acc_bank_letters: [], acc_numbering: [], ...tables },
    {},
    [{ table: 'acc_bank_letters', column: 'letter', name: 'acc_bank_letters_company_id_letter_key' }],
  );
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('houzsUser' as never, { name: 'T', permissions_set: perms } as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    await next();
  });
  app.get('/accounting/numbering', numberingGet as never);
  app.put('/accounting/numbering', numberingPut as never);
  return { app, sb };
}

const put = (app: Hono, body: Record<string, unknown>) =>
  app.request('/accounting/numbering', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('the numbering config', () => {
  test('GET lists active money accounts with letter-or-null and the default width', async () => {
    const { app } = harness({ acc_bank_letters: [{ company_id: CO, account_code: '310-0010', letter: 'M' }] });
    const res = await app.request('/accounting/numbering');
    expect(res.status).toBe(200);
    const b = await res.json() as { digits: number; accounts: Array<{ accountCode: string; letter: string | null; fixedCash?: boolean }> };
    expect(b.digits).toBe(3);
    /* The drawer (roles.CASH, default 320-0000) reports its FIXED C — the
       card renders it read-only instead of inviting a letter. */
    expect(b.accounts.map((a) => [a.accountCode, a.letter])).toEqual([
      ['310-0010', 'M'], ['310-0020', null], ['320-0000', 'C'],
    ]);
    expect(b.accounts.find((a) => a.accountCode === '320-0000')?.fixedCash).toBe(true);
  });

  test('letters save upper-cased; a non-money account and a bad shape are refused by name', async () => {
    const { app, sb } = harness();
    expect((await put(app, { letters: [{ accountCode: '310-0010', letter: 'm' }] })).status).toBe(200);
    expect(sb.tables.acc_bank_letters[0]).toMatchObject({ account_code: '310-0010', letter: 'M' });

    const bad = await put(app, { letters: [{ accountCode: '900-A001', letter: 'A' }] });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { message: string }).message).toContain('900-A001');

    expect((await put(app, { letters: [{ accountCode: '310-0020', letter: 'A2' }] })).status).toBe(400);
  });

  test('one letter, one account — refused in-save and against the stored set', async () => {
    const { app } = harness({ acc_bank_letters: [{ company_id: CO, account_code: '310-0010', letter: 'M' }] });
    const inSave = await put(app, { letters: [{ accountCode: '310-0020', letter: 'A' }, { accountCode: '310-0010', letter: 'A' }] });
    expect(inSave.status).toBe(400);

    const stored = await put(app, { letters: [{ accountCode: '310-0020', letter: 'M' }] });
    expect(stored.status).toBe(409);
    expect(((await stored.json()) as { message: string }).message).toContain('M');
  });

  test('the cash drawer is C on both papers — no letter to save, no bank may take C', async () => {
    const { app } = harness();
    /* A letter FOR the drawer: refused — its series is fixed, not config. */
    const fixed = await put(app, { letters: [{ accountCode: '320-0000', letter: 'K' }] });
    expect(fixed.status).toBe(400);
    expect(((await fixed.json()) as { error: string }).error).toBe('letter_fixed');
    /* C ON a bank: refused — it would collide with the drawer's series. */
    const clash = await put(app, { letters: [{ accountCode: '310-0020', letter: 'C' }] });
    expect(clash.status).toBe(400);
    expect(((await clash.json()) as { message: string }).message).toContain('CPV');
  });

  test('digits: 3-5 upserts, anything else is a 400', async () => {
    const { app, sb } = harness();
    expect((await put(app, { digits: 4 })).status).toBe(200);
    expect(sb.tables.acc_numbering[0]).toMatchObject({ company_id: CO, doc_digits: 4 });
    expect((await put(app, { digits: 2 })).status).toBe(400);
    expect((await put(app, { digits: 6 })).status).toBe(400);
  });
});

describe('the width reaches the minters without renumbering anything', () => {
  test('nextMonthlyDocNo pads to the asked width and still parses old numbers', () => {
    expect(nextMonthlyDocNo('2990-MPV-2609', [], 4)).toBe('2990-MPV-2609-0001');
    // A 3-digit history keeps counting when the width moves to 4.
    expect(nextMonthlyDocNo('2990-MPV-2609', ['2990-MPV-2609-007'], 4)).toBe('2990-MPV-2609-0008');
    expect(nextMonthlyDocNo('2990-MPV-2609', ['2990-MPV-2609-0008'])).toBe('2990-MPV-2609-009');
  });
});
