// ----------------------------------------------------------------------------
// do-line-remaining — a read that FAILS must never come back as "nothing is
// consumed yet".
//
// THE DEFECT THIS PINS. supabase-js does not throw: a failed select resolves
// `{ data: null, error }`. Every read in do-line-remaining.ts used to destructure
// `{ data }` alone, so a five-second database blip on the sales_invoice_items
// read arrived as ZERO invoiced rows — identical to a delivery nobody has
// invoiced yet. The formula is remaining = delivered − invoiced − returned, so
// the ceiling came out at the FULL delivered qty and the customer could be
// billed for the whole delivery a second time. Deferred out of #2374 with a
// stated reason ("a refactor with many callers and its own blast radius"); this
// is where it gets closed.
//
// EVERY read is covered, not just the obvious one, because each of the six is
// individually sufficient to zero the ledger:
//   · sales_invoice_items  — IS `invoiced`.
//   · sales_invoices       — the cancelled filter. Lose it and every parent
//                            invoice looks cancelled, which zeroes `invoiced`
//                            just as completely.
//   · delivery_return_items / delivery_returns — the same pair for `returned`.
//   · delivery_orders / delivery_order_items   — lose these and the ledger is
//                            empty, which downstream reads as "this DO line has
//                            no open figure at all".
//
// The assertions are deliberately written as "NOT a ledger that says the line is
// fully available", not merely "ok is false": the second would still pass if a
// future change reintroduced a fail-open value under a different name.
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import { doLineRemaining, doRemainingByItemId, resolveCandidateDoIds } from './do-line-remaining';
import { doPendingItemCodesOf } from './unlinked-line-edit-guard';

type Row = Record<string, unknown>;

const BLIP = { message: 'connection terminated unexpectedly' };

function fakeSb(tables: Record<string, Row[]>, failing: string[] = []) {
  const fail = new Set(failing);
  class Q {
    rows: Row[];
    constructor(rows: Row[], private table: string) { this.rows = [...rows]; }
    select() { return this; }
    eq(col: string, val: unknown) { this.rows = this.rows.filter((r) => r[col] === val); return this; }
    in(col: string, vals: unknown[]) { this.rows = this.rows.filter((r) => vals.includes(r[col])); return this; }
    not(col: string, op: string, val: unknown) {
      if (op === 'in') {
        const list = String(val).replace(/^\(|\)$/g, '').split(',').map((s) => s.replace(/^"|"$/g, ''));
        this.rows = this.rows.filter((r) => !list.includes(String(r[col])));
      }
      return this;
    }
    order() { return this; }
    range(from: number, to: number) { this.rows = this.rows.slice(from, to + 1); return this; }
    then<T>(onFulfilled: (v: { data: Row[] | null; error: { message: string } | null }) => T) {
      return Promise.resolve(
        fail.has(this.table)
          ? { data: null, error: BLIP }
          : { data: this.rows, error: null },
      ).then(onFulfilled);
    }
  }
  return { from: (t: string) => new Q(tables[t] ?? [], t) };
}

const FULLY_CONSUMED = (): Record<string, Row[]> => ({
  delivery_orders: [{ id: 'do-1', company_id: 1, do_number: 'DO-1', status: 'DISPATCHED', debtor_code: 'C1', debtor_name: 'Cust' }],
  delivery_order_items: [{ id: 'dl-1', delivery_order_id: 'do-1', item_code: 'ITEM-1', qty: 10 }],
  sales_invoices: [{ id: 'si-1', status: 'SENT' }],
  sales_invoice_items: [{ do_item_id: 'dl-1', sales_invoice_id: 'si-1', qty: 7 }],
  delivery_returns: [{ id: 'dr-1', status: 'RECEIVED' }],
  delivery_return_items: [{ do_item_id: 'dl-1', delivery_return_id: 'dr-1', qty_returned: 3 }],
});

describe('doLineRemaining fails CLOSED — no read may report an empty ledger', () => {
  test('the ledger is readable when nothing fails: 10 delivered, 7 invoiced, 3 returned, 0 open', async () => {
    const r = await doLineRemaining(fakeSb(FULLY_CONSUMED()), ['do-1'], 'invoiceable');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lines.get('dl-1')?.delivered).toBe(10);
    expect(r.lines.get('dl-1')?.invoiced).toBe(7);
    expect(r.lines.get('dl-1')?.returned).toBe(3);
    expect(r.lines.get('dl-1')?.remaining).toBe(0);
  });

  for (const table of [
    'delivery_orders',
    'delivery_order_items',
    'sales_invoice_items',
    'sales_invoices',
    'delivery_return_items',
    'delivery_returns',
  ]) {
    test(`a failed ${table} read refuses instead of reporting the line as available`, async () => {
      const r = await doLineRemaining(fakeSb(FULLY_CONSUMED(), [table]), ['do-1'], 'invoiceable');
      expect(r.ok).toBe(false);
      if (r.ok) {
        throw new Error(`read failure produced a ledger; dl-1 remaining = ${r.lines.get('dl-1')?.remaining}`);
      }
      expect(r.reason).toContain(table);
    });
  }

  test('the reason names the failure, so the 503 body is not a shrug', async () => {
    const r = await doLineRemaining(fakeSb(FULLY_CONSUMED(), ['sales_invoice_items']), ['do-1'], 'invoiceable');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('connection terminated');
  });
});

describe('doRemainingByItemId fails CLOSED', () => {
  test('0 still means "nothing open" for a line that genuinely no longer exists', async () => {
    const r = await doRemainingByItemId(fakeSb(FULLY_CONSUMED()), ['ghost'], 'invoiceable');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.remaining.get('ghost')).toBe(0);
  });

  test('its own delivery_order_items resolve failing is a refusal, not a cap of 0', async () => {
    const r = await doRemainingByItemId(fakeSb(FULLY_CONSUMED(), ['delivery_order_items']), ['dl-1'], 'invoiceable');
    expect(r.ok).toBe(false);
  });

  test('a failure inside the ledger propagates rather than flattening to 0', async () => {
    const r = await doRemainingByItemId(fakeSb(FULLY_CONSUMED(), ['sales_invoice_items']), ['dl-1'], 'invoiceable');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('sales_invoice_items');
  });
});

describe('resolveCandidateDoIds fails CLOSED — an empty picker is a completion claim', () => {
  test('the sweep lists shipped DOs when it can run', async () => {
    const r = await resolveCandidateDoIds(fakeSb(FULLY_CONSUMED()), undefined, 1, 'invoiceable');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doIds).toEqual(['do-1']);
  });

  test('a failed sweep refuses instead of answering "no deliveries"', async () => {
    const r = await resolveCandidateDoIds(fakeSb(FULLY_CONSUMED(), ['delivery_orders']), undefined, 1, 'invoiceable');
    expect(r.ok).toBe(false);
  });

  test('an EXPLICIT ?doIds= list needs no read and still answers', async () => {
    const r = await resolveCandidateDoIds(fakeSb(FULLY_CONSUMED(), ['delivery_orders']), 'do-1, do-2', 1, 'invoiceable');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doIds).toEqual(['do-1', 'do-2']);
  });
});

describe('doPendingItemCodesOf — the shadow guard cannot be switched off by a blip', () => {
  const PARTLY_INVOICED = (): Record<string, Row[]> => ({
    delivery_orders: [{ id: 'do-1', company_id: 1, do_number: 'DO-1', status: 'DISPATCHED', debtor_code: 'C1', debtor_name: 'Cust' }],
    delivery_order_items: [{ id: 'dl-1', delivery_order_id: 'do-1', item_code: 'ITEM-1', qty: 10 }],
    sales_invoices: [{ id: 'si-1', status: 'SENT' }],
    sales_invoice_items: [{ do_item_id: 'dl-1', sales_invoice_id: 'si-1', qty: 4 }],
    delivery_returns: [],
    delivery_return_items: [],
  });

  test('a line with qty still open IS reported as pending', async () => {
    const r = await doPendingItemCodesOf(fakeSb(PARTLY_INVOICED()), 'do-1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([...r.codes]).toEqual(['ITEM-1']);
  });

  test('a fully-consumed line is NOT pending — the SI chain permits a direct line', async () => {
    const r = await doPendingItemCodesOf(fakeSb(FULLY_CONSUMED()), 'do-1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([...r.codes]).toEqual([]);
  });

  test('an unreadable ledger refuses; it does NOT report an empty pending set', async () => {
    const r = await doPendingItemCodesOf(fakeSb(PARTLY_INVOICED(), ['sales_invoice_items']), 'do-1');
    expect(r.ok).toBe(false);
    if (r.ok) {
      throw new Error(`the guard answered with codes=${[...r.codes].join(',')} instead of refusing`);
    }
    expect(r.reason).toContain('remaining unreadable');
  });
});
