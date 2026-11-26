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

    expect(store.rows).toHaveLength(2);
    expect(store.rows.every((r) => r.status === PWP_VOID_STATUS)).toBe(true);
    expect(store.updates.every((u) => u.payload.status === PWP_VOID_STATUS)).toBe(true);
  });

  test('VOID is not one of the redeemable statuses', () => {
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
    expect(plan.blocked?.reason).toContain('PWP-SPENT');
    expect(plan.blocked?.reason).toContain('2990-SO-2607-099');
    expect(plan.blocked?.codes).toEqual(['PWP-SPENT']);

    expect(plan.toVoid).toHaveLength(0);
    expect(plan.toRestore).toHaveLength(0);
    expect(store.updates).toHaveLength(0);
    expect(store.rows[0]!.status).toBe('USED');
  });

  test('a voucher minted AND spent on the SAME order is voided, not blocked', async () => {
    const { sb, store } = fakeSb([
      { code: 'PWP-SELF', status: 'USED', source_doc_no: DOC, redeemed_doc_no: DOC },
    ]);
    const plan = await planSoCancelVouchers(sb, DOC);

    expect(plan.blocked).toBeNull();
    expect(plan.toVoid.map((r) => r.code)).toEqual(['PWP-SELF']);
    expect(plan.toRestore).toHaveLength(0);

    await applySoCancelVouchers(sb, DOC, plan);
    expect(store.rows[0]!.status).toBe(PWP_VOID_STATUS);
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
    const { sb, store } = fakeSb([
      { code: 'PWP-RACE', status: 'AVAILABLE', source_doc_no: DOC, redeemed_doc_no: null },
    ]);
    const plan = await planSoCancelVouchers(sb, DOC);
    store.rows[0]!.status = 'USED';
    store.rows[0]!.redeemed_doc_no = '2990-SO-2607-100';

    await expect(applySoCancelVouchers(sb, DOC, plan)).rejects.toThrow(/settlement incomplete/i);
    expect(store.rows[0]!.status).toBe('USED');
  });
});
