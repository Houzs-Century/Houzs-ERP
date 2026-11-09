// Bank reconciliation reads past PostgREST's 1,000-row reply (Conts #334).
//
// loadAccountLedger, loadClaimedElsewhere and the month screens read the GL,
// the statement lines and the match rows unpaged. PostgREST hands back at most
// its max-rows and no error, so once a bank account passed 1,000 GL lines the
// rest of its postings read as "not in the books", and a dropped match row
// turned a reconciled line back into an unexplained one.
//
// The fake client is given the same ceiling (maxRows = 1,000) and more rows
// than that; every read must still see all of them.

import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import {
  loadAccountLedger, loadClaimedElsewhere, loadCompanyMatches, loadStatementLines,
} from '../src/acc/bank';

const CO = 1;
const BANK = '310-0020';
const CEILING = 1000;
const N = 1500;

const day = (i: number) => `2026-0${1 + Math.floor(i / 300)}-${String(1 + (i % 28)).padStart(2, '0')}`;

function seeded() {
  const gl: Row[] = [];
  const lines: Row[] = [];
  const matches: Row[] = [];
  for (let i = 0; i < N; i++) {
    const jeNo = `JE-${String(i).padStart(5, '0')}`;
    gl.push({ line_id: i + 1, company_id: CO, account_code: BANK, je_no: jeNo, entry_date: day(i), source_type: 'RCT', source_doc_no: `OR-${i}`, debit_sen: 100, credit_sen: 0, notes: null, party_name: null, reversed: false, reversed_by_je: null });
    lines.push({ id: i + 1, company_id: CO, statement_id: 1 + (i % 2), line_no: i, booked_on: day(i), amount_sen: 100, state: 'POSTED', posted_je_no: null });
    matches.push({ id: i + 1, company_id: CO, bank_line_id: i + 1, je_no: jeNo });
  }
  /* Another company's rows never count. */
  gl.push({ line_id: N + 1, company_id: 2, account_code: BANK, je_no: 'JE-OTHER', entry_date: day(0), debit_sen: 1, credit_sen: 0 });
  matches.push({ id: N + 1, company_id: 2, bank_line_id: 1, je_no: 'JE-OTHER' });
  return fakeSb(
    {
      v_gl_entries: gl,
      acc_bank_statements: [
        { id: 1, company_id: CO, account_code: BANK, period_from: '2026-01-01' },
        { id: 2, company_id: CO, account_code: BANK, period_from: '2026-03-01' },
        { id: 3, company_id: CO, account_code: BANK, period_from: '2026-06-01' },
      ],
      acc_bank_statement_lines: lines,
      acc_bank_statement_matches: matches,
    },
    {}, [], [], CEILING,
  );
}

describe('bank reconciliation reads page past the 1,000-row reply', () => {
  test('the ledger sees every posting on the account', async () => {
    const r = await loadAccountLedger(seeded(), CO, BANK, '2026-12-31');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.movements).toHaveLength(N);
    expect(r.movements.some((m) => m.jeNo === 'JE-OTHER')).toBe(false);
  });

  test('every claim of the other statements counts', async () => {
    const r = await loadClaimedElsewhere(seeded(), CO, BANK, 3);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.claimed.size).toBe(N);
    expect(r.claimed.has('JE-OTHER')).toBe(false);
  });

  test('the month screens read every line and every match of the company', async () => {
    const sb = seeded();
    const lines = await loadStatementLines(sb, CO, [1, 2], 'id, statement_id, line_no, booked_on');
    expect(lines.error).toBeNull();
    expect(lines.data).toHaveLength(N);
    const days = lines.data.map((l) => String(l.booked_on));
    expect(days).toEqual([...days].sort());

    const matches = await loadCompanyMatches(sb, CO, 'id, bank_line_id, je_no');
    expect(matches.error).toBeNull();
    expect(matches.data).toHaveLength(N);
    expect(matches.data.some((m) => m.je_no === 'JE-OTHER')).toBe(false);
  });
});
