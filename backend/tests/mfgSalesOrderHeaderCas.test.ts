import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { patchMfgSalesOrderHeaderHandler } from '../src/scm/routes/mfg-sales-orders';

type Row = Record<string, unknown>;

class FakeQuery {
  private predicates: Array<(row: Row) => boolean> = [];
  private operation: 'select' | 'update' | 'insert' = 'select';
  private patch: Row = {};

  constructor(
    private readonly rows: Row[],
    private readonly beforeUpdate?: () => void,
  ) {}

  select() { return this; }
  update(patch: Row) { this.operation = 'update'; this.patch = patch; return this; }
  insert(row: Row) { this.operation = 'insert'; this.patch = row; return this; }
  eq(column: string, value: unknown) {
    this.predicates.push((row) => String(row[column]) === String(value));
    return this;
  }
  neq(column: string, value: unknown) {
    this.predicates.push((row) => String(row[column]) !== String(value));
    return this;
  }
  or() { return this; }
  is(column: string, value: unknown) {
    this.predicates.push((row) => row[column] === value);
    return this;
  }

  private run(): Row[] {
    if (this.operation === 'insert') {
      const row = { ...this.patch };
      this.rows.push(row);
      return [row];
    }
    if (this.operation === 'update') this.beforeUpdate?.();
    const matched = this.rows.filter((row) => this.predicates.every((predicate) => predicate(row)));
    if (this.operation === 'update') {
      for (const row of matched) Object.assign(row, this.patch);
    }
    return matched;
  }

  maybeSingle() {
    const rows = this.run();
    return Promise.resolve({ data: rows[0] ?? null, error: null });
  }

  then(resolve: (value: { data: Row[]; error: null }) => unknown, reject?: (reason: unknown) => unknown) {
    return Promise.resolve({ data: this.run(), error: null }).then(resolve, reject);
  }
}

function harness(options: { raceBeforeCas?: boolean; followerApplied?: boolean } = {}) {
  const tables: Record<string, Row[]> = {
    mfg_sales_orders: [{
      doc_no: 'SO-CAS-1',
      company_id: 1,
      version: 1,
      status: 'DRAFT',
      note: 'original',
      debtor_name: 'Original Customer',
      phone: '+60123456789',
      address2: null,
      processing_date: null,
      proceeded_at: null,
      edit_lease_token: null,
      edit_lease_expires_at: null,
    }],
    mfg_so_audit_log: [],
    mfg_sales_order_items: [],
    venues: [{ id: '5cafa0a2-f979-44da-9a76-5030158ebeb7', name: 'PJ SHOWROOM' }],
  };
  let raceInjected = false;
  let rpcCalls = 0;
  let lastCasArgs: Record<string, unknown> | null = null;
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, {
      from: (table: string) => new FakeQuery(
        (tables[table] ||= []),
        table === 'mfg_sales_orders' && options.raceBeforeCas
          ? () => {
              if (raceInjected) return;
              raceInjected = true;
              Object.assign(tables.mfg_sales_orders[0]!, { note: 'racing writer', version: 2 });
            }
          : undefined,
      ),
      rpc: async (name: string, args?: Record<string, unknown>) => {
        rpcCalls += 1;
        if (name === 'apply_so_header_cas') {
          lastCasArgs = args ?? null;
          if (options.raceBeforeCas && !raceInjected) {
            raceInjected = true;
            Object.assign(tables.mfg_sales_orders[0]!, { note: 'racing writer', version: 2 });
          }
          const row = tables.mfg_sales_orders[0]!;
          const expected = Number(args?.p_expected_version);
          if (Number(row.version) !== expected) {
            return { data: [{ applied: false, current_version: row.version, conflict_reason: 'version' }], error: null };
          }
          if (options.followerApplied === false) {
            return { data: [{ applied: false, current_version: row.version, conflict_reason: 'follower' }], error: null };
          }
          Object.assign(row, args?.p_patch as Row);
          return {
            data: [{
              applied: true,
              current_version: row.version,
              resolved_customer_id: 'customer-2',
            }],
            error: null,
          };
        }
        return { data: false, error: null };
      },
    } as never);
    /* The header PATCH is a STRICT company write now, like the sibling status
       handler: an unresolved company is REFUSED rather than defaulted. mig 0164
       resolves a NULL p_company_id with COALESCE(p_company_id, (SELECT id FROM
       public.companies WHERE code='HOUZS')), so "unresolved" silently meant
       "Houzs" on the customer upsert. The fixture carries the company its own
       row already belongs to (company_id: 1 above). */
    c.set('companyId' as never, 1 as never);
    c.set('user' as never, { id: 'actor-1', user_metadata: { name: 'Test User' } } as never);
    c.set('houzsUser' as never, {
      id: 1,
      position_name: 'Super Admin',
      permissions_set: new Set(['*']),
    } as never);
    await next();
  });
  app.patch('/mfg-sales-orders/:docNo', patchMfgSalesOrderHeaderHandler as never);
  return {
    app,
    row: tables.mfg_sales_orders[0]!,
    getRpcCalls: () => rpcCalls,
    getCasArgs: () => lastCasArgs,
  };
}

const patchHeader = (app: Hono, body: Row) => app.request('/mfg-sales-orders/SO-CAS-1', {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('mandatory Sales Order header compare-and-swap', () => {
  test('two sessions loaded at v1: first save reaches v2, stale second save is a stable 409 and cannot overwrite', async () => {
    const { app, row } = harness();

    const first = await patchHeader(app, { note: 'first writer', version: 1 });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, version: 2 });
    expect(row).toMatchObject({ note: 'first writer', version: 2 });

    const stale = await patchHeader(app, { note: 'stale second writer', version: 1 });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: 'so_version_conflict',
      currentVersion: 2,
    });
    expect(row).toMatchObject({ note: 'first writer', version: 2 });

    const sameStaleRetry = await patchHeader(app, { note: 'stale second writer', version: 1 });
    expect(sameStaleRetry.status).toBe(409);
    expect(await sameStaleRetry.json()).toMatchObject({ currentVersion: 2 });
    expect(row).toMatchObject({ note: 'first writer', version: 2 });
  });

  test('a real header mutation without a loaded version returns 428 and writes nothing', async () => {
    const { app, row } = harness();

    const response = await patchHeader(app, { note: 'must not land' });
    expect(response.status).toBe(428);
    expect(await response.json()).toMatchObject({
      error: 'so_version_required',
      currentVersion: 1,
    });
    expect(row).toMatchObject({ note: 'original', version: 1 });
  });

  test('a writer landing after the pre-read is still stopped by the atomic version predicate', async () => {
    const { app, row } = harness({ raceBeforeCas: true });

    const response = await patchHeader(app, { note: 'must lose the race', version: 1 });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: 'so_version_conflict',
      currentVersion: 2,
    });
    expect(row).toMatchObject({ note: 'racing writer', version: 2 });
  });

  test('an empty no-op does not falsely demand a version or bump the row', async () => {
    const { app, row } = harness();

    const response = await patchHeader(app, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, changed: 0 });
    expect(row).toMatchObject({ note: 'original', version: 1 });
  });

  test('recognised fields equal after normalisation are no-ops without a version or follower writes', async () => {
    const { app, row, getRpcCalls } = harness();

    const response = await patchHeader(app, { note: 'original', address2: '', recustomer: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, changed: 0 });
    expect(row).toMatchObject({ note: 'original', address2: null, version: 1 });
    expect(getRpcCalls()).toBe(0);
  });

  test('a CAS race cannot leave a pre-CAS recustomer RPC side effect', async () => {
    const { app, row, getRpcCalls } = harness({ raceBeforeCas: true });

    const response = await patchHeader(app, {
      debtorName: 'New Customer',
      phone: '+60129999999',
      recustomer: true,
      version: 1,
    });
    expect(response.status).toBe(409);
    expect(row).toMatchObject({ debtor_name: 'Original Customer', version: 2 });
    expect(getRpcCalls()).toBeGreaterThan(0);
  });

  test('line-write reservation is itself CAS-protected and does not mutate header fields', async () => {
    const { app, row } = harness();
    const leaseToken = 'lease-token-session-one';

    const response = await patchHeader(app, { reserveLineWrites: true, lineWriteLeaseToken: leaseToken, version: 1 });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, reserved: true, version: 2, leaseToken });
    expect(row).toMatchObject({ note: 'original', version: 2, edit_lease_token: leaseToken });

    const replay = await patchHeader(app, { reserveLineWrites: true, lineWriteLeaseToken: leaseToken, version: 1 });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ reserved: true, version: 2 });

    const stale = await patchHeader(app, { reserveLineWrites: true, lineWriteLeaseToken: 'lease-token-session-two', version: 1 });
    expect(stale.status).toBe(409);
    expect(row).toMatchObject({ note: 'original', version: 2 });
  });

  test('line-only completion releases the matching lease without another version bump', async () => {
    const { app, row } = harness();
    const leaseToken = 'lease-token-line-only';
    await patchHeader(app, { reserveLineWrites: true, lineWriteLeaseToken: leaseToken, version: 1 });

    const completed = await patchHeader(app, {
      completeLineWrites: true,
      lineWriteLeaseToken: leaseToken,
      version: 2,
    });
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({ released: true, version: 2 });
    expect(row).toMatchObject({ version: 2, edit_lease_token: null, edit_lease_expires_at: null });
  });

  test('an active lease blocks an unrelated header writer before it can mutate', async () => {
    const { app, row } = harness();
    await patchHeader(app, {
      reserveLineWrites: true,
      lineWriteLeaseToken: 'lease-token-owner-one',
      version: 1,
    });

    const other = await patchHeader(app, { note: 'must not land', version: 2 });
    expect(other.status).toBe(409);
    expect(await other.json()).toMatchObject({ error: 'so_edit_lease_conflict' });
    expect(row).toMatchObject({ note: 'original', version: 2 });
  });

  test('stamp-once filtering is a true no-op before the version gate', async () => {
    const { app, row } = harness();
    row.proceeded_at = '2026-07-20T01:00:00.000Z';

    const response = await patchHeader(app, { proceededAt: '2026-07-20T02:00:00.000Z' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ changed: 0 });
    expect(row).toMatchObject({ proceeded_at: '2026-07-20T01:00:00.000Z', version: 1 });
  });

  test('a follower failure rolls back the header CAS as one transaction', async () => {
    const { app, row } = harness({ followerApplied: false });

    const response = await patchHeader(app, {
      debtorName: 'New Customer',
      phone: '+60129999999',
      recustomer: true,
      version: 1,
    });
    expect(response.status).toBe(409);
    expect(row).toMatchObject({ debtor_name: 'Original Customer', version: 1 });
  });
});

/* Owner 2026-09-01: 「为什么我的 Venue 又不见了？」 — two 2990 orders showing "—"
   where a venue had been. The audit log settled it on 2990-SO-2608-070:

     2026-08-31 07:50:31  UPDATE_DETAILS  venue:   "2990s PJ" -> ""
     2026-08-31 07:50:31  UPDATE_DETAILS  venueId: null       -> "5cafa0a2-…"

   ONE save wrote both — a client that had resolved the id and not the name. The
   create path already resolves the name from the id in that situation; this pins
   the header PATCH doing the same, so no caller can leave the pair half-written.
   Clearing stays possible: send BOTH empty. */
describe('a venue id with no name is not a request to blank the venue', () => {
  const withVenue = () => {
    const h = harness();
    h.row.venue = '2990s PJ';
    h.row.venue_id = null;
    h.row.address1 = '1 Jalan Test';
    h.row.postcode = '47500';
    return h;
  };

  test('an empty venue beside a venue id is resolved from the master, not stored', async () => {
    const { app, row } = withVenue();

    const res = await patchHeader(app, {
      venue: '', venueId: '5cafa0a2-f979-44da-9a76-5030158ebeb7', version: 1,
    });

    expect(res.status).toBe(200);
    expect(row.venue).toBe('PJ SHOWROOM');
    expect(row.venue_id).toBe('5cafa0a2-f979-44da-9a76-5030158ebeb7');
  });

  test('BOTH empty still clears it — "this order has no venue" is an answer', async () => {
    const { app, row } = withVenue();

    const res = await patchHeader(app, { venue: '', venueId: '', version: 1 });

    expect(res.status).toBe(200);
    expect(row.venue).toBe('');
    expect(row.venue_id).toBeNull();
  });
});

/* Owner 2026-08-31, HC-SO-013393: "我要 remove 掉我的 processing date 跟 delivery
   date，不能的吗?" — the edit page refused with the pair message even though
   clearing BOTH is exactly what the pair rule allows.

   The date fields are the one place the desktop edit page sends JSON `null`
   rather than `""` (SalesOrderDetail's payloadFor: `f.processingDate || null`),
   and the handler read "is this key in the patch?" as `typeof x === 'string'` —
   which `null` is not. So a cleared date fell through to "key absent, keep the
   stored value", and the pair rule was judged against dates the save was about
   to delete. Both directions are pinned here because they fail OPPOSITE ways:
   the legal save was refused, and the illegal one was allowed through. */
describe('clearing the date pair from the edit page (null payload)', () => {
  /* A complete header, so the only thing either save can fail on is the date
     pair — the base fixture has no address, which the proceed gate reports as
     its own 422 and would mask the shape under test. */
  const withDates = () => {
    const h = harness();
    h.row.processing_date = '2026-12-01';
    h.row.customer_delivery_date = '2026-12-15';
    h.row.address1 = '1 Jalan Test';
    h.row.postcode = '47500';
    return h;
  };

  test('clearing BOTH dates saves and clears both columns', async () => {
    const { app, row, getCasArgs } = withDates();

    const response = await patchHeader(app, {
      processingDate: null,
      customerDeliveryDate: null,
      version: 1,
    });

    expect(response.status).toBe(200);
    expect(row.processing_date).toBeNull();
    expect(getCasArgs()).toMatchObject({ p_apply_delivery_date: true, p_delivery_date: null });
  });

  test('clearing ONLY the Delivery Date is refused, not silently applied', async () => {
    const { app, row, getCasArgs } = withDates();

    const response = await patchHeader(app, { customerDeliveryDate: null, version: 1 });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'processing_delivery_must_pair' });
    expect(row).toMatchObject({ processing_date: '2026-12-01', version: 1 });
    expect(getCasArgs()).toBeNull();
  });
});
