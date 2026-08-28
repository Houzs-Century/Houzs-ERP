// "The payment defines the FX rate" — the ROUTE behaviour (owner-approved 2026-07-30).
//
// The decision table itself is pure and covered in src/scm/lib/pv-rate-adoption.test.ts.
// What this file proves is the part a pure function cannot:
//   · posting a voucher WRITES the rate onto the un-rated invoice;
//   · the GRN behind that invoice is genuinely RE-COSTED at the adopted rate — the
//     FIFO lot's unit_cost_sen moves off the raw foreign figure;
//   · the change is recorded on the INVOICE's own history, naming the voucher;
//   · a costing failure cannot fail a payment whose journal entry is already
//     committed and whose money has already left the bank;
//   · an all-MYR flow is byte-for-byte unaffected.
//
// Driven through a bare Hono app with a fake PostgREST client, mounting the
// exported handlers (the supabaseAuth bridge cannot run here). Same harness shape
// as tests/companyScopeHardening.test.ts.
//
// NO vi.mock, DELIBERATELY. Under the Cloudflare Workers pool it does not reliably
// intercept module imports (so-revision.reviseBoundPo.test.ts records the same
// finding), so the REAL recostFromGrn runs against the fake client and the
// assertion is on the lot it re-costs. That is the stronger test anyway: a mock
// would only prove a function was called, not that the adopted rate reached the
// inventory basis, which is the entire point of the change.

import { Hono } from 'hono';
import { beforeEach, describe, expect, test } from 'vitest';
import { computePiSettlement } from '../src/scm/lib/pi-settlement';
import { postPaymentVoucherHandler, cancelPaymentVoucherHandler } from '../src/scm/routes/payment-vouchers';

const CO = 1;
type Row = Record<string, any>;

class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'update' | 'delete' | 'insert' = 'select';
  private patch: Row = {};
  private inserted: Row[] = [];
  constructor(private rows: Row[], private table: string) {}
  select() { return this; }
  order() { return this; }
  limit() { return this; }
  like() { return this; }
  update(p: Row) { this.op = 'update'; this.patch = p; return this; }
  delete() { this.op = 'delete'; return this; }
  insert(p: Row | Row[]) { this.op = 'insert'; this.inserted = Array.isArray(p) ? p : [p]; return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
  neq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) !== String(val)); return this; }
  in(col: string, vals: unknown[]) {
    const s = new Set((vals ?? []).map(String));
    this.preds.push((r) => s.has(String(r[col])));
    return this;
  }
  is() { return this; }
  private run(): Row[] {
    if (this.op === 'insert') {
      const withIds = this.inserted.map((r, i) => ({ id: r.id ?? `${this.table}-${this.rows.length + i + 1}`, ...r }));
      this.rows.push(...withIds);
      return withIds;
    }
    const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.op === 'update') for (const r of hit) Object.assign(r, this.patch);
    if (this.op === 'delete') for (const r of hit) this.rows.splice(this.rows.indexOf(r), 1);
    return hit;
  }
  maybeSingle() { const h = this.run(); return Promise.resolve({ data: h[0] ?? null, error: null }); }
  single() {
    const h = this.run();
    return Promise.resolve({ data: h[0] ?? null, error: h.length ? null : { message: 'no rows' } });
  }
  then(res: (v: any) => any, rej?: (e: any) => any) {
    return Promise.resolve({ data: this.run(), error: null }).then(res, rej);
  }
}

/** `breakTable` makes one table throw on access — the only way to simulate a
 *  costing-layer outage without module mocking. */
function harness(tables: Record<string, Row[]>, breakTable?: string) {
  const app = new Hono();
  /* scm.doc_number_counters, in memory. The JE number this handler mints comes
     from scm.next_doc_no_n (migration 0316), so a fake PostgREST that does not
     answer it is modelling a database without the function — which now REFUSES
     rather than quietly minting from the live max, on purpose. Same arithmetic
     as the real one: GREATEST(counter, floor + 1), and it only goes up. */
  const counters = new Map<string, number>();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, {
      from: (t: string) => {
        if (t === breakTable) throw new Error(`simulated outage on ${t}`);
        return new FakeQuery((tables[t] ||= []), t);
      },
      /* Route by function name. The audit pre-flight must report writable or every
         handler 409s before reaching the settlement loop; settle_pi_paid_sen runs
         the REAL clamp rule (computePiSettlement — the pure function the SQL is a
         transcription of), so the applied figure the adoption keys off is the one
         production would produce. */
      /* `.schema('public')` — the real client returns one scoped to that schema.
         These stubs model ONE table namespace, so it returns the stub itself.
         Needed because jePrefixForCompany reads `public.companies` while the SCM
         client is pinned to `scm`; without it the stub throws
         `sb.schema is not a function` and the handler 500s. See docs/bugs/0522. */
      schema(_s: string) { return this; },
      rpc: async (fn: string, args: Row) => {
        if (fn === 'entity_audit_writable') return { data: true, error: null };
        if (fn === 'settle_pi_paid_sen') {
          const pi = (tables.purchase_invoices ?? []).find((p) => p.id === args.p_pi_id);
          if (!pi) return { data: [{ applied_sen: 0, reason: 'not_found' }], error: null };
          const calc = computePiSettlement({
            paidSen: Number(pi.paid_sen ?? 0),
            totalSen: Number(pi.total_sen ?? 0),
            status: pi.status,
            deltaSen: Number(args.p_delta ?? 0),
          });
          if (!calc.skipped) { pi.paid_sen = calc.newPaidSen; pi.status = calc.newStatus; }
          return {
            data: [{ applied_sen: calc.skipped ? 0 : calc.appliedSen, new_paid_sen: pi.paid_sen, new_status: pi.status }],
            error: null,
          };
        }
        if (fn === 'next_doc_no_n') {
          const series = String(args.p_series);
          const floor = Math.max(0, Number(args.p_floor ?? 0));
          const n = Math.max(counters.get(series) ?? 0, floor + 1);
          counters.set(series, n + 1);
          return { data: n, error: null };
        }
        return { data: null, error: { message: `unexpected rpc ${fn}` } };
      },
    } as never);
    c.set('companyId' as never, CO as never);
    c.set('user' as never, { id: 'u1' } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as never);
    await next();
  });
  app.post('/payment-vouchers/:id/post', postPaymentVoucherHandler as never);
  app.post('/payment-vouchers/:id/cancel', cancelPaymentVoucherHandler as never);
  return app;
}

/* The owner's real 2026-07-30 shape. One RMB purchase invoice of ¥21,625.00
   (2,162,500 centi) billing one RMB GRN, BOTH booked at rate 1 because nobody had
   filled in the RMB rate — so the lot carries 2,162,500 sen as if ¥ were RM (audit
   finding R2). The owner then pays for it at 0.619838, and that payment is the only
   place the true rate is written down. */
const RMB_RATE = 0.619838;
const FACE_SEN = 2_162_500;
/** What the lot SHOULD carry once the rate is known: round(¥21,625.00 × 0.619838)
 *  = 1_340_401 sen, i.e. RM 13,404.01 — down from the RM 21,625.00 the 1:1 basis
 *  had capitalised. */
const EXPECTED_LOT_SEN = Math.round(FACE_SEN * RMB_RATE);

const world = (over: {
  piCurrency?: string; piRate?: number; piPaid?: number; piStatus?: string;
  pvCurrency?: string; pvRate?: number; pvPurpose?: string; piGrnId?: string | null;
} = {}) => {
  const tables: Record<string, Row[]> = {
    payment_vouchers: [{
      id: 'pv-1', pv_number: '2990-PV-2607-001', company_id: CO, status: 'DRAFT',
      voucher_date: '2026-07-30', payee_name: 'Shenzhen Vendor', credit_account_code: '1000',
      currency: over.pvCurrency ?? 'RMB', exchange_rate: over.pvRate ?? RMB_RATE,
      purpose: over.pvPurpose ?? 'SUPPLIER_PAYMENT', total_sen: FACE_SEN,
      /* Phase 3: this suite tests the RATE mechanics, so the voucher arrives
         already through the approval queue — the gate itself is
         tests/pvApproval.test.ts's contract. */
      submitted_at: '2026-07-30T01:00:00Z', submitted_by: 'Tester',
      approved_at: '2026-07-30T02:00:00Z', approved_by: 'Tester',
    }],
    payment_voucher_lines: [{
      id: 'pvl-1', pv_id: 'pv-1', line_no: 1, description: 'Sofa order',
      debit_account_code: '2000', amount_sen: FACE_SEN,
    }],
    pv_allocations: [{ id: 'alloc-1', pv_id: 'pv-1', pi_id: 'pi-1', amount_sen: FACE_SEN, applied_sen: 0 }],
    purchase_invoices: [{
      id: 'pi-1', invoice_number: '2990-PI-2607-004', company_id: CO,
      status: over.piStatus ?? 'POSTED',
      currency: over.piCurrency ?? 'RMB', exchange_rate: over.piRate ?? 1,
      grn_id: over.piGrnId === undefined ? 'grn-1' : over.piGrnId,
      total_sen: FACE_SEN, paid_sen: over.piPaid ?? 0,
    }],

    /* The costing side recostFromGrn actually walks: the GRN + its one line, the PI
       line billing it, and the FIFO lot that line opened — currently carrying the
       raw foreign figure. Everything else recost touches (consumptions, OUT
       movements, DOs, SIs) is legitimately empty for a receipt nothing has sold yet. */
    grns: [{ id: 'grn-1', grn_number: '2990-GRN-2606-001', exchange_rate: 1, allocation_method: 'VALUE' }],
    grn_items: [{
      id: 'gi-1', grn_id: 'grn-1', item_code: 'SOFA-A', item_group: null, variants: null,
      unit_price_sen: FACE_SEN, qty_accepted: 1, allocated_charge_sen: 0,
      purchase_order_item_id: null,
    }],
    purchase_invoice_items: [{
      id: 'pii-1', purchase_invoice_id: 'pi-1', grn_item_id: 'gi-1',
      qty: 1, unit_price_sen: FACE_SEN, allocated_charge_sen: 0,
    }],
    inventory_lots: [{
      id: 'lot-1', source_doc_type: 'GRN', source_doc_id: 'grn-1',
      item_code: 'SOFA-A', variant_key: '', batch_no: null,
      qty_received: 1, movement_id: 'mov-1', unit_cost_sen: FACE_SEN,
    }],
    inventory_movements: [{ id: 'mov-1', source_doc_type: 'GRN', source_doc_id: 'grn-1', unit_cost_sen: FACE_SEN, total_cost_sen: FACE_SEN }],
    inventory_lot_consumptions: [],

    journal_entries: [], journal_entry_lines: [], entity_audit_log: [], suppliers: [],
  };
  return tables;
};

const post = (app: Hono) => app.request('/payment-vouchers/pv-1/post', { method: 'POST' });
const cancel = (app: Hono) => app.request('/payment-vouchers/pv-1/cancel', { method: 'POST' });
const pi = (t: Record<string, Row[]>) => t.purchase_invoices[0]!;
const lot = (t: Record<string, Row[]>) => t.inventory_lots[0]!;
const rateAudits = (t: Record<string, Row[]>) =>
  (t.entity_audit_log ?? []).filter((r) => r.entity_type === 'PURCHASE_INVOICE');
/** The voucher-side summary row (the PI detail page has no History drawer yet, so
 *  this is the one the owner can actually read today). */
const pvRateSummary = (t: Record<string, Row[]>) =>
  (t.entity_audit_log ?? []).find((r) => r.entity_type === 'PAYMENT_VOUCHER'
    && String(r.note ?? '').includes('Exchange rate propagated'));

describe('the knock-off fills an UN-RATED foreign invoice and re-costs its GRN', () => {
  test('the invoice adopts the payment rate AND the FIFO lot is re-costed off the 1:1 basis', async () => {
    const t = world();
    expect(lot(t).unit_cost_sen).toBe(FACE_SEN); // the R2 mis-cost, before

    const res = await post(harness(t));
    expect(res.status).toBe(200);
    const body = await res.json() as Row;

    expect(pi(t).exchange_rate).toBe(RMB_RATE);
    // The whole point: the corrected rate reached the inventory basis.
    expect(lot(t).unit_cost_sen).toBe(EXPECTED_LOT_SEN);
    // ...and the GRN IN movement that opened it was re-stamped with the lot.
    expect(t.inventory_movements[0]!.unit_cost_sen).toBe(EXPECTED_LOT_SEN);
    expect(body.rateAdopted).toEqual(['2990-PI-2607-004: rate 1 -> 0.619838 (from 2990-PV-2607-001)']);
    expect(body.rateMismatch).toBeUndefined();
    // The settlement itself still happened — the rate work is purely additive.
    expect(pi(t).paid_sen).toBe(FACE_SEN);
    expect(pi(t).status).toBe('PAID');
  });

  test('the rate change is recorded on the INVOICE\'s history, naming the voucher as the evidence', async () => {
    const t = world();
    await post(harness(t));
    const audits = rateAudits(t);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.entity_id).toBe('pi-1');
    expect(audits[0]!.entity_doc_no).toBe('2990-PI-2607-004');
    expect(audits[0]!.action).toBe('UPDATE');
    expect(audits[0]!.note).toContain('2990-PV-2607-001');
    expect(audits[0]!.field_changes).toEqual(expect.arrayContaining([
      { field: 'exchangeRate', from: 1, to: RMB_RATE },
      { field: 'rateSourcePv', from: null, to: '2990-PV-2607-001' },
      { field: 'appliedSen', from: null, to: FACE_SEN },
    ]));
  });

  test('the VOUCHER\'s history also carries the summary — the drawer the owner can read today', async () => {
    const t = world();
    await post(harness(t));
    const row = pvRateSummary(t);
    expect(row).toBeTruthy();
    expect(row!.entity_doc_no).toBe('2990-PV-2607-001');
    expect(row!.field_changes).toEqual(expect.arrayContaining([
      { field: 'exchangeRate', from: null, to: RMB_RATE },
      { field: 'fxRateAdoptedOnPi', from: null, to: '2990-PI-2607-004: rate 1 -> 0.619838 (from 2990-PV-2607-001)' },
    ]));
  });

  test('an invoice with no GRN adopts the rate and simply has nothing to re-cost', async () => {
    const t = world({ piGrnId: null });
    const res = await post(harness(t));
    expect(res.status).toBe(200);
    expect(pi(t).exchange_rate).toBe(RMB_RATE);
    expect(lot(t).unit_cost_sen).toBe(FACE_SEN); // untouched — nothing linked it
  });
});

describe('a COSTING FAILURE CANNOT FAIL THE PAYMENT', () => {
  test('the voucher still posts 200, stays POSTED, and keeps the adopted rate', async () => {
    /* The costing layer is made to throw the moment the recost reaches it. By this
       point the journal entry is committed and the money has left the bank; anything
       other than 200 would tell the operator a payment failed that in fact went
       through. (The throw is caught by recostFromGrn's own guard; the route's
       try/catch around it is the second net, for a throw that escapes it.) */
    const t = world();
    const res = await post(harness(t, 'grn_items'));
    expect(res.status).toBe(200);
    const body = await res.json() as Row;
    expect(body.ok).toBe(true);
    expect(body.jeNo).toBeTruthy();
    expect(t.payment_vouchers[0]!.status).toBe('POSTED');
    // The rate is stored even though the cascade could not run — the next PI touch
    // recomputes the lots from it.
    expect(pi(t).exchange_rate).toBe(RMB_RATE);
    expect(body.rateAdopted).toHaveLength(1);
    // And the settlement still landed.
    expect(pi(t).paid_sen).toBe(FACE_SEN);
  });

  test('a failure DEEPER in the cascade (the lot table) also cannot fail the payment', async () => {
    const t = world();
    const res = await post(harness(t, 'inventory_lots'));
    expect(res.status).toBe(200);
    expect(t.payment_vouchers[0]!.status).toBe('POSTED');
    expect(pi(t).exchange_rate).toBe(RMB_RATE);
  });
});

describe('an invoice carrying a DIFFERENT deliberate rate is left exactly as it is', () => {
  test('the rate is NOT overwritten, nothing is re-costed, and the disagreement is reported', async () => {
    const t = world({ piRate: 0.62 });
    const res = await post(harness(t));
    expect(res.status).toBe(200);
    const body = await res.json() as Row;

    expect(pi(t).exchange_rate).toBe(0.62); // untouched
    expect(lot(t).unit_cost_sen).toBe(FACE_SEN); // no cascade ran
    expect(body.rateMismatch).toEqual(['2990-PI-2607-004: invoice rate 0.62, payment rate 0.619838 — invoice rate kept']);
    expect(body.rateAdopted).toBeUndefined();
    expect(rateAudits(t)).toHaveLength(0);
    // The disagreement is still recorded on the voucher — an un-adopted mismatch is
    // exactly the kind of thing that must not be invisible.
    expect(pvRateSummary(t)!.field_changes).toEqual(expect.arrayContaining([
      { field: 'fxRateMismatchOnPi', from: null, to: '2990-PI-2607-004: invoice rate 0.62, payment rate 0.619838 — invoice rate kept' },
    ]));
    // and the payment itself is unaffected
    expect(pi(t).paid_sen).toBe(FACE_SEN);
  });
});

describe('an ALL-MYR flow — the overwhelming majority — is completely untouched', () => {
  test('no rate write, no re-cost, no report, nothing added to the response', async () => {
    const t = world({ pvCurrency: 'MYR', pvRate: 1, piCurrency: 'MYR', piRate: 1 });
    const res = await post(harness(t));
    expect(res.status).toBe(200);
    const body = await res.json() as Row;
    expect(pi(t).exchange_rate).toBe(1);
    expect(lot(t).unit_cost_sen).toBe(FACE_SEN);
    expect(body.rateAdopted).toBeUndefined();
    expect(body.rateMismatch).toBeUndefined();
    expect(rateAudits(t)).toHaveLength(0);
    expect(pvRateSummary(t)).toBeUndefined(); // not even an FX audit row is added
    expect(pi(t).paid_sen).toBe(FACE_SEN); // the settlement still works
  });
});

describe('nothing applied means nothing adopted', () => {
  test('an already-fully-paid invoice clamps the allocation to 0 and its rate is left alone', async () => {
    const t = world({ piPaid: FACE_SEN });
    const res = await post(harness(t));
    expect(res.status).toBe(200);
    const body = await res.json() as Row;
    expect(pi(t).exchange_rate).toBe(1); // still the hole — no money reached it
    expect(lot(t).unit_cost_sen).toBe(FACE_SEN);
    expect(body.rateAdopted).toBeUndefined();
    expect(body.overAllocated).toHaveLength(1); // the clamp is still reported, as before
  });

  test('a DRAFT invoice settles nothing and is not re-rated', async () => {
    const t = world({ piStatus: 'DRAFT' });
    const res = await post(harness(t));
    expect(res.status).toBe(200);
    expect(pi(t).exchange_rate).toBe(1);
    expect(lot(t).unit_cost_sen).toBe(FACE_SEN);
  });

  test('a FREIGHT voucher settles no invoice at all, so no rate moves', async () => {
    const t = world({ pvPurpose: 'FREIGHT' });
    const res = await post(harness(t));
    expect(res.status).toBe(200);
    expect(pi(t).exchange_rate).toBe(1);
    expect(lot(t).unit_cost_sen).toBe(FACE_SEN);
  });
});

describe('CANCEL — the adopted rate is deliberately RETAINED, never reverted', () => {
  test('cancelling unwinds the settlement but leaves the rate and does NOT re-cost back', async () => {
    const t = world();
    const app = harness(t);
    await post(app);
    expect(pi(t).exchange_rate).toBe(RMB_RATE);
    expect(lot(t).unit_cost_sen).toBe(EXPECTED_LOT_SEN);

    const res = await cancel(app);
    expect(res.status).toBe(200);
    const body = await res.json() as Row;

    // The AP settlement is unwound...
    expect(t.payment_vouchers[0]!.status).toBe('CANCELLED');
    expect(pi(t).paid_sen).toBe(0);
    // ...but the rate stays and the lot is NOT pushed back to the 1:1 mis-cost.
    expect(pi(t).exchange_rate).toBe(RMB_RATE);
    expect(lot(t).unit_cost_sen).toBe(EXPECTED_LOT_SEN);
    // And the choice is stated out loud rather than left for someone to discover.
    expect(body.fxRateRetained).toEqual(['2990-PI-2607-004: rate 0.619838 kept']);
    const retentionNote = rateAudits(t).find((r) => String(r.note ?? '').includes('RETAINED'));
    expect(retentionNote).toBeTruthy();
    expect(retentionNote!.field_changes).toEqual(expect.arrayContaining([
      { field: 'exchangeRateRetained', from: null, to: RMB_RATE },
      { field: 'fxRateRetainedFromPv', from: null, to: '2990-PV-2607-001' },
    ]));
  });

  test('cancelling an all-MYR voucher says nothing about rates', async () => {
    const t = world({ pvCurrency: 'MYR', pvRate: 1, piCurrency: 'MYR', piRate: 1 });
    const app = harness(t);
    await post(app);
    const res = await cancel(app);
    const body = await res.json() as Row;
    expect(body.fxRateRetained).toBeUndefined();
    expect(pi(t).paid_sen).toBe(0);
  });
});
