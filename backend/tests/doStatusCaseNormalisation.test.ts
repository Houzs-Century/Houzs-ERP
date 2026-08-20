// The DO status PATCH must accept the status in ANY case, because its callers
// have never agreed on one.
//
// Owner, 2026-08-04, trying to cancel 2990-DO-2607-005 — the remediation for the
// duplicate-delivery incident — and getting back:
//
//   Status update failed
//   "cancelled" is not a valid Delivery Order status.
//
// Cancel DO and Mark signed on the V2 detail page, and Mark delivered on the V2
// list, all posted LOWERCASE. Reopen posted UPPERCASE. The mobile driver flow
// posted UPPERCASE. So three desktop actions had been dead since those pages
// shipped, while the same endpoint worked fine from a phone.
//
// The Sales Order sibling handler had always normalised
// (`String(body.status).trim().toUpperCase()`, mfg-sales-orders.ts) — which is
// why Cancel SO works and Cancel DO did not. The two handlers simply disagreed,
// and only one of them was right.
//
// These tests pin the CONTRACT, not the current call sites: a call site can be
// rewritten tomorrow, and fixing the three of them without fixing the handler
// would leave the same trap for the fourth.
//
// Harness mirrors companyScopeHardening.test.ts — the exported handler mounted
// on a bare Hono app with a fake PostgREST builder, because the supabaseAuth
// bridge cannot run here.
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { patchDeliveryOrderStatusHandler } from '../src/scm/routes/delivery-orders-mfg';
import { DO_STATUSES } from '../src/scm/shared/do-shipped-states';

const CO = 1;
type Row = Record<string, any>;

class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'update' | 'insert' | 'delete' = 'select';
  private patch: Row = {};
  private inserted: Row[] = [];
  constructor(private rows: Row[]) {}
  select() { return this; }
  insert(v: Row | Row[]) { this.op = 'insert'; this.inserted = Array.isArray(v) ? v : [v]; return this; }
  update(v: Row) { this.op = 'update'; this.patch = v; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => r[col] === val); return this; }
  neq(col: string, val: unknown) { this.preds.push((r) => r[col] !== val); return this; }
  in(col: string, vals: unknown[]) { this.preds.push((r) => vals.includes(r[col])); return this; }
  order() { return this; } limit() { return this; } range() { return this; }
  gt() { return this; } gte() { return this; } lt() { return this; } lte() { return this; }
  not() { return this; } like() { return this; } is() { return this; } or() { return this; }
  private run(): Row[] {
    if (this.op === 'insert') { this.rows.push(...this.inserted); return this.inserted; }
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

function harness(tables: Record<string, Row[]>) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, {
      from: (t: string) => new FakeQuery((tables[t] ||= [])),
      rpc: async () => ({ data: true, error: null }),
    } as never);
    c.set('companyId' as never, CO as never);
    c.set('user' as never, { id: 'u1' } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as never);
    await next();
  });
  app.patch('/delivery-orders/:id/status', patchDeliveryOrderStatusHandler as never);
  return app;
}

const patchStatus = (app: Hono, id: string, status: unknown) =>
  app.request(`/delivery-orders/${id}/status`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status }),
  });

/** A shipped DO, the state 2990-DO-2607-005 was in when the owner tried to
 *  cancel it. */
const shippedDo = (): Row[] => [
  { id: 'do-1', do_number: '2990-DO-2607-005', company_id: CO, status: 'DISPATCHED', warehouse_id: 'w1' },
];

/** The 400 the owner actually saw. Anything else means the status was accepted
 *  and the request went on to the state guards, which is what we want. */
async function rejectedAsInvalidStatus(res: Response): Promise<boolean> {
  if (res.status !== 400) return false;
  const body = await res.json().catch(() => ({})) as { error?: string };
  return body.error === 'invalid_status';
}

describe('DO status PATCH — case normalisation', () => {
  test('lowercase "cancelled" is NOT rejected as an invalid status', async () => {
    // The exact payload the Cancel DO button sent, and the exact failure.
    const res = await patchStatus(harness({ delivery_orders: shippedDo() }), 'do-1', 'cancelled');
    expect(await rejectedAsInvalidStatus(res)).toBe(false);
  });

  test('lowercase "delivered" is NOT rejected — Mark signed used it too', async () => {
    const res = await patchStatus(harness({ delivery_orders: shippedDo() }), 'do-1', 'delivered');
    expect(await rejectedAsInvalidStatus(res)).toBe(false);
  });

  test('every canonical status is accepted in lower, upper and mixed case', async () => {
    /* Pinning the whole set, not just the two that broke: the next call site to
       be written will not necessarily pick one of those two.

       IMPORTED, not re-typed. This line used to be a hand copy that carried
       'COMPLETED' — a FOURTH mirror of a value scm.do_status does not have (see
       shared/do-shipped-states.ts for how prod refuted it). A test that re-types
       the vocabulary it is pinning cannot catch the vocabulary being wrong; it
       just agrees with whichever copy it was born from. Reading the declaration
       means this test now fails if the handler and the declaration ever part. */
    for (const s of DO_STATUSES) {
      for (const variant of [s, s.toLowerCase(), s[0] + s.slice(1).toLowerCase()]) {
        const res = await patchStatus(harness({ delivery_orders: shippedDo() }), 'do-1', variant);
        expect(await rejectedAsInvalidStatus(res), `${variant} should be accepted`).toBe(false);
      }
    }
  });

  test('surrounding whitespace is trimmed', async () => {
    const res = await patchStatus(harness({ delivery_orders: shippedDo() }), 'do-1', '  cancelled  ');
    expect(await rejectedAsInvalidStatus(res)).toBe(false);
  });

  test('a genuinely unknown status is STILL rejected — this is what audit gap #4 guards', async () => {
    // Normalising case must not become "accept anything". A typo that is not a
    // real status has to keep failing, or the guard is gone rather than fixed.
    /* 'COMPLETED' is in this list as of 2026-08-18, and it is the interesting
       one. It was in DO_STATUSES, so this guard PASSED it — and the UPDATE then
       hit Postgres, which rejected the label and answered 500. A whitelist that
       admits a value the column cannot hold is not a whitelist; it just moves
       the refusal somewhere it reads as a server fault. */
    for (const bogus of ['shipped', 'CANCELED', 'done', 'CANCELLED_BY_MISTAKE', 'COMPLETED', 'completed']) {
      const res = await patchStatus(harness({ delivery_orders: shippedDo() }), 'do-1', bogus);
      expect(await rejectedAsInvalidStatus(res), `${bogus} should be refused`).toBe(true);
    }
  });

  test('the refusal message echoes what the caller actually sent', async () => {
    // The owner had to read this message to diagnose his own blocked cancel.
    // Echoing the normalised value would hide the caller's real mistake.
    const res = await patchStatus(harness({ delivery_orders: shippedDo() }), 'do-1', 'canceled');
    const body = await res.json() as { reason?: string };
    expect(body.reason).toContain('"canceled"');
  });

  test('a missing status is still a 400 status_required', async () => {
    const app = harness({ delivery_orders: shippedDo() });
    const res = await app.request('/delivery-orders/do-1/status', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error?: string }).error).toBe('status_required');
  });
});
