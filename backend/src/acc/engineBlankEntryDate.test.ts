import { describe, expect, it } from 'vitest';

import { fakeSb, type Row } from '../scm/lib/fake-postgrest';
import { todayMyt } from '../scm/lib/my-time';
import { postJournal } from './engine';

const CHART: Row[] = [
  { account_code: '905-0000', account_name: 'Rental Expense', account_type: 'EXPENSE', parent_code: null, is_active: true, company_id: 1 },
  { account_code: '310-0010', account_name: 'Bank', account_type: 'ASSET', parent_code: null, is_active: true, company_id: 1 },
];

const world = () => fakeSb({
  accounts: CHART,
  journal_entries: [],
  journal_entry_lines: [],
  acc_account_roles: [],
});

const LINES = [
  { accountCode: '905-0000', debitSen: 100000, creditSen: 0 },
  { accountCode: '310-0010', debitSen: 0, creditSen: 100000 },
];

const base = { companyId: 1, sourceType: 'MANUAL', sourceDocNo: null, narration: 'manual JV', lines: LINES };

describe('postJournal — a blank entry date', () => {
  it('stores today, and numbers from today, instead of "" and NaN', async () => {
    const sb = world();
    const out = await postJournal(sb, { ...base, entryDate: '' });
    expect(out).toMatchObject({ ok: true, status: 'posted' });

    const today = todayMyt();
    const je = sb.tables.journal_entries[0]!;
    expect(je.entry_date).toBe(today);
    expect(je.je_no).toBe(`JE-${today.slice(2, 4)}${today.slice(5, 7)}-0001`);
  });

  it('leaves a real document date exactly as given (§2.5)', async () => {
    const sb = world();
    const out = await postJournal(sb, { ...base, entryDate: '2026-03-09' });
    expect(out).toMatchObject({ ok: true, status: 'posted' });
    const je = sb.tables.journal_entries[0]!;
    expect(je.entry_date).toBe('2026-03-09');
    expect(je.je_no).toBe('JE-2603-0001');
  });
});
