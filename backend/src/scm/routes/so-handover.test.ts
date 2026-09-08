import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { HANDOVER_BATCH_MAX, parseHandoverBody } from './so-handover';

/* The apply endpoint rewrites who owns an order — and SO visibility keys off
   that column, so a bad payload does not just write junk, it makes orders
   disappear from the list of whoever should see them. This pins the guard; the
   per-order "still theirs?" re-check lives in the handler around it. */

const ok = (body: Record<string, unknown>) => {
  const r = parseHandoverBody(body);
  if (!r.ok) throw new Error(`expected ok, got ${r.payload.error}`);
  return r.req;
};
const err = (body: Record<string, unknown>) => {
  const r = parseHandoverBody(body);
  if (r.ok) throw new Error('expected a rejection');
  return r.payload.error;
};

const base = { fromStaffId: 'staff-a', toStaffId: 'staff-b', docNos: ['HC-SO-1'] };

describe('parseHandoverBody — the two people', () => {
  it('accepts a from/to pair and trims both', () => {
    const req = ok({ ...base, fromStaffId: ' staff-a ', toStaffId: 'staff-b ' });
    expect(req.fromStaffId).toBe('staff-a');
    expect(req.toStaffId).toBe('staff-b');
  });

  it('rejects a missing or blank side', () => {
    expect(err({ ...base, fromStaffId: '' })).toBe('missing_staff');
    expect(err({ ...base, toStaffId: '   ' })).toBe('missing_staff');
    expect(err({ ...base, toStaffId: undefined })).toBe('missing_staff');
    expect(err({ ...base, fromStaffId: 42 })).toBe('missing_staff');
  });

  it('rejects a handover to the same person — a no-op that still writes audit rows', () => {
    expect(err({ ...base, toStaffId: 'staff-a' })).toBe('same_staff');
  });
});

describe('parseHandoverBody — the orders', () => {
  it('dedupes the doc list', () => {
    expect(ok({ ...base, docNos: ['HC-SO-1', 'HC-SO-1', ' HC-SO-2 '] }).docNos)
      .toEqual(['HC-SO-1', 'HC-SO-2']);
  });

  it('rejects an empty list rather than moving an unbounded set', () => {
    expect(err({ ...base, docNos: [] })).toBe('no_orders');
    expect(err({ ...base, docNos: ['', '  '] })).toBe('no_orders');
    expect(err({ ...base, docNos: undefined })).toBe('no_orders');
    expect(err({ ...base, docNos: 'HC-SO-1' })).toBe('no_orders');
  });

  it('caps the batch — the UI loops, the worker does not', () => {
    const many = Array.from({ length: HANDOVER_BATCH_MAX + 1 }, (_, i) => `HC-SO-${i}`);
    expect(err({ ...base, docNos: many })).toBe('too_many_orders');
    expect(ok({ ...base, docNos: many.slice(0, HANDOVER_BATCH_MAX) }).docNos)
      .toHaveLength(HANDOVER_BATCH_MAX);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
   THE THIRD DOOR ONTO A MIGRATED SALES ORDER.

   `migratedSoReadonly()` is mounted on `/mfg-sales-orders/*` and
   `/so-amendments/*` (scm/index.ts) and resolves the document number out of the
   PATH. `POST /so-handover/apply` carries a LIST of document numbers in the
   BODY, so a third mount of that factory would find no doc number, answer "not
   migrated", and wave every write through — a guard that is worse than none.
   The decision therefore has to be asked per order inside the handler.

   These read the source for the reason keyWithoutIdentityGuards.test.mjs gives:
   the property is not "the rule is right" (migrated-so-lock.test.ts owns that),
   it is "the rule is APPLIED AT THIS CALL SITE". PROVED RED on the tree before
   fix/sync-human-edit-guard, where this route wrote salesperson_id and agent on
   a migrated order while the lock was on. Re-anchor if the code moves; do not
   delete.
   ──────────────────────────────────────────────────────────────────────────── */
describe('POST /apply respects the migrated-SO lock', () => {
  const src = readFileSync(new URL('./so-handover.ts', import.meta.url), 'utf8');

  it('asks the same decision function the guard and the SO detail screen use', () => {
    expect(src).toContain("import { migratedSoReadonlyState } from '../lib/migrated-so-readonly';");
    expect(src).toContain('await migratedSoReadonlyState(c, before.linked_ac_docno != null)');
  });

  it('reads linked_ac_docno, or it could not answer', () => {
    expect(src).toMatch(/select\('doc_no, salesperson_id, agent, status, linked_ac_docno'\)/);
  });

  it('the refusal REACHES the operator instead of being a silent skip', () => {
    const i = src.indexOf('const lock = await migratedSoReadonlyState');
    expect(i, 'the lock check moved — re-anchor this test, do not delete it').toBeGreaterThan(-1);
    const block = src.slice(i, i + 400);
    expect(block).toContain('skipped.push({ docNo, reason: lock.reason');
  });

  it('refuses BEFORE the update, not after it', () => {
    const lockAt = src.indexOf('const lock = await migratedSoReadonlyState');
    const updateAt = src.indexOf("sb.from('mfg_sales_orders').update(updates)");
    expect(lockAt).toBeGreaterThan(-1);
    expect(updateAt).toBeGreaterThan(-1);
    expect(lockAt).toBeLessThan(updateAt);
  });
});
