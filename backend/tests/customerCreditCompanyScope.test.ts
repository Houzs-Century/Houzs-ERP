/* Customer-credit balance reads are scoped to ONE company.
 *
 * WHY THIS EXISTS. `scm.customer_credits.company_id` is NOT NULL (mig 0083),
 * and mig 0123 re-keyed `scm.customers` on `(customer_code, company_id)` — so
 * the SAME debtor code legitimately names a DIFFERENT customer in each company.
 * `getCustomerCreditBalance` summed on `debtor_code` alone, which pooled both
 * companies' ledgers into one balance. The callers that SPEND that balance then
 * stamp the INVOICE's company on the debit row, so the divergence was silent:
 * company A's invoice consumed company B's credit and only the debit carried a
 * company.
 *
 * BOTH DIRECTIONS are asserted, deliberately. The failure mode of this kind of
 * change is not "the leak stayed open", it is "we stopped a company spending its
 * own credit" — so every isolation test is paired with a same-company test
 * proving the legitimate path still works.
 */
import { describe, expect, test } from 'vitest';
import {
  applyCustomerCreditToSi,
  getCustomerCreditBalance,
} from '../src/scm/lib/customer-credits';

const CO_A = 1; // HOUZS
const CO_B = 2; // 2990

type Row = Record<string, any>;

/* Minimal PostgREST-shaped fake: enough to run the balance sum and the legacy
   two-write fallback. Same approach as companyWriteScope.test.ts. */
class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'insert' | 'update' = 'select';
  private payload: Row | null = null;
  constructor(
    private table: string,
    private rows: Row[],
    private log: string[],
  ) {}
  select() { return this; }
  limit() { return this; }
  insert(p: Row) { this.op = 'insert'; this.payload = p; return this; }
  update(p: Row) { this.op = 'update'; this.payload = p; return this; }
  eq(col: string, val: unknown) {
    this.log.push(`${this.table}.eq:${col}`);
    this.preds.push((r) => String(r[col]) === String(val));
    return this;
  }
  private run() {
    if (this.op === 'insert' && this.payload) {
      this.rows.push({ ...this.payload });
      return [];
    }
    const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.op === 'update' && this.payload) {
      for (const r of hit) Object.assign(r, this.payload);
    }
    return hit;
  }
  maybeSingle() {
    const hit = this.run();
    return Promise.resolve({ data: hit[0] ?? null, error: null });
  }
  single() {
    // The insert path reads back `id`; the row itself is already appended.
    this.run();
    return Promise.resolve({ data: { id: 'row-1' }, error: null });
  }
  then(res: (v: any) => any, rej?: (e: any) => any) {
    return Promise.resolve({ data: this.run(), error: null }).then(res, rej);
  }
}

function fakeSb(tables: Record<string, Row[]>, log: string[], rpcPresent: boolean) {
  return {
    from(table: string) {
      tables[table] ??= [];
      return new FakeQuery(table, tables[table], log);
    },
    rpc() {
      // Absent RPC -> the helper falls back to the legacy two-write path, which
      // is the path this test can actually observe.
      return Promise.resolve(
        rpcPresent
          ? { data: [{ applied_sen: 0, reason: 'stub' }], error: null }
          : { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } },
      );
    },
  };
}

/* One debtor code, held by BOTH companies — exactly what mig 0123 permits.
   Company A holds 100 centi of credit; company B holds 9900. */
function ledger(): Record<string, Row[]> {
  return {
    customer_credits: [
      { debtor_code: 'C-001', company_id: CO_A, amount_sen: 100 },
      { debtor_code: 'C-001', company_id: CO_B, amount_sen: 9900 },
    ],
    sales_invoices: [
      { id: 'si-a', company_id: CO_A, migrated_no_stock: false },
      { id: 'si-b', company_id: CO_B, migrated_no_stock: false },
    ],
    sales_invoice_payments: [],
  };
}

describe('getCustomerCreditBalance is company-scoped', () => {
  test('a company sees ONLY its own credit ledger', async () => {
    const log: string[] = [];
    const sb = fakeSb(ledger(), log, false);
    expect(await getCustomerCreditBalance(sb, 'C-001', CO_A)).toBe(100);
    expect(log).toContain('customer_credits.eq:company_id');
  });

  test('the other company sees its own, and never the sum of both', async () => {
    const sb = fakeSb(ledger(), [], false);
    const b = await getCustomerCreditBalance(sb, 'C-001', CO_B);
    expect(b).toBe(9900);
    expect(b).not.toBe(10000); // 100 + 9900 — the pooled answer
  });

  test('an UNRESOLVED company degrades to no predicate, not to a lockout', async () => {
    /* Matches the three-state sentinel in companyScope.ts: unresolved must not
       blank a single-company install. This is the one case that still pools, and
       it is reachable only when the companies master is unreadable. */
    const sb = fakeSb(ledger(), [], false);
    expect(await getCustomerCreditBalance(sb, 'C-001', null)).toBe(10000);
  });
});

describe('applying credit cannot cross a company', () => {
  test("company A's invoice cannot spend company B's credit", async () => {
    const tables = ledger();
    const sb = fakeSb(tables, [], false);
    /* si-a is company A, whose ledger holds only 100. The pooled read would have
       found 10000 and paid the whole 5000 due out of company B's balance. */
    const res = await applyCustomerCreditToSi(sb, {
      debtorCode: 'C-001',
      siId: 'si-a',
      siNumber: 'HC-SI-2608-001',
      remainingDueSen: 5000,
    });
    expect(res.applied).toBe(100);

    const debits = tables.customer_credits.filter((r) => r.amount_sen < 0);
    expect(debits).toHaveLength(1);
    expect(debits[0].company_id).toBe(CO_A);
    expect(debits[0].amount_sen).toBe(-100);
    // Company B's 9900 is untouched.
    expect(
      tables.customer_credits.filter((r) => r.company_id === CO_B && r.amount_sen > 0),
    ).toHaveLength(1);
  });

  test('a company spending its OWN credit still works', async () => {
    const tables = ledger();
    const sb = fakeSb(tables, [], false);
    const res = await applyCustomerCreditToSi(sb, {
      debtorCode: 'C-001',
      siId: 'si-b',
      siNumber: '2990-SI-2608-001',
      remainingDueSen: 5000,
    });
    expect(res.applied).toBe(5000);
    const debits = tables.customer_credits.filter((r) => r.amount_sen < 0);
    expect(debits).toHaveLength(1);
    expect(debits[0].company_id).toBe(CO_B);
  });
});
