import { describe, expect, it } from 'vitest';
import {
  applyEventBooks,
  booksLinesFor,
  PV_CHECKED_SOURCE,
  readCheckedVoucherLegs,
  withCheckedVouchers,
  type BooksLeg,
} from './event-books';

/* The event row takes Finance's figure once a voucher is CHECKED (owner
 * 2026-10-19: 「改成 pv checked」), not only once it is approved and posts. A
 * checked voucher has no GL leg yet, so its tagged lines are read as legs; a
 * reject drops them (the typed figure returns), an approval posts the GL leg
 * and drops them here — never counted twice. AP invoices still count at Post. */

const leg = (over: Partial<BooksLeg> = {}): BooksLeg => ({
  leg_id: 'pvl-1', account_code: '900-R032', debit_sen: 800000, credit_sen: 0, notes: null,
  je_no: 'PV-2610-004', entry_date: '2026-10-19', source_type: PV_CHECKED_SOURCE, source_doc_no: 'PV-2610-004',
  posted: true, reversed: false, reversed_by_je: null,
  account_name: 'RENTAL - EXHIBITION', account_type: 'EXPENSE', pms_row: 'rental', ...over,
});

describe('readCheckedVoucherLegs — vouchers checked, not yet approved', () => {
  it('asks for the event\'s checked-not-approved voucher lines in its company', async () => {
    const calls: Array<{ sql: string; binds: unknown[] }> = [];
    const db = {
      prepare: (sql: string) => ({ bind: (...binds: unknown[]) => { calls.push({ sql, binds }); return { all: async () => ({ results: [leg()] }) }; } }),
    } as unknown as D1Database;
    expect(await readCheckedVoucherLegs(db, 7, 1)).toEqual({ ok: true, legs: [leg()] });
    const { sql, binds } = calls[0]!;
    expect(binds).toEqual([7, 1]);
    expect(sql).toContain("pv.status = 'DRAFT' AND pv.checked_at IS NOT NULL AND pv.approved_at IS NULL");
    expect(sql).toMatch(/WHERE l\.project_id = \? AND l\.company_id = \?/);
  });

  it('a failed read is reported, not guessed', async () => {
    const broken = { prepare: () => { throw new Error('down'); } } as unknown as D1Database;
    expect(await readCheckedVoucherLegs(broken, 7, 1)).toEqual({ ok: false, reason: 'down' });
  });
});

describe('a checked voucher on the event page', () => {
  it('fills its row like a posted one, and says it is only checked', () => {
    const [line] = booksLinesFor(7, [leg()]);
    expect(line).toMatchObject({ category: 'rental', amount: 8000, source: 'books', doc_no: 'PV-2610-004 (checked)' });
  });

  it('replaces the typed rental, as the posted books do', () => {
    const typed = [{ id: 1, project_id: 7, kind: 'cost', category: 'rental', amount: 9500 }];
    const { lines, books } = applyEventBooks(7, typed, withCheckedVouchers({ ok: true, legs: [] }, { ok: true, legs: [leg()] }), ['rental']);
    expect(books.replaced).toEqual(typed);
    expect(lines.map((l) => [l.category, l.amount])).toEqual([['rental', 8000]]);
  });
});

describe('withCheckedVouchers — one read of the books', () => {
  const posted = leg({ leg_id: 'gl-1', source_type: 'PV', je_no: 'JE-2610-001', source_doc_no: 'PV-2610-001' });
  it('the posted legs and the checked lines together', () => {
    expect(withCheckedVouchers({ ok: true, legs: [posted] }, { ok: true, legs: [leg()] })).toEqual({ ok: true, legs: [posted, leg()] });
  });
  it('either read failing is a failed read', () => {
    expect(withCheckedVouchers({ ok: false, reason: 'gl down' }, { ok: true, legs: [leg()] })).toEqual({ ok: false, reason: 'gl down' });
    expect(withCheckedVouchers({ ok: true, legs: [posted] }, { ok: false, reason: 'pv down' })).toEqual({ ok: false, reason: 'pv down' });
  });
});
