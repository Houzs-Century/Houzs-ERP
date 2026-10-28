/* Cancelling a Sales Order must settle the PWP vouchers it touched.
 *
 * pwp_codes has NO foreign key to mfg_sales_orders, so nothing cascades and
 * nothing in the database enforces any of this — these tests ARE the contract.
 * scm rides Supabase Postgres, which the D1 test harness does not rebuild, so
 * they drive a minimal fake PostgREST client (same approach as
 * customer-credits.test.ts) and pin the three rulings:
 *
 *   1. a voucher this SO ISSUED         -> VOID (never deleted)
 *   2. a voucher earned ELSEWHERE, spent here -> back to AVAILABLE, cleared
 *   3. a voucher this SO issued that is already USED on ANOTHER order
 *      -> the cancel is BLOCKED, and nothing is written
 */
import { describe, expect, test } from 'vitest';
import {
  applySoCancelVouchers,
  planSoCancelVouchers,
  soCancelVoucherAuditChanges,
  PWP_VOID_STATUS,
} from './so-cancel-vouchers';

type CodeRow = {
  code: string;
  status: string;
  source_doc_no: string | null;
  redeemed_doc_no: string | null;
  redeemed_item_code?: string | null;
};

type Update = { payload: Record<string, unknown>; codes: string[]; filters: Record<string, unknown> };

/** Chainable PostgREST stand-in over an in-memory pwp_codes table. Updates
 *  mutate the store, so a plan-then-apply run reads its own writes exactly as
 *  it would inside a transaction. */
function fakeSb(rows: CodeRow[]) {
  const store = { rows, updates: [] as Update[] };
  class Q {
    op: 'select' | 'update' = 'select';
    payload: Record<string, unknown> = {};
    filters: Record<string, unknown> = {};
    codes: string[] | null = null;
    select() { return this; }
    update(payload: Record<string, unknown>) { this.op = 'update'; this.payload = payload; return this; }
    eq(col: string, val: unknown) { this.filters[col] = val; return this; }
    in(col: string, vals: string[]) { if (col === 'code') this.codes = vals; return this; }
    private matches(r: CodeRow): boolean {
      if (this.codes && !this.codes.includes(r.code)) return false;
      for (const [col, val] of Object.entries(this.filters)) {
        if ((r as unknown as Record<string, unknown>)[col] !== val) return false;
      }
      return true;
    }
    private run() {
      const hit = store.rows.filter((r) => this.matches(r));
      if (this.op === 'update') {
        store.updates.push({ payload: this.payload, codes: this.codes ?? [], filters: { ...this.filters } });
        for (const r of hit) Object.assign(r, this.payload);
      }
      // A real PostgREST client hands back fresh JSON, never live references —
      // the plan must be a SNAPSHOT, or the status guards would never fire.
      return { data: hit.map((r) => ({ ...r })), error: null };
    }
    then<A>(onfulfilled: (v: { data: unknown; error: unknown }) => A) {
      return Promise.resolve(this.run()).then(onfulfilled);
    }
  }
  return { sb: { from: () => new Q() }, store };
}

const DOC = '2990-SO-2607-025';

describe('cancelling an SO settles the PWP vouchers it touched', () => {
  test('a voucher this SO ISSUED is VOIDED, never deleted', async () => {
    const { sb, store } = fakeSb([
      { code: 'PWP-A', status: 'AVAILABLE', source_doc_no: DOC, redeemed_doc_no: null },
      { code: 'PWP-B', status: 'RESERVED', source_doc_no: DOC, redeemed_doc_no: null },
    ]);
    const plan = await planSoCancelVouchers(sb, DOC);
    expect(plan.blocked).toBeNull();
    expect(plan.toVoid.map((r) => r.code).sort()).toEqual(['PWP-A', 'PWP-B']);

    await applySoCancelVouchers(sb, DOC, plan);

    // Both rows still EXIST (the order is cancelled, not deleted — its history
    // must stay auditable) and neither is redeemable any more.
    expect(store.rows).toHaveLength(2);
    expect(store.rows.every((r) => r.status === PWP_VOID_STATUS)).toBe(true);
    // Nothing was deleted on the cancel path.
    expect(store.updates.every((u) => u.payload.status === PWP_VOID_STATUS)).toBe(true);
  });

  test('VOID is not one of the redeemable statuses', () => {
    // The redemption gates in routes/pwp-codes.ts and lib/pwp-claim-single.ts
    // are allow-lists over exactly these two values.
    expect(['AVAILABLE', 'RESERVED']).not.toContain(PWP_VOID_STATUS);
  });

  test('a voucher earned ELSEWHERE and spent here is handed back as AVAILABLE', async () => {
    const { sb, store } = fakeSb([
      {
        code: 'PWP-EARNED-ELSEWHERE',
        status: 'USED',
        source_doc_no: '2990-SO-2606-001',
        redeemed_doc_no: DOC,
        redeemed_item_code: 'BF-01',
      },
    ]);
    const plan = await planSoCancelVouchers(sb, DOC);
    expect(plan.blocked).toBeNull();
    expect(plan.toVoid).toHaveLength(0);
    expect(plan.toRestore.map((r) => r.code)).toEqual(['PWP-EARNED-ELSEWHERE']);

    await applySoCancelVouchers(sb, DOC, plan);

    const row = store.rows[0]!;
    expect(row.status).toBe('AVAILABLE');
    expect(row.redeemed_doc_no).toBeNull();
    expect(row.redeemed_item_code).toBeNull();
    // The earning order is untouched — the customer keeps what they earned there.
    expect(row.source_doc_no).toBe('2990-SO-2606-001');
  });

  test('a voucher this SO issued that is already USED on ANOTHER order BLOCKS the cancel', async () => {
    const { sb, store } = fakeSb([
      {
        code: 'PWP-SPENT',
        status: 'USED',
        source_doc_no: DOC,
        redeemed_doc_no: '2990-SO-2607-099',
      },
    ]);
    const plan = await planSoCancelVouchers(sb, DOC);

    expect(plan.blocked).not.toBeNull();
    expect(plan.blocked?.error).toBe('pwp_voucher_redeemed_elsewhere');
    // The refusal NAMES the voucher and where it went, so staff can act on it.
    expect(plan.blocked?.reason).toContain('PWP-SPENT');
    expect(plan.blocked?.reason).toContain('2990-SO-2607-099');
    expect(plan.blocked?.codes).toEqual(['PWP-SPENT']);

    // A blocked cancel plans no writes at all.
    expect(plan.toVoid).toHaveLength(0);
    expect(plan.toRestore).toHaveLength(0);
    expect(store.updates).toHaveLength(0);
    expect(store.rows[0]!.status).toBe('USED');
  });

  test('a voucher minted AND spent on the SAME order is voided, not blocked', async () => {
    // Otherwise an ordinary promo order — mint a voucher, redeem it on the same
    // handover — could never be cancelled. Mirrors the TBC swap's rule that only
    // a redemption on a DIFFERENT order is a reward already given out.
    const { sb, store } = fakeSb([
      { code: 'PWP-SELF', status: 'USED', source_doc_no: DOC, redeemed_doc_no: DOC },
    ]);
    const plan = await planSoCancelVouchers(sb, DOC);

    expect(plan.blocked).toBeNull();
    expect(plan.toVoid.map((r) => r.code)).toEqual(['PWP-SELF']);
    // Not double-handled as a restore: it is this order's own voucher.
    expect(plan.toRestore).toHaveLength(0);

    await applySoCancelVouchers(sb, DOC, plan);
    expect(store.rows[0]!.status).toBe(PWP_VOID_STATUS);
    // Provenance kept — the row still records where it was spent.
    expect(store.rows[0]!.redeemed_doc_no).toBe(DOC);
  });

  test('an SO with no vouchers settles to a no-op', async () => {
    const { sb, store } = fakeSb([
      { code: 'PWP-OTHER', status: 'AVAILABLE', source_doc_no: '2990-SO-2606-001', redeemed_doc_no: null },
    ]);
    const plan = await planSoCancelVouchers(sb, DOC);
    await applySoCancelVouchers(sb, DOC, plan);

    expect(store.updates).toHaveLength(0);
    expect(store.rows[0]!.status).toBe('AVAILABLE');
  });

  test('re-running the settlement is idempotent', async () => {
    const { sb, store } = fakeSb([
      { code: 'PWP-A', status: PWP_VOID_STATUS, source_doc_no: DOC, redeemed_doc_no: null },
    ]);
    const plan = await planSoCancelVouchers(sb, DOC);
    expect(plan.toVoid).toHaveLength(0);
    await applySoCancelVouchers(sb, DOC, plan);
    expect(store.updates).toHaveLength(0);
  });

  test('the voiding is described for the SO audit trail', async () => {
    const { sb } = fakeSb([
      { code: 'PWP-A', status: 'AVAILABLE', source_doc_no: DOC, redeemed_doc_no: null },
      { code: 'PWP-E', status: 'USED', source_doc_no: '2990-SO-2606-001', redeemed_doc_no: DOC },
    ]);
    const plan = await planSoCancelVouchers(sb, DOC);
    const changes = soCancelVoucherAuditChanges(plan);

    const voided = changes.find((ch) => ch.field === 'pwpVouchersVoided');
    const returned = changes.find((ch) => ch.field === 'pwpVouchersReturned');
    expect(String(voided?.from)).toContain('PWP-A');
    expect(voided?.to).toBe(PWP_VOID_STATUS);
    expect(String(returned?.from)).toContain('PWP-E');
    expect(returned?.to).toBe('AVAILABLE');
  });

  test('a voucher claimed between the plan and the write rolls the cancel back', async () => {
    // The status-guarded update no-ops, and the verification pass turns that
    // silent miss into a throw — inside runScmPgCommand that is a rollback, so
    // the order stays live rather than committing a half-settled cancel.
    const { sb, store } = fakeSb([
      { code: 'PWP-RACE', status: 'AVAILABLE', source_doc_no: DOC, redeemed_doc_no: null },
    ]);
    const plan = await planSoCancelVouchers(sb, DOC);
    // Someone redeems it on a live order in the gap.
    store.rows[0]!.status = 'USED';
    store.rows[0]!.redeemed_doc_no = '2990-SO-2607-100';

    await expect(applySoCancelVouchers(sb, DOC, plan)).rejects.toThrow(/settlement incomplete/i);
    expect(store.rows[0]!.status).toBe('USED');
  });
});
