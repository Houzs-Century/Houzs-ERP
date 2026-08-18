// ----------------------------------------------------------------------------
// A REFUSAL MUST NAME THE CONDITION THAT FAILED — at the HTTP boundary.
//
// THE BUG, and what it cost. The proceed gate weighs FIVE conditions (customer
// name, delivery address line 1, postcode, delivery date, deposit) and refused
// with ONE stored sentence naming ALL FIVE whenever ANY ONE of them failed:
//
//   "A Processing Date can only be set once the order has a customer name, a
//    full delivery address (line 1 and postcode), a delivery date, and the
//    deposit its company requires (Houzs 30%, 2990 50%)."
//
// On 2026-08-17 the owner hit that on a ZERO-TOTAL order, read the word
// "deposit", and concluded the system was demanding half of nothing. It was
// not: meetsDepositGate short-circuits at `total <= 0` — "nothing to collect, so
// the gate is vacuously met", its own docblock — so the deposit term had
// PASSED. The order was missing its postcode. A day went to the wrong diagnosis
// because the refusal could not say which of the five had failed.
//
// WHY THIS FILE IS A ROUTE TEST AND NOT ONLY A UNIT TEST. The collector is unit-
// tested in src/scm/shared/so-save-problems.test.ts, and the collector was never
// the hard part — the wiring was. What the owner actually reads is an HTTP body,
// so that is what is asserted here: the real handler, the real gate, the real
// JSON. A string in a shared module is not a string on a screen.
// ----------------------------------------------------------------------------
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { patchMfgSalesOrderHeaderHandler } from '../src/scm/routes/mfg-sales-orders';

type Row = Record<string, unknown>;

/** Minimal PostgREST-shaped stub — the same shape mfgSalesOrderHeaderCas.test.ts
 *  uses, trimmed to the reads this path makes (header row + payments ledger). */
class FakeQuery {
  private predicates: Array<(row: Row) => boolean> = [];
  constructor(private readonly rows: Row[]) {}
  select() { return this; }
  update() { return this; }
  eq(column: string, value: unknown) {
    this.predicates.push((row) => String(row[column]) === String(value));
    return this;
  }
  neq() { return this; }
  or() { return this; }
  is() { return this; }
  private run(): Row[] {
    return this.rows.filter((row) => this.predicates.every((p) => p(row)));
  }
  maybeSingle() { return Promise.resolve({ data: this.run()[0] ?? null, error: null }); }
  then(resolve: (v: { data: Row[]; error: null }) => unknown, reject?: (r: unknown) => unknown) {
    return Promise.resolve({ data: this.run(), error: null }).then(resolve, reject);
  }
}

/** One SO, and the facts the proceed gate weighs, all overridable. Defaults are
 *  THE OWNER'S ORDER: complete but for the postcode, and worth nothing. */
function harness(over: {
  header?: Row;
  payments?: Row[];
  companyCode?: string;
} = {}) {
  const tables: Record<string, Row[]> = {
    mfg_sales_orders: [{
      doc_no: 'SO-PROCEED-1',
      company_id: 1,
      version: 1,
      status: 'CONFIRMED',
      debtor_name: 'Fictional Customer Sdn Bhd',
      address1: '12 Jalan Contoh',
      postcode: null,                    // ← the condition that actually failed
      customer_delivery_date: '2099-03-01',
      processing_date: '2099-02-01',
      proceeded_at: null,
      local_total_centi: 0,              // ← free order: nothing to collect
      edit_lease_token: null,
      edit_lease_expires_at: null,
      ...(over.header ?? {}),
    }],
    mfg_sales_order_payments: over.payments ?? [],   // nothing paid
    mfg_so_audit_log: [],
    mfg_sales_order_items: [],
  };
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, {
      from: (table: string) => new FakeQuery((tables[table] ||= [])),
      rpc: async () => ({ data: [{ applied: true, current_version: 2 }], error: null }),
    } as never);
    /* The header PATCH became a STRICT company write (an unresolved company is
       refused, not defaulted to Houzs by mig 0164's COALESCE). The fixture
       carries the company its own row already has. */
    c.set('companyId' as never, 1 as never);
    c.set('user' as never, { id: 'actor-1', user_metadata: { name: 'Test User' } } as never);
    c.set('companyCode' as never, (over.companyCode ?? 'HOUZS') as never);
    c.set('houzsUser' as never, {
      id: 1, position_name: 'Super Admin', permissions_set: new Set(['*']),
    } as never);
    await next();
  });
  app.patch('/mfg-sales-orders/:docNo', patchMfgSalesOrderHeaderHandler as never);
  return app;
}

/** The act: mark this order Proceeded.
 *
 *  THIS USED TO SEND `proceededAt`, and on 2026-08-18 that stopped being an act
 *  at all. The owner ruled, for the third time, that there is ONE Processing
 *  Date across frontend, backend and database, so `proceeded_at` — the second
 *  storage — left the header PATCH map entirely: no request body can reach the
 *  column, and a PATCH carrying that key is now a no-op rather than a proceed.
 *  Proceeding IS setting the Processing Date (*"只要有 Processing Date，就代表他
 *  Proceed 了"*), so that is what this sends.
 *
 *  EVERY ASSERTION BELOW IS THE ONE #2383 WROTE, and every one still holds on
 *  this path: one problem per failed condition, named, with the word "deposit"
 *  absent from a zero-total order. What moved is the envelope — `validation_failed`
 *  with `message`, not `proceed_gate_unmet` with `reason`, because the surviving
 *  refusal is the aggregated Processing-Date gate. authed-fetch.ts renders both
 *  (it has carried a `validation_failed` entry since before either change), and
 *  the per-condition problems[] the operator reads are byte-identical. */
const proceed = (app: Hono) => app.request('/mfg-sales-orders/SO-PROCEED-1', {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ processingDate: '2099-04-01', customerDeliveryDate: '2099-05-01', version: 1 }),
});

describe('the proceed refusal names the condition that failed', () => {
  test("THE OWNER'S ORDER: zero total, nothing paid, no postcode — the body says POSTCODE and never says deposit", async () => {
    const res = await proceed(harness());
    expect(res.status).toBe(422);
    const body = await res.json() as { error: string; message: string; problems: Array<{ field?: string; message: string }> };

    /* Clients match on the code. It DID move, with the act — see `proceed`. */
    expect(body.error).toBe('validation_failed');

    /* Exactly one condition failed, and the refusal names exactly it. */
    expect(body.problems).toHaveLength(1);
    expect(body.problems[0]!.field).toBe('Postcode');
    expect(body.problems[0]!.message.toLowerCase()).toContain('postcode');

    /* THE REGRESSION. The word that cost a day must not appear ANYWHERE in the
       response — not in `reason`, not in a problem, not in a field name. The
       deposit term PASSED on this order (total <= 0), so naming it is a lie. */
    expect(JSON.stringify(body).toLowerCase()).not.toContain('deposit');

    /* And the single-string key an un-migrated client, a log line or a PDF reads
       is the failing condition rather than a recital of all five. THE POINT OF
       #2383, preserved verbatim through the envelope change. */
    expect(body.message.toLowerCase()).toContain('postcode');
    expect(body.message.toLowerCase()).not.toContain('customer name');
    expect(body.message.toLowerCase()).not.toContain('delivery date');
  });

  test('several conditions missing → EVERY one is named, in one response (owner 2026-07-18)', async () => {
    const app = harness({
      header: { debtor_name: null, address1: null, postcode: null, customer_delivery_date: null },
    });
    const res = await proceed(app);
    expect(res.status).toBe(422);
    const body = await res.json() as { problems: Array<{ field?: string }> };
    /* Delivery date is supplied BY this request (the pair rule refuses a
       Processing Date without one), so the three the row is missing are named. */
    expect(body.problems.map((p) => p.field)).toEqual(['Customer', 'Address', 'Postcode']);
    /* Still no deposit line: the order is still worth nothing. */
    expect(JSON.stringify(body).toLowerCase()).not.toContain('deposit');
  });

  test('a REAL deposit shortfall states what is paid, what is needed and the company %', async () => {
    const app = harness({
      header: { local_total_centi: 1000_00 },      // RM 1,000 order
      payments: [{ so_doc_no: 'SO-PROCEED-1', amount_centi: 100_00 }],  // RM 100 in
      companyCode: '2990',                          // 2990's rule is 50%
    });
    const res = await proceed(app);
    expect(res.status).toBe(422);
    const body = await res.json() as { problems: Array<{ field?: string; message: string }> };
    /* The postcode is still missing, so both conditions are named — and each
       says its own thing. */
    expect(body.problems.map((p) => p.field)).toEqual(['Postcode', 'Deposit']);
    const deposit = body.problems.find((p) => p.field === 'Deposit')!;
    expect(deposit.message).toContain('RM 100');   // what is actually paid
    expect(deposit.message).toContain('RM 500');   // 50% of RM 1,000
    expect(deposit.message).toContain('50%');      // 2990's rule, not Houzs's 30%
  });

  test('an order that clears every condition is NOT refused — the outcomes did not move', async () => {
    const app = harness({ header: { postcode: '43300' } });
    const res = await proceed(app);
    /* 200, not merely "not 422". This is the one case in the file that passes on
       the pre-change tree, so it is the half of the proof carrying the "nothing
       else moved" claim — and `not.toBe(422)` would also hold on a 500, which is
       exactly how a proceed path that started throwing would slip past it. */
    expect(res.status).toBe(200);
  });
});
