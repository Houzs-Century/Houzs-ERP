import { describe, expect, test } from 'vitest';
import { applyCustomerCreditToSi, creditFromCancelledSo, reverseCancelledSoCredit } from './customer-credits';

type Row = Record<string, unknown>;

type Store = {
  rpcCalls: Array<{ fn: string; params: Row }>;
  rpcResponse: { data: unknown; error: { code?: string; message?: string } | null };
  inserts: Array<{ table: string; payload: Row }>;
  updates: Array<{ table: string; payload: Row }>;
  existingCreditPayments: Row[];
  creditRows: Row[];
  companyId: number | null;
  paidSen: number;
  migrated: boolean;
  migratedReadError: string | null;
};

function fakeSb(store: Store) {
  class Q {
    table: string;
    op: 'select' | 'insert' | 'update' = 'select';
    cols = '';
    filters: Record<string, unknown> = {};
    payload: Row | null = null;
    singleRow = false;
    constructor(table: string) { this.table = table; }
    select(cols?: string) { if (this.op === 'select') this.cols = cols ?? ''; return this; }
    insert(payload: Row) { this.op = 'insert'; this.payload = payload; return this; }
    update(payload: Row) { this.op = 'update'; this.payload = payload; return this; }
    eq(col: string, val: unknown) { this.filters[col] = val; return this; }
    in() { return this; }
    limit() { return this; }
    maybeSingle() { this.singleRow = true; return this; }
    single() { this.singleRow = true; return this; }
    private result(): { data: unknown; error: unknown } {
      if (this.op === 'insert') {
        store.inserts.push({ table: this.table, payload: this.payload ?? {} });
        return { data: this.singleRow ? { id: 'new-id' } : [{ id: 'new-id' }], error: null };
      }
      if (this.op === 'update') {
        store.updates.push({ table: this.table, payload: this.payload ?? {} });
        return { data: [{ id: this.filters.id ?? 'x' }], error: null };
      }
      if (this.table === 'sales_invoice_payments') {
        return { data: store.existingCreditPayments, error: null };
      }
      if (this.table === 'customer_credits') {
        return { data: store.creditRows, error: null };
      }
      if (this.table === 'sales_invoices') {
        if (this.cols.includes('migrated_no_stock')) {
          if (store.migratedReadError) return { data: null, error: { message: store.migratedReadError } };
          const row = { migrated_no_stock: store.migrated };
          return { data: this.singleRow ? row : [row], error: null };
        }
        const row = this.cols.includes('paid_sen')
          ? { paid_sen: store.paidSen }
          : { company_id: store.companyId };
        return { data: this.singleRow ? row : [row], error: null };
      }
      return { data: this.singleRow ? null : [], error: null };
    }
    then<T>(onF: (v: { data: unknown; error: unknown }) => T, onR?: (e: unknown) => T) {
      return Promise.resolve(this.result()).then(onF, onR);
    }
  }
  return {
    from: (table: string) => new Q(table),
    rpc: (fn: string, params: Row) => {
      store.rpcCalls.push({ fn, params });
      return Promise.resolve(store.rpcResponse);
    },
  };
}

function baseStore(over: Partial<Store> = {}): Store {
  return {
    rpcCalls: [],
    rpcResponse: { data: null, error: null },
    inserts: [],
    updates: [],
    existingCreditPayments: [],
    creditRows: [],
    companyId: 1,
    paidSen: 0,
    migrated: false,
    migratedReadError: null,
    ...over,
  };
}

const ARGS = {
  debtorCode: 'CUST-1',
  debtorName: 'Alice',
  siId: 'si-uuid-1',
  siNumber: 'SI-2607-001',
  remainingDueSen: 5000,
  createdBy: 'staff-1',
};

describe('applyCustomerCreditToSi — atomic RPC path', () => {
  test('routes through the single atomic RPC and does NO direct table writes', async () => {
    const store = baseStore({
      rpcResponse: { data: [{ applied_sen: 3000, reason: null }], error: null },
    });
    const res = await applyCustomerCreditToSi(fakeSb(store), ARGS);

    expect(res).toEqual({ applied: 3000 });
    expect(store.rpcCalls).toHaveLength(1);
    expect(store.rpcCalls[0].fn).toBe('apply_customer_credit_to_si');
    expect(store.inserts).toHaveLength(0);
    expect(store.updates).toHaveLength(0);
  });

  test('passes the SI + debtor through to the function params', async () => {
    const store = baseStore({ rpcResponse: { data: [{ applied_sen: 5000, reason: null }], error: null } });
    await applyCustomerCreditToSi(fakeSb(store), ARGS);
    expect(store.rpcCalls[0].params).toMatchObject({
      p_debtor_code: 'CUST-1',
      p_si_id: 'si-uuid-1',
      p_si_number: 'SI-2607-001',
      p_remaining_due_sen: 5000,
      p_created_by: 'staff-1',
    });
  });

  test("the function's idempotent no-op (already_applied) surfaces without any write", async () => {
    const store = baseStore({
      rpcResponse: { data: [{ applied_sen: 0, reason: 'already_applied' }], error: null },
    });
    const res = await applyCustomerCreditToSi(fakeSb(store), ARGS);
    expect(res).toEqual({ applied: 0, reason: 'already_applied' });
    expect(store.inserts).toHaveLength(0);
  });

  test('a LIVE RPC error never degrades to the non-atomic path — nothing is written', async () => {
    const store = baseStore({
      rpcResponse: { data: null, error: { code: '40001', message: 'deadlock detected' } },
    });
    const res = await applyCustomerCreditToSi(fakeSb(store), ARGS);
    expect(res.applied).toBe(0);
    expect(res.reason).toBe('deadlock detected');
    expect(store.inserts).toHaveLength(0);
    expect(store.updates).toHaveLength(0);
  });
});

describe('applyCustomerCreditToSi — legacy fallback (function not yet applied)', () => {
  const MISSING = { code: 'PGRST202', message: 'Could not find the function scm.apply_customer_credit_to_si in the schema cache' };

  test('falls back to the two-write path when the RPC is absent', async () => {
    const store = baseStore({
      rpcResponse: { data: null, error: MISSING },
      creditRows: [{ amount_sen: 8000 }],
    });
    const res = await applyCustomerCreditToSi(fakeSb(store), ARGS);

    expect(res.applied).toBe(5000);
    const tables = store.inserts.map((i) => i.table).sort();
    expect(tables).toEqual(['customer_credits', 'sales_invoice_payments']);
    const ledger = store.inserts.find((i) => i.table === 'customer_credits');
    expect(ledger?.payload).toMatchObject({ amount_sen: -5000, source_type: 'APPLIED_TO_SI' });
  });

  test('fallback still honours the credit-payment idempotency guard', async () => {
    const store = baseStore({
      rpcResponse: { data: null, error: MISSING },
      existingCreditPayments: [{ id: 'pay-1', amount_sen: 5000 }],
      creditRows: [{ amount_sen: 8000 }],
    });
    const res = await applyCustomerCreditToSi(fakeSb(store), ARGS);
    expect(res).toEqual({ applied: 0, reason: 'already_applied' });
    expect(store.inserts).toHaveLength(0);
  });

  test('fallback no-ops when the balance is zero', async () => {
    const store = baseStore({ rpcResponse: { data: null, error: MISSING }, creditRows: [] });
    const res = await applyCustomerCreditToSi(fakeSb(store), ARGS);
    expect(res).toEqual({ applied: 0, reason: 'no_balance' });
    expect(store.inserts).toHaveLength(0);
  });
});

describe('applyCustomerCreditToSi — guards (no DB touched)', () => {
  test('no debtor → no_debtor, no RPC', async () => {
    const store = baseStore();
    const res = await applyCustomerCreditToSi(fakeSb(store), { ...ARGS, debtorCode: '  ' });
    expect(res).toEqual({ applied: 0, reason: 'no_debtor' });
    expect(store.rpcCalls).toHaveLength(0);
  });

  test('nothing due → no_due, no RPC', async () => {
    const store = baseStore();
    const res = await applyCustomerCreditToSi(fakeSb(store), { ...ARGS, remainingDueSen: 0 });
    expect(res).toEqual({ applied: 0, reason: 'no_due' });
    expect(store.rpcCalls).toHaveLength(0);
  });
});

describe('applyCustomerCreditToSi — migrated source (migration 0280)', () => {
  test('migrated SI → applies nothing, and never reaches the write', async () => {
    const store = baseStore({ migrated: true, creditRows: [{ balance_sen: 900000 }] });
    const res = await applyCustomerCreditToSi(fakeSb(store), ARGS);
    expect(res).toEqual({ applied: 0, reason: 'migrated_source' });
    expect(store.rpcCalls).toHaveLength(0);
    expect(store.inserts).toHaveLength(0);
    expect(store.updates).toHaveLength(0);
  });

  test('an ordinary SI is untouched by the guard — it still applies credit', async () => {
    const store = baseStore({
      migrated: false,
      rpcResponse: { data: [{ applied_sen: 5000 }], error: null },
    });
    const res = await applyCustomerCreditToSi(fakeSb(store), ARGS);
    expect(res).toEqual({ applied: 5000 });
    expect(store.rpcCalls).toHaveLength(1);
  });

  test('a failed migrated read REFUSES rather than proceeding blind', async () => {
    const store = baseStore({ migratedReadError: 'connection reset' });
    const res = await applyCustomerCreditToSi(fakeSb(store), ARGS);
    expect(res.applied).toBe(0);
    expect(res.reason).toContain('migrated_check_failed');
    expect(store.rpcCalls).toHaveLength(0);
    expect(store.inserts).toHaveLength(0);
  });
});

import { computePiSettlement, settlePiPaidSen } from './pi-settlement';

describe('computePiSettlement — behaviour with no concurrency is unchanged', () => {
  const oldRule = (paid: number, delta: number) => Math.max(0, paid + delta);

  const cases: Array<{ paid: number; total: number; delta: number }> = [
    { paid: 0,     total: 10_000, delta: 5_000 },
    { paid: 0,     total: 10_000, delta: 10_000 },
    { paid: 5_000, total: 10_000, delta: 5_000 },
    { paid: 5_000, total: 10_000, delta: 2_500 },
    { paid: 9_999, total: 10_000, delta: 1 },
    { paid: 7_000, total: 10_000, delta: -7_000 },
    { paid: 7_000, total: 10_000, delta: -3_000 },
  ];

  for (const { paid, total, delta } of cases) {
    test(`paid ${paid} total ${total} delta ${delta} settles exactly as before`, () => {
      const got = computePiSettlement({ paidSen: paid, totalSen: total, status: 'POSTED', deltaSen: delta });
      expect(got.newPaidSen).toBe(oldRule(paid, delta));
      expect(got.clampedSen).toBe(0);
    });
  }

  test('re-derives status the same way', () => {
    expect(computePiSettlement({ paidSen: 0, totalSen: 10_000, status: 'POSTED', deltaSen: 10_000 }).newStatus).toBe('PAID');
    expect(computePiSettlement({ paidSen: 0, totalSen: 10_000, status: 'POSTED', deltaSen: 4_000 }).newStatus).toBe('PARTIALLY_PAID');
    expect(computePiSettlement({ paidSen: 4_000, totalSen: 10_000, status: 'PARTIALLY_PAID', deltaSen: -4_000 }).newStatus).toBe('POSTED');
  });
});

describe('computePiSettlement — the over-payment the clamp exists to stop', () => {
  test('two vouchers settling the same invoice: the second is refused, not absorbed', () => {
    const TOTAL = 10_000;
    const first = computePiSettlement({ paidSen: 0, totalSen: TOTAL, status: 'POSTED', deltaSen: TOTAL });
    expect(first.appliedSen).toBe(TOTAL);
    expect(first.clampedSen).toBe(0);

    const second = computePiSettlement({ paidSen: first.newPaidSen, totalSen: TOTAL, status: 'POSTED', deltaSen: TOTAL });
    expect(second.newPaidSen).toBe(TOTAL);
    expect(second.appliedSen).toBe(0);
    expect(second.clampedSen).toBe(TOTAL);
  });

  test('a partial over-allocation applies what fits and reports the rest', () => {
    const got = computePiSettlement({ paidSen: 8_000, totalSen: 10_000, status: 'POSTED', deltaSen: 5_000 });
    expect(got.newPaidSen).toBe(10_000);
    expect(got.appliedSen).toBe(2_000);
    expect(got.clampedSen).toBe(3_000);
    expect(got.newStatus).toBe('PAID');
  });

  test('applied + clamped always equals what was asked for', () => {
    for (const delta of [1, 500, 10_000, 25_000]) {
      const got = computePiSettlement({ paidSen: 3_000, totalSen: 10_000, status: 'POSTED', deltaSen: delta });
      expect(got.appliedSen + got.clampedSen).toBe(delta);
    }
  });
});

describe('computePiSettlement — reversals are never clamped upward', () => {
  test('a cancel floors at zero, and says how much the floor absorbed', () => {
    const got = computePiSettlement({ paidSen: 1_000, totalSen: 10_000, status: 'PARTIALLY_PAID', deltaSen: -5_000 });
    expect(got.newPaidSen).toBe(0);
    expect(got.newStatus).toBe('POSTED');
    expect(got.appliedSen).toBe(-1_000);
    expect(got.clampedSen).toBe(-4_000);
  });

  test('an ALREADY over-paid invoice can still unwind completely', () => {
    const got = computePiSettlement({ paidSen: 20_000, totalSen: 10_000, status: 'PAID', deltaSen: -20_000 });
    expect(got.newPaidSen).toBe(0);
    expect(got.appliedSen).toBe(-20_000);
    expect(got.clampedSen).toBe(0);
  });

  test('a positive settle never drags an already over-paid invoice DOWN to total', () => {
    const got = computePiSettlement({ paidSen: 20_000, totalSen: 10_000, status: 'PAID', deltaSen: 500 });
    expect(got.newPaidSen).toBe(20_000);
    expect(got.appliedSen).toBe(0);
    expect(got.clampedSen).toBe(500);
  });
});

describe('computePiSettlement — a DRAFT or CANCELLED invoice is not a live liability', () => {
  for (const status of ['DRAFT', 'CANCELLED', 'draft', 'cancelled']) {
    test(`${status} is skipped`, () => {
      const got = computePiSettlement({ paidSen: 0, totalSen: 10_000, status, deltaSen: 5_000 });
      expect(got.skipped).toBe(true);
      expect(got.appliedSen).toBe(0);
      expect(got.newPaidSen).toBe(0);
    });
  }
});

function fakePiSb(opts: {
  rpc: { data: unknown; error: { code?: string; message?: string } | null };
  row?: { paid_sen: number; total_sen: number; status: string } | null;
  updateRows?: unknown[];
  updateError?: { message: string } | null;
}) {
  const calls = {
    rpc: [] as Array<{ fn: string; params: Record<string, unknown> }>,
    updates: [] as Record<string, unknown>[],
  };
  const row = opts.row === undefined ? { paid_sen: 0, total_sen: 10_000, status: 'POSTED' } : opts.row;
  class Q {
    op: 'select' | 'update' = 'select';
    payload: Record<string, unknown> | null = null;
    select() { return this; }
    update(p: Record<string, unknown>) { this.op = 'update'; this.payload = p; return this; }
    eq() { return this; }
    maybeSingle() { return this; }
    then(resolve: (v: { data: unknown; error: unknown }) => unknown) {
      if (this.op === 'update') {
        calls.updates.push(this.payload as Record<string, unknown>);
        return Promise.resolve(resolve({
          data: opts.updateError ? null : (opts.updateRows ?? [{ id: 'pi-1' }]),
          error: opts.updateError ?? null,
        }));
      }
      return Promise.resolve(resolve({ data: row, error: null }));
    }
  }
  return {
    calls,
    sb: {
      rpc: (fn: string, params: Record<string, unknown>) => {
        calls.rpc.push({ fn, params });
        return Promise.resolve(opts.rpc);
      },
      from: () => new Q(),
    },
  };
}

describe('settlePiPaidSen — routes through the atomic function, falls back only when it is absent', () => {
  test('primary path calls the RPC and does no table write of its own', async () => {
    const f = fakePiSb({ rpc: { data: [{ applied_sen: 2_000, new_paid_sen: 10_000, new_status: 'PAID', reason: null }], error: null } });
    const res = await settlePiPaidSen(f.sb, 'pi-1', 5_000);
    expect(f.calls.rpc).toEqual([{ fn: 'settle_pi_paid_sen', params: { p_pi_id: 'pi-1', p_delta: 5_000 } }]);
    expect(f.calls.updates).toHaveLength(0);
    expect(res.ok).toBe(true);
    expect(res.appliedSen).toBe(2_000);
    expect(res.clampedSen).toBe(3_000);
  });

  test('an ABSENT function falls back to the legacy path and still clamps', async () => {
    const f = fakePiSb({
      rpc: { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } },
      row: { paid_sen: 8_000, total_sen: 10_000, status: 'POSTED' },
    });
    const res = await settlePiPaidSen(f.sb, 'pi-1', 5_000);
    expect(res.ok).toBe(true);
    expect(res.legacy).toBe(true);
    expect(res.appliedSen).toBe(2_000);
    expect(res.clampedSen).toBe(3_000);
    expect(f.calls.updates[0]).toMatchObject({ paid_sen: 10_000, status: 'PAID' });
  });

  test('a LIVE rpc error never degrades to the non-atomic path', async () => {
    const f = fakePiSb({ rpc: { data: null, error: { code: '23514', message: 'check constraint violated' } } });
    const res = await settlePiPaidSen(f.sb, 'pi-1', 5_000);
    expect(res.ok).toBe(false);
    expect(res.appliedSen).toBe(0);
    expect(f.calls.updates).toHaveLength(0);
  });

  test('a zero delta settles nothing and never reaches the database', async () => {
    const f = fakePiSb({ rpc: { data: null, error: null } });
    const res = await settlePiPaidSen(f.sb, 'pi-1', 0);
    expect(res.appliedSen).toBe(0);
    expect(f.calls.rpc).toHaveLength(0);
  });

  test('a failed legacy update reports applied 0, so no settlement is recorded', async () => {
    const f = fakePiSb({
      rpc: { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } },
      row: { paid_sen: 0, total_sen: 10_000, status: 'POSTED' },
      updateError: { message: 'connection reset' },
    });
    const res = await settlePiPaidSen(f.sb, 'pi-1', 5_000);
    expect(res.ok).toBe(false);
    expect(res.appliedSen).toBe(0);
  });
});

type SoCreditStore = {
  creditRows: Array<{ amount_sen: number; company_id?: number | null }>;
  payRows: Array<{ amount_sen: number; company_id?: number | null }>;
  inserts: Array<{ table: string; payload: Record<string, unknown> }>;
};

function fakeSoSb(store: SoCreditStore) {
  class Q {
    table: string;
    op: 'select' | 'insert' = 'select';
    singleRow = false;
    payload: Record<string, unknown> | null = null;
    constructor(table: string) { this.table = table; }
    select() { return this; }
    insert(p: Record<string, unknown>) { this.op = 'insert'; this.payload = p; return this; }
    eq() { return this; }
    in() { return this; }
    limit() { return this; }
    maybeSingle() { this.singleRow = true; return this; }
    single() { this.singleRow = true; return this; }
    private result(): { data: unknown; error: unknown } {
      if (this.op === 'insert') {
        store.inserts.push({ table: this.table, payload: this.payload ?? {} });
        return { data: { id: 'new-id' }, error: null };
      }
      if (this.table === 'customer_credits') return { data: store.creditRows, error: null };
      if (this.table === 'mfg_sales_order_payments') return { data: store.payRows, error: null };
      return { data: this.singleRow ? null : [], error: null };
    }
    then<T>(onF: (v: { data: unknown; error: unknown }) => T) {
      return Promise.resolve(this.result()).then(onF);
    }
  }
  return { from: (table: string) => new Q(table) };
}

const SO_ARGS = { docNo: 'HC-SO-013276', debtorCode: 'CUST-1', debtorName: 'Alice', createdBy: 'staff-1' };

describe('creditFromCancelledSo — nets the cancel refund against any reopen contra', () => {
  test('first cancel with a deposit writes one SO_CANCEL_REFUND for the paid total', async () => {
    const store: SoCreditStore = { creditRows: [], payRows: [{ amount_sen: 200_000, company_id: 1 }], inserts: [] };
    const res = await creditFromCancelledSo(fakeSoSb(store), SO_ARGS);
    expect(res).toEqual({ credited: 200_000 });
    const led = store.inserts.find((i) => i.table === 'customer_credits');
    expect(led?.payload).toMatchObject({ amount_sen: 200_000, source_type: 'SO_CANCEL_REFUND', source_doc_no: 'HC-SO-013276' });
  });

  test('a standing credit is never doubled — a second cancel no-ops', async () => {
    const store: SoCreditStore = { creditRows: [{ amount_sen: 200_000 }], payRows: [{ amount_sen: 200_000, company_id: 1 }], inserts: [] };
    const res = await creditFromCancelledSo(fakeSoSb(store), SO_ARGS);
    expect(res).toEqual({ credited: 0, reason: 'already_credited' });
    expect(store.inserts).toHaveLength(0);
  });

  test('after a reopen reversed the credit (net 0), a fresh cancel credits again', async () => {
    const store: SoCreditStore = {
      creditRows: [{ amount_sen: 200_000 }, { amount_sen: -200_000 }],
      payRows: [{ amount_sen: 200_000, company_id: 1 }],
      inserts: [],
    };
    const res = await creditFromCancelledSo(fakeSoSb(store), SO_ARGS);
    expect(res).toEqual({ credited: 200_000 });
  });
});

describe('reverseCancelledSoCredit — claws the deposit refund back on reopen', () => {
  test('a standing cancel refund is reversed with a negative SO_REOPEN_CONTRA', async () => {
    const store: SoCreditStore = { creditRows: [{ amount_sen: 200_000, company_id: 1 }], payRows: [], inserts: [] };
    const res = await reverseCancelledSoCredit(fakeSoSb(store), SO_ARGS);
    expect(res).toEqual({ reversed: 200_000 });
    const led = store.inserts.find((i) => i.table === 'customer_credits');
    expect(led?.payload).toMatchObject({ amount_sen: -200_000, source_type: 'SO_REOPEN_CONTRA', source_doc_no: 'HC-SO-013276' });
  });

  test('the common migrated case — no credit ever written — is a clean no-op', async () => {
    const store: SoCreditStore = { creditRows: [], payRows: [], inserts: [] };
    const res = await reverseCancelledSoCredit(fakeSoSb(store), SO_ARGS);
    expect(res).toEqual({ reversed: 0, reason: 'nothing_to_reverse' });
    expect(store.inserts).toHaveLength(0);
  });

  test('an already-reversed credit (net 0) is not reversed twice', async () => {
    const store: SoCreditStore = {
      creditRows: [{ amount_sen: 200_000 }, { amount_sen: -200_000 }],
      payRows: [],
      inserts: [],
    };
    const res = await reverseCancelledSoCredit(fakeSoSb(store), SO_ARGS);
    expect(res).toEqual({ reversed: 0, reason: 'nothing_to_reverse' });
    expect(store.inserts).toHaveLength(0);
  });

  test('no debtor → no_debtor, nothing read or written', async () => {
    const store: SoCreditStore = { creditRows: [{ amount_sen: 200_000 }], payRows: [], inserts: [] };
    const res = await reverseCancelledSoCredit(fakeSoSb(store), { ...SO_ARGS, debtorCode: '  ' });
    expect(res).toEqual({ reversed: 0, reason: 'no_debtor' });
    expect(store.inserts).toHaveLength(0);
  });
});
