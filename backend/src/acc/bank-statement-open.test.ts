import { describe, it, expect, vi } from 'vitest';
import { loadOpenTallies, type OpenTallyRow } from './bank-statement-open';
import { fakeSb, type Row } from '../scm/lib/fake-postgrest';
import { readFailure } from '../scm/lib/read-failure';

/* 1,200 lines of company 1 across three statements, plus company 2's lines that
   must never be counted. Every third line is decided (POSTED / IGNORED), every
   fifth is a card payout. */
function lines(): Row[] {
  const rows: Row[] = [];
  for (let i = 1; i <= 1200; i++) {
    rows.push({
      id: i,
      company_id: 1,
      statement_id: 10 + (i % 3),
      state: i % 3 === 0 ? (i % 2 === 0 ? 'POSTED' : 'IGNORED') : 'OPEN',
      kind: i % 5 === 0 ? 'PAYOUT_CARD' : 'OTHER',
      amount_sen: i * 7 - 3000,
    });
  }
  for (let i = 1; i <= 50; i++) rows.push({ id: 5000 + i, company_id: 2, statement_id: 11, state: 'OPEN', kind: 'OTHER', amount_sen: 999 });
  return rows;
}

/* The answer from a full read, computed straight off the data. */
function expected(rows: Row[]): Map<number, { count: number; sen: number; payouts: number }> {
  const out = new Map<number, { count: number; sen: number; payouts: number }>();
  for (const l of rows) {
    if (l.company_id !== 1 || l.state !== 'OPEN') continue;
    const at = out.get(l.statement_id) ?? { count: 0, sen: 0, payouts: 0 };
    at.count += 1;
    at.sen += l.amount_sen;
    if (String(l.kind).startsWith('PAYOUT')) at.payouts += 1;
    out.set(l.statement_id, at);
  }
  return out;
}

const noSql = () => Promise.resolve(null);
const cappedAt1000 = (rows: Row[], missing: Record<string, string[]> = {}) =>
  fakeSb({ acc_bank_statement_lines: rows }, missing, [], ['acc_bank_statement_lines'], 1000);

describe('loadOpenTallies — the statements list "still to decide" figures', () => {
  it('the old unpaged read really did stop at 1,000 lines on a capped server', async () => {
    const sb = cappedAt1000(lines());
    const { data } = await sb.from('acc_bank_statement_lines').select('statement_id, state, kind, amount_sen').eq('company_id', 1);
    expect((data as Row[]).length).toBe(1000);
  });

  it('without SQL, reads every OPEN line through 1,000-row pages and counts them right', async () => {
    const rows = lines();
    const read = await loadOpenTallies(cappedAt1000(rows), 1, noSql);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.byStatement).toEqual(expected(rows));
    const total = [...read.byStatement.values()].reduce((s, t) => s + t.count, 0);
    expect(total).toBe(800); // 1,200 lines, a third decided
  });

  it('the grouped SQL answer is used as is and agrees with the full read', async () => {
    const rows = lines();
    const grouped: OpenTallyRow[] = [...expected(rows)].map(([id, t]) => ({
      statement_id: String(id), count: t.count, sen: String(t.sen), payouts: t.payouts,
    }));
    const sb = { from: vi.fn() };
    const read = await loadOpenTallies(sb, 1, () => Promise.resolve(grouped));
    expect(sb.from).not.toHaveBeenCalled();
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.byStatement).toEqual(expected(rows));
  });

  it('a failed read is an error, never 0 open', async () => {
    const read = await loadOpenTallies(cappedAt1000(lines(), { acc_bank_statement_lines: ['kind'] }), 1, noSql);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = readFailure('bank_open_lines', read.error, { companyId: 1 });
    errSpy.mockRestore();
    expect(body.error).toBe('load_failed');
    expect(body.stage).toBe('bank_open_lines');
  });
});
