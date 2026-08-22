/* The JE-number prefix must read the companies master, and a failed read must
 * not take the whole request down with it.
 *
 * WHAT HAPPENED. On 2026-08-18, PR #2427 replaced a pure expression
 *
 *     Number(companyId) === 1 ? '' : '2990-'
 *
 * with a database read plus a fail-closed throw. The intent was right — a
 * hardcoded id is wrong across environments. But the read was written as a bare
 * `sb.from('companies')`, and the SCM client is pinned to the `scm` schema
 * (db/supabase.ts:77), so it resolved to `scm.companies`. There is no
 * scm.companies in any migration; the master is `public.companies`.
 *
 * So the read errored, and the throw fired on EVERY call, for every company.
 * It is the only `from('companies')` in the backend — everything else reads the
 * master through raw SQL — so no sibling call existed to disagree with it.
 *
 * MEASURED COST, production 2026-08-23: the newest journal entry in EITHER
 * company was dated 15/08. Five days in which no sales invoice, purchase
 * invoice, payment voucher or reversal wrote one line to the general ledger.
 * Each threw here, uncaught, so the operator saw the generic "Something went
 * wrong" over a document that had already posted.
 *
 * TWO THINGS ARE PINNED, because either alone leaves the failure available:
 *   1. the read names the `public` schema, so it finds the table;
 *   2. postJournal CONTAINS the throw, so a future read failure is a structured
 *      refusal with a reason — not a 500 with no cause and a posted document.
 */
import { describe, expect, it } from 'vitest';

import { fakeSb } from './fake-postgrest';
import { jePrefixForCompany } from './doc-no';
import { postJournal } from '../../acc/engine';

const COMPANIES = [
  { id: 1, code: 'HOUZS', name: 'Houzs Century' },
  { id: 2, code: '2990', name: "2990's Home" },
];

describe('jePrefixForCompany — reads the master where it actually lives', () => {
  it('names the public schema (the SCM client is pinned to scm)', async () => {
    const sb = fakeSb({ companies: COMPANIES });
    await jePrefixForCompany(sb, 1);
    expect(sb.schemaCalls).toContain('public');
  });

  it('HOUZS mints bare, as it always has', async () => {
    const sb = fakeSb({ companies: COMPANIES });
    expect(await jePrefixForCompany(sb, 1)).toBe('');
  });

  it('2990 keeps its own series', async () => {
    const sb = fakeSb({ companies: COMPANIES });
    expect(await jePrefixForCompany(sb, 2)).toBe('2990-');
  });

  it('a null company still short-circuits without a read', async () => {
    const sb = fakeSb({ companies: COMPANIES });
    expect(await jePrefixForCompany(sb, null)).toBe('');
    expect(sb.schemaCalls).toHaveLength(0);
  });
});

describe('postJournal — a prefix failure is a refusal, not a 500', () => {
  /* `missing` makes the fake answer this table with a column error, which is
     what a read against a table PostgREST cannot see looks like to the caller. */
  const brokenCompanies = () => fakeSb({ companies: COMPANIES, journal_entries: [], journal_entry_lines: [], accounts: [] }, { companies: ['code'] });

  const INPUT = {
    companyId: 1,
    entryDate: '2026-08-23',
    sourceType: 'PI' as const,
    sourceDocNo: 'HC-PI-2608-004',
    narration: 'test',
    lines: [
      { accountCode: '310-0000', debitSen: 120000, creditSen: 0 },
      { accountCode: '400-0000', debitSen: 0, creditSen: 120000 },
    ],
  };

  it('returns je_prefix_failed instead of throwing', async () => {
    const res = await postJournal(brokenCompanies(), INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe('je_prefix_failed');
    expect(res.reason).toMatch(/compan/i);
  });

  it('names the company in the reason, so the log says which one', async () => {
    const res = await postJournal(brokenCompanies(), INPUT);
    if (res.ok) throw new Error('expected a refusal');
    expect(res.reason).toContain('1');
  });
});
