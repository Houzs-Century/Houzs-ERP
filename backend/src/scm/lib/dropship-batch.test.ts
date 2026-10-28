// Unit tests for the drop-ship expected-batch resolver hardening
// (audit 2026-06-26 fixes H1 + H3), driven through a minimal fake PostgREST
// client. Route-level coverage is not possible in this repo's test harness
// (scm rides Supabase Postgres, the harness rebuilds only the D1 side), so
// these pin the pure resolution rules the movement/guard paths rely on.
import { describe, expect, test } from 'vitest';
import { resolveExpectedBatchBySoItem, buildDropshipOffenders } from './dropship-batch';
import { sofaNoCompleteBatchResponse } from './sofa-batch-guard';

type Row = Record<string, unknown>;

/** Minimal chainable, awaitable PostgREST stand-in for the two reads
 *  resolveExpectedBatchBySoItem performs. */
function fakeSb(tables: Record<string, Row[]>) {
  class Q {
    rows: Row[];
    constructor(rows: Row[]) { this.rows = [...rows]; }
    select() { return this; }
    in(col: string, vals: unknown[]) {
      this.rows = this.rows.filter((r) => (vals as unknown[]).includes(r[col]));
      return this;
    }
    not(col: string, op: string, val: unknown) {
      if (op === 'is' && val === null) this.rows = this.rows.filter((r) => r[col] != null);
      return this;
    }
    /* Both reads are batched + paged now (chunkIn), so the stub has to answer
       the same two calls PostgREST does. Without `range` the stub returned every
       row on every page and paginateAll would never terminate; without `order`
       the chain threw on undefined and the resolver's own try/catch turned the
       whole thing into "no PO", which is the LENIENT answer — the tests here
       went green-to-red rather than silently passing, but only because they
       assert a PO is found. */
    order(col: string) {
      this.rows = [...this.rows].sort((a, b) => String(a[col] ?? '').localeCompare(String(b[col] ?? '')));
      return this;
    }
    range(from: number, to: number) {
      this.rows = this.rows.slice(from, to + 1);
      return this;
    }
    then<T>(onFulfilled: (v: { data: Row[]; error: null }) => T, onRejected?: (e: unknown) => T) {
      return Promise.resolve({ data: this.rows, error: null }).then(onFulfilled, onRejected);
    }
  }
  return { from: (table: string) => new Q(tables[table] ?? []) };
}

const poi = (soItemId: string, poId: string, createdAt: string): Row => ({
  so_item_id: soItemId, purchase_order_id: poId, created_at: createdAt,
});
const po = (id: string, poNumber: string, status: string, expectedAt: string | null = null): Row => ({
  id, po_number: poNumber, status, expected_at: expectedAt,
  supplier_delivery_date_2: null, supplier_delivery_date_3: null, supplier_delivery_date_4: null,
});

describe('resolveExpectedBatchBySoItem — H1 dead-PO filter', () => {
  test('a line whose ONLY bound PO is CANCELLED resolves to no PO (drop-ship blocked)', async () => {
    const sb = fakeSb({
      purchase_order_items: [poi('so-1', 'po-1', '2026-06-01')],
      purchase_orders: [po('po-1', 'PO-2606-001', 'CANCELLED')],
    });
    const out = await resolveExpectedBatchBySoItem(sb, ['so-1'], { onMultiPo: 'latest' });
    expect(out.has('so-1')).toBe(false);
  });

  test('a line whose ONLY bound PO is DRAFT resolves to no PO', async () => {
    const sb = fakeSb({
      purchase_order_items: [poi('so-1', 'po-1', '2026-06-01')],
      purchase_orders: [po('po-1', 'PO-2606-001', 'DRAFT')],
    });
    const out = await resolveExpectedBatchBySoItem(sb, ['so-1'], { onMultiPo: 'latest' });
    expect(out.has('so-1')).toBe(false);
  });

  test('a live (SUBMITTED) PO still resolves', async () => {
    const sb = fakeSb({
      purchase_order_items: [poi('so-1', 'po-1', '2026-06-01')],
      purchase_orders: [po('po-1', 'PO-2606-001', 'SUBMITTED', '2026-07-20')],
    });
    const out = await resolveExpectedBatchBySoItem(sb, ['so-1'], { onMultiPo: 'latest' });
    expect(out.get('so-1')).toEqual({ poNumber: 'PO-2606-001', eta: '2026-07-20' });
  });

  test('a dead PO never wins the most-recent pick over an older live one', async () => {
    // Old behaviour picked the most-recently created link REGARDLESS of PO
    // status — a cancelled newer PO would shadow the live older one.
    const sb = fakeSb({
      purchase_order_items: [
        poi('so-1', 'po-live', '2026-06-01'),
        poi('so-1', 'po-dead', '2026-06-15'),
      ],
      purchase_orders: [
        po('po-live', 'PO-2606-001', 'SUBMITTED'),
        po('po-dead', 'PO-2606-002', 'CANCELLED'),
      ],
    });
    const out = await resolveExpectedBatchBySoItem(sb, ['so-1'], { onMultiPo: 'latest' });
    expect(out.get('so-1')?.poNumber).toBe('PO-2606-001');
    expect(out.get('so-1')?.multiPo).toBeUndefined();
  });
});

describe('resolveExpectedBatchBySoItem — H3 multi-live-PO', () => {
  const tables = {
    purchase_order_items: [
      poi('so-1', 'po-a', '2026-06-01'),
      poi('so-1', 'po-b', '2026-06-10'),
    ],
    purchase_orders: [
      po('po-a', 'PO-2606-001', 'SUBMITTED'),
      po('po-b', 'PO-2606-002', 'PARTIALLY_RECEIVED'),
    ],
  };

  test("'latest' (movement paths) stays deterministic — most recent live PO", async () => {
    const out = await resolveExpectedBatchBySoItem(fakeSb(tables), ['so-1'], { onMultiPo: 'latest' });
    expect(out.get('so-1')?.poNumber).toBe('PO-2606-002');
  });

  test("'block' (guard/offer paths) refuses to pick — poNumber null + multiPo", async () => {
    const out = await resolveExpectedBatchBySoItem(fakeSb(tables), ['so-1'], { onMultiPo: 'block' });
    expect(out.get('so-1')).toEqual({ poNumber: null, eta: null, multiPo: true });
  });

  /* The mode is REQUIRED — omitting it used to mean 'latest', so H3 (refuse an
     ambiguous batch) applied only to the callers that opted in. These two tests
     are what fails without the parameter: the modes disagree on the SAME
     fixture, so no default can be right for both, and the directive below stops
     being used the moment the parameter goes back to optional
     (optional-param-noop sweep 2026-08-13). */
  test('the two modes disagree on the same line — so neither can be a silent default', async () => {
    const latest = await resolveExpectedBatchBySoItem(fakeSb(tables), ['so-1'], { onMultiPo: 'latest' });
    const block = await resolveExpectedBatchBySoItem(fakeSb(tables), ['so-1'], { onMultiPo: 'block' });
    expect(latest.get('so-1')?.poNumber).toBe('PO-2606-002');
    expect(block.get('so-1')?.poNumber).toBeNull();
    expect(latest.get('so-1')?.poNumber).not.toBe(block.get('so-1')?.poNumber);
  });

  test('omitting the mode is a COMPILE error (pins the parameter as required)', () => {
    // Never invoked: the point is that the call does not compile. Making the
    // parameter optional again leaves the directive unused, which
    // `npm run typecheck` reports as TS2578 — the alarm the itemCode
    // half-application never got.
    // @ts-expect-error
    const omitted = () => resolveExpectedBatchBySoItem(fakeSb(tables), ['so-1']);
    expect(omitted).toBeInstanceOf(Function);
  });

  test('two links into the SAME PO are not "multi-PO"', async () => {
    const one = {
      purchase_order_items: [
        poi('so-1', 'po-a', '2026-06-01'),
        poi('so-1', 'po-a', '2026-06-10'),
      ],
      purchase_orders: [po('po-a', 'PO-2606-001', 'SUBMITTED')],
    };
    const out = await resolveExpectedBatchBySoItem(fakeSb(one), ['so-1'], { onMultiPo: 'block' });
    expect(out.get('so-1')?.poNumber).toBe('PO-2606-001');
    expect(out.get('so-1')?.multiPo).toBeUndefined();
  });
});

describe('buildDropshipOffenders + 409 payload', () => {
  test('multi-PO offender blocks drop-ship (canDropship false) and the 409 says why', async () => {
    const sb = fakeSb({
      purchase_order_items: [
        poi('so-1', 'po-a', '2026-06-01'),
        poi('so-1', 'po-b', '2026-06-10'),
      ],
      purchase_orders: [
        po('po-a', 'PO-2606-001', 'SUBMITTED'),
        po('po-b', 'PO-2606-002', 'SUBMITTED'),
      ],
    });
    const offenders = [{ itemCode: 'SOFA-X', soItemId: 'so-1' }];
    const dropship = await buildDropshipOffenders(sb, offenders);
    expect(dropship).toEqual([
      { itemCode: 'SOFA-X', soItemId: 'so-1', poNumber: null, eta: null, multiPo: true },
    ]);
    const body = sofaNoCompleteBatchResponse(offenders, dropship);
    expect(body.error).toBe('sofa_no_batch');
    expect((body as { canDropship?: boolean }).canDropship).toBe(false);
    expect(body.message).toContain('more than one open supplier PO');
    expect(body.message).toContain('SOFA-X');
  });

  test('single live PO offender keeps drop-ship offerable', async () => {
    const sb = fakeSb({
      purchase_order_items: [poi('so-1', 'po-a', '2026-06-01')],
      purchase_orders: [po('po-a', 'PO-2606-001', 'SUBMITTED', '2026-07-31')],
    });
    const offenders = [{ itemCode: 'SOFA-X', soItemId: 'so-1' }];
    const dropship = await buildDropshipOffenders(sb, offenders);
    expect(dropship[0]).toMatchObject({ poNumber: 'PO-2606-001', eta: '2026-07-31' });
    const body = sofaNoCompleteBatchResponse(offenders, dropship);
    expect((body as { canDropship?: boolean }).canDropship).toBe(true);
    expect(body.message).not.toContain('more than one open supplier PO');
  });
});
