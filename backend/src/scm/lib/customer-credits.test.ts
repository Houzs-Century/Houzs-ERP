// Atomicity of "apply customer credit to a Sales Invoice".
//
// The credit payment row on the SI and the negative APPLIED_TO_SI ledger row are
// two writes in different tables that MUST move together — a failure between them
// pays the invoice from a credit that was never debited (the customer keeps the
// balance and can spend it twice). PostgREST cannot span two statements in one
// transaction, so applyCustomerCreditToSi now routes the write through the
// scm.apply_customer_credit_to_si function (one implicit transaction) and only
// falls back to the legacy two-write path when that function is absent.
//
// scm rides Supabase Postgres, which the D1 test harness does not rebuild, so
// these drive a minimal fake PostgREST client and pin the CONTRACT: the primary
// path is a single write unit (the RPC), the fallback is the two-write path, and
// a live RPC error never silently degrades to the non-atomic path.
import { describe, expect, test } from 'vitest';
import { applyCustomerCreditToSi } from './customer-credits';

type Row = Record<string, unknown>;

type Store = {
  rpcCalls: Array<{ fn: string; params: Row }>;
  rpcResponse: { data: unknown; error: { code?: string; message?: string } | null };
  inserts: Array<{ table: string; payload: Row }>;
  updates: Array<{ table: string; payload: Row }>;
  existingCreditPayments: Row[];
  creditRows: Row[]; // customer_credits balance rows for the debtor
  companyId: number | null;
  paidCenti: number;
  /** scm.sales_invoices.migrated_no_stock for the SI under test (migration 0280). */
  migrated: boolean;
  /** when set, the migrated pre-flight read fails with this message */
  migratedReadError: string | null;
};

/** Chainable, awaitable PostgREST stand-in covering the reads/writes the legacy
 *  fallback performs plus the .rpc() the primary path uses. */
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
      // selects
      if (this.table === 'sales_invoice_payments') {
        return { data: store.existingCreditPayments, error: null };
      }
      if (this.table === 'customer_credits') {
        return { data: store.creditRows, error: null };
      }
      if (this.table === 'sales_invoices') {
        /* The migrated pre-flight (migration 0280) reads this column alone. Its
           own error channel is modelled too: the guard must FAIL CLOSED, and a
           test that cannot produce the failure cannot prove that. */
        if (this.cols.includes('migrated_no_stock')) {
          if (store.migratedReadError) return { data: null, error: { message: store.migratedReadError } };
          const row = { migrated_no_stock: store.migrated };
          return { data: this.singleRow ? row : [row], error: null };
        }
        const row = this.cols.includes('paid_centi')
          ? { paid_centi: store.paidCenti }
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
    paidCenti: 0,
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
  remainingDueCenti: 5000,
  createdBy: 'staff-1',
};

describe('applyCustomerCreditToSi — atomic RPC path', () => {
  test('routes through the single atomic RPC and does NO direct table writes', async () => {
    const store = baseStore({
      rpcResponse: { data: [{ applied_centi: 3000, reason: null }], error: null },
    });
    const res = await applyCustomerCreditToSi(fakeSb(store), ARGS);

    expect(res).toEqual({ applied: 3000 });
    // The whole write is ONE unit — the payment row and ledger debit cannot diverge.
    expect(store.rpcCalls).toHaveLength(1);
    expect(store.rpcCalls[0].fn).toBe('apply_customer_credit_to_si');
    expect(store.inserts).toHaveLength(0);
    expect(store.updates).toHaveLength(0);
  });

  test('passes the SI + debtor through to the function params', async () => {
    const store = baseStore({ rpcResponse: { data: [{ applied_centi: 5000, reason: null }], error: null } });
    await applyCustomerCreditToSi(fakeSb(store), ARGS);
    expect(store.rpcCalls[0].params).toMatchObject({
      p_debtor_code: 'CUST-1',
      p_si_id: 'si-uuid-1',
      p_si_number: 'SI-2607-001',
      p_remaining_due_centi: 5000,
      p_created_by: 'staff-1',
    });
  });

  test("the function's idempotent no-op (already_applied) surfaces without any write", async () => {
    const store = baseStore({
      rpcResponse: { data: [{ applied_centi: 0, reason: 'already_applied' }], error: null },
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
    // The function ran and rolled back; we must not re-attempt via the racy path.
    expect(store.inserts).toHaveLength(0);
    expect(store.updates).toHaveLength(0);
  });
});

describe('applyCustomerCreditToSi — legacy fallback (function not yet applied)', () => {
  const MISSING = { code: 'PGRST202', message: 'Could not find the function scm.apply_customer_credit_to_si in the schema cache' };

  test('falls back to the two-write path when the RPC is absent', async () => {
    const store = baseStore({
      rpcResponse: { data: null, error: MISSING },
      creditRows: [{ amount_centi: 8000 }], // balance 8000, due 5000 → apply 5000
    });
    const res = await applyCustomerCreditToSi(fakeSb(store), ARGS);

    expect(res.applied).toBe(5000);
    // The fallback IS the two separate cross-table writes the RPC replaces.
    const tables = store.inserts.map((i) => i.table).sort();
    expect(tables).toEqual(['customer_credits', 'sales_invoice_payments']);
    const ledger = store.inserts.find((i) => i.table === 'customer_credits');
    expect(ledger?.payload).toMatchObject({ amount_centi: -5000, source_type: 'APPLIED_TO_SI' });
  });

  test('fallback still honours the credit-payment idempotency guard', async () => {
    const store = baseStore({
      rpcResponse: { data: null, error: MISSING },
      existingCreditPayments: [{ id: 'pay-1', amount_centi: 5000 }],
      creditRows: [{ amount_centi: 8000 }],
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
    const res = await applyCustomerCreditToSi(fakeSb(store), { ...ARGS, remainingDueCenti: 0 });
    expect(res).toEqual({ applied: 0, reason: 'no_due' });
    expect(store.rpcCalls).toHaveLength(0);
  });
});

/* MIGRATED INVOICES SPEND NO CREDIT (migration 0280).
   A migrated SI mirrors an invoice AutoCount already raised and already settled
   in its own book. Paying it from the customer's ERP credit balance spends a
   real balance a second time — the customer silently loses money still owed to
   them. Migration 0280's column COMMENT promises this; these pin the promise to
   behaviour, because 0276 shipped exactly such a comment with nothing enforcing
   it. Today's three callers all miss migrated invoices by accident, so an
   accident is all that stands here without the guard. */
describe('applyCustomerCreditToSi — migrated source (migration 0280)', () => {
  test('migrated SI → applies nothing, and never reaches the write', async () => {
    const store = baseStore({ migrated: true, creditRows: [{ balance_centi: 900000 }] });
    const res = await applyCustomerCreditToSi(fakeSb(store), ARGS);
    expect(res).toEqual({ applied: 0, reason: 'migrated_source' });
    /* The money assertions are the point: no RPC, no ledger row, no payment row.
       A guard that returns the right shape after spending the credit is no
       guard. */
    expect(store.rpcCalls).toHaveLength(0);
    expect(store.inserts).toHaveLength(0);
    expect(store.updates).toHaveLength(0);
  });

  test('an ordinary SI is untouched by the guard — it still applies credit', async () => {
    const store = baseStore({
      migrated: false,
      rpcResponse: { data: [{ applied_centi: 5000 }], error: null },
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

// ============================================================================
// PURCHASE-INVOICE SETTLEMENT — the same defect class, the other direction.
//
// Lives in this file rather than its own because the backend vitest config runs
// singleWorker after a capacity cliff, so each extra test FILE costs more than
// the tests inside it. It belongs with the above in any case: both are "money
// moved by a write PostgREST cannot make atomic", both ship their SQL in
// scripts/scm-schema/ for manual application, and both fall back to a legacy
// path until that SQL is applied.
//
// THE BUG: two payment vouchers settling the SAME purchase invoice each read
// `outstanding = total - paid`, each applied their full share against it, and
// the invoice ended up paid twice over. The stale value was the CAP, not the
// addend — the optimistic gate made sure BOTH increments landed, which is
// exactly why retrying harder never helped.
//
// Route-level tests are impossible here (scm rides Supabase Postgres through
// Hyperdrive; the test harness is D1), so the pure rule is pinned directly and
// the client interaction is driven through a fake PostgREST.
// ============================================================================
import { computePiSettlement, settlePiPaidCenti } from './pi-settlement';

describe('computePiSettlement — behaviour with no concurrency is unchanged', () => {
  /* The old rule, verbatim from payment-vouchers.ts before this change. When
     nothing races the caller pre-capped the allocation at `outstanding`, so
     paid + delta never exceeded total and the new upper clamp cannot bite.
     Asserted directly rather than left to inspection. */
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
      const got = computePiSettlement({ paidCenti: paid, totalCenti: total, status: 'POSTED', deltaCenti: delta });
      expect(got.newPaidCenti).toBe(oldRule(paid, delta));
      expect(got.clampedCenti).toBe(0);
    });
  }

  test('re-derives status the same way', () => {
    expect(computePiSettlement({ paidCenti: 0, totalCenti: 10_000, status: 'POSTED', deltaCenti: 10_000 }).newStatus).toBe('PAID');
    expect(computePiSettlement({ paidCenti: 0, totalCenti: 10_000, status: 'POSTED', deltaCenti: 4_000 }).newStatus).toBe('PARTIALLY_PAID');
    expect(computePiSettlement({ paidCenti: 4_000, totalCenti: 10_000, status: 'PARTIALLY_PAID', deltaCenti: -4_000 }).newStatus).toBe('POSTED');
  });
});

describe('computePiSettlement — the over-payment the clamp exists to stop', () => {
  test('two vouchers settling the same invoice: the second is refused, not absorbed', () => {
    const TOTAL = 10_000;
    /* Both vouchers were raised against an unpaid invoice and both ask for the
       full amount. Serialised by the row lock, they now run one after the other
       instead of both reading paid_centi 0. */
    const first = computePiSettlement({ paidCenti: 0, totalCenti: TOTAL, status: 'POSTED', deltaCenti: TOTAL });
    expect(first.appliedCenti).toBe(TOTAL);
    expect(first.clampedCenti).toBe(0);

    const second = computePiSettlement({ paidCenti: first.newPaidCenti, totalCenti: TOTAL, status: 'POSTED', deltaCenti: TOTAL });
    expect(second.newPaidCenti).toBe(TOTAL);   // NOT 20_000
    expect(second.appliedCenti).toBe(0);       // nothing moved
    expect(second.clampedCenti).toBe(TOTAL);   // and we can say exactly how much was refused
  });

  test('a partial over-allocation applies what fits and reports the rest', () => {
    const got = computePiSettlement({ paidCenti: 8_000, totalCenti: 10_000, status: 'POSTED', deltaCenti: 5_000 });
    expect(got.newPaidCenti).toBe(10_000);
    expect(got.appliedCenti).toBe(2_000);
    expect(got.clampedCenti).toBe(3_000);
    expect(got.newStatus).toBe('PAID');
  });

  test('applied + clamped always equals what was asked for', () => {
    for (const delta of [1, 500, 10_000, 25_000]) {
      const got = computePiSettlement({ paidCenti: 3_000, totalCenti: 10_000, status: 'POSTED', deltaCenti: delta });
      expect(got.appliedCenti + got.clampedCenti).toBe(delta);
    }
  });
});

describe('computePiSettlement — reversals are never clamped upward', () => {
  test('a cancel floors at zero, and says how much the floor absorbed', () => {
    /* The floor lands on the same paid_centi the old rule did — but reversing
       5,000 off an invoice carrying only 1,000 means the allocation and the
       invoice disagree about what was ever applied. The old rule absorbed that
       silently; a negative clamp is how it now gets said out loud. */
    const got = computePiSettlement({ paidCenti: 1_000, totalCenti: 10_000, status: 'PARTIALLY_PAID', deltaCenti: -5_000 });
    expect(got.newPaidCenti).toBe(0);        // unchanged from the old rule
    expect(got.newStatus).toBe('POSTED');
    expect(got.appliedCenti).toBe(-1_000);   // only 1,000 was actually there to take off
    expect(got.clampedCenti).toBe(-4_000);   // the other 4,000 never existed on this PI
  });

  test('an ALREADY over-paid invoice can still unwind completely', () => {
    /* Rows the race already produced (paid > total) must stay reversible, or
       the excess is stranded on the invoice with no way to take it off. */
    const got = computePiSettlement({ paidCenti: 20_000, totalCenti: 10_000, status: 'PAID', deltaCenti: -20_000 });
    expect(got.newPaidCenti).toBe(0);
    expect(got.appliedCenti).toBe(-20_000);
    expect(got.clampedCenti).toBe(0);
  });

  test('a positive settle never drags an already over-paid invoice DOWN to total', () => {
    const got = computePiSettlement({ paidCenti: 20_000, totalCenti: 10_000, status: 'PAID', deltaCenti: 500 });
    expect(got.newPaidCenti).toBe(20_000); // unchanged, not silently corrected to 10_000
    expect(got.appliedCenti).toBe(0);
    expect(got.clampedCenti).toBe(500);
  });
});

describe('computePiSettlement — a DRAFT or CANCELLED invoice is not a live liability', () => {
  for (const status of ['DRAFT', 'CANCELLED', 'draft', 'cancelled']) {
    test(`${status} is skipped`, () => {
      const got = computePiSettlement({ paidCenti: 0, totalCenti: 10_000, status, deltaCenti: 5_000 });
      expect(got.skipped).toBe(true);
      expect(got.appliedCenti).toBe(0);
      expect(got.newPaidCenti).toBe(0);
    });
  }
});

/** Minimal PostgREST stand-in for the settle paths: one .rpc() and one
 *  purchase_invoices select/update chain. */
function fakePiSb(opts: {
  rpc: { data: unknown; error: { code?: string; message?: string } | null };
  row?: { paid_centi: number; total_centi: number; status: string } | null;
  updateRows?: unknown[];
  updateError?: { message: string } | null;
}) {
  const calls = {
    rpc: [] as Array<{ fn: string; params: Record<string, unknown> }>,
    updates: [] as Record<string, unknown>[],
  };
  const row = opts.row === undefined ? { paid_centi: 0, total_centi: 10_000, status: 'POSTED' } : opts.row;
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

describe('settlePiPaidCenti — routes through the atomic function, falls back only when it is absent', () => {
  test('primary path calls the RPC and does no table write of its own', async () => {
    const f = fakePiSb({ rpc: { data: [{ applied_centi: 2_000, new_paid_centi: 10_000, new_status: 'PAID', reason: null }], error: null } });
    const res = await settlePiPaidCenti(f.sb, 'pi-1', 5_000);
    expect(f.calls.rpc).toEqual([{ fn: 'settle_pi_paid_centi', params: { p_pi_id: 'pi-1', p_delta: 5_000 } }]);
    expect(f.calls.updates).toHaveLength(0);
    expect(res.ok).toBe(true);
    expect(res.appliedCenti).toBe(2_000);
    // 5_000 asked, 2_000 applied — the caller must be able to see the 3_000 gap.
    expect(res.clampedCenti).toBe(3_000);
  });

  test('an ABSENT function falls back to the legacy path and still clamps', async () => {
    const f = fakePiSb({
      rpc: { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } },
      row: { paid_centi: 8_000, total_centi: 10_000, status: 'POSTED' },
    });
    const res = await settlePiPaidCenti(f.sb, 'pi-1', 5_000);
    expect(res.ok).toBe(true);
    expect(res.legacy).toBe(true);
    expect(res.appliedCenti).toBe(2_000);
    expect(res.clampedCenti).toBe(3_000);
    expect(f.calls.updates[0]).toMatchObject({ paid_centi: 10_000, status: 'PAID' });
  });

  test('a LIVE rpc error never degrades to the non-atomic path', async () => {
    const f = fakePiSb({ rpc: { data: null, error: { code: '23514', message: 'check constraint violated' } } });
    const res = await settlePiPaidCenti(f.sb, 'pi-1', 5_000);
    expect(res.ok).toBe(false);
    expect(res.appliedCenti).toBe(0);
    expect(f.calls.updates).toHaveLength(0); // did NOT retry against the database that just refused
  });

  test('a zero delta settles nothing and never reaches the database', async () => {
    const f = fakePiSb({ rpc: { data: null, error: null } });
    const res = await settlePiPaidCenti(f.sb, 'pi-1', 0);
    expect(res.appliedCenti).toBe(0);
    expect(f.calls.rpc).toHaveLength(0);
  });

  test('a failed legacy update reports applied 0, so no settlement is recorded', async () => {
    const f = fakePiSb({
      rpc: { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } },
      row: { paid_centi: 0, total_centi: 10_000, status: 'POSTED' },
      updateError: { message: 'connection reset' },
    });
    const res = await settlePiPaidCenti(f.sb, 'pi-1', 5_000);
    expect(res.ok).toBe(false);
    expect(res.appliedCenti).toBe(0);
  });
});
