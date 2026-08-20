import { beforeEach, describe, expect, test, vi } from 'vitest';
import { soMirror } from '../src/scm/routes/so-mirror';

/* IMPORT-ONCE, driven through the real route.
 *
 * The 2990 receiver used to replay 2990's copy of an order over Houzs on every
 * delivery, and it replaced the item set with a DELETE-then-INSERT — so an SO
 * the owner had edited in Houzs came back as 2990 last knew it, and every
 * Delivery Order line pointing at those SO lines was blanked by the FK's ON
 * DELETE SET NULL. Since the 2026-07-21 cutover Houzs is the writer of these
 * orders, so the first delivery of a doc_no imports it and every later one is a
 * no-op.
 *
 * These assertions are about STATEMENTS, not about a return shape: the whole
 * defect was writes happening at all. The fake records every statement the
 * route issues, and the skip cases assert that NOTHING touched the document
 * (see orderWrites — the mig-0311 skip ledger is a write, and it belongs on
 * exactly those paths). A test that only read the JSON body would pass on a
 * route that answered "skipped" and wrote anyway.
 */

const SECRET = 'test-sync-secret';

const COLUMNS: Record<string, Array<{ col: string; dtype: string }>> = {
  mfg_sales_orders: [
    { col: 'doc_no', dtype: 'text' },
    { col: 'company_id', dtype: 'bigint' },
    { col: 'status', dtype: 'text' },
    { col: 'customer_name', dtype: 'text' },
    { col: 'venue_id', dtype: 'uuid' },
  ],
  mfg_sales_order_items: [
    { col: 'id', dtype: 'uuid' },
    { col: 'doc_no', dtype: 'text' },
    { col: 'company_id', dtype: 'bigint' },
    { col: 'item_code', dtype: 'text' },
    { col: 'qty', dtype: 'numeric' },
  ],
  mfg_sales_order_payments: [
    { col: 'id', dtype: 'uuid' },
    { col: 'so_doc_no', dtype: 'text' },
    { col: 'company_id', dtype: 'bigint' },
    { col: 'amount_sen', dtype: 'bigint' },
  ],
};

type Stmt = { sql: string; args: unknown[] };

/* Writes that touch the ORDER. The skip ledger (mig 0311) is a write too, and
   it is supposed to happen on exactly the paths that must not touch the order —
   so "nothing was written" has to mean "nothing was written to the document",
   or the ledger would mask the assertion that matters. */
const orderWrites = (writes: Stmt[]) => writes.filter((w) => !/so_mirror_skips/.test(w.sql));

/** A D1-shaped fake over a set of doc_nos company 2 already holds. `failOn`
 *  makes one statement throw, which is how the half-written first import is
 *  reproduced. */
function fakeDatabase(held: Set<string>, failOn?: RegExp) {
  const writes: Stmt[] = [];
  const reads: Stmt[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          const stmt: Stmt = { sql, args };
          const isWrite = /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql);
          const run = async () => {
            if (failOn?.test(sql)) throw new Error('simulated failure');
            (isWrite ? writes : reads).push(stmt);
            if (/DELETE FROM scm\."mfg_sales_orders"/.test(sql)) held.delete(String(args[1]));
            if (/INSERT INTO scm\."mfg_sales_orders"/.test(sql)) {
              const cols = (/\(([^)]*)\)\s*\n?\s*VALUES/.exec(sql)?.[1] ?? '')
                .split(',').map((c) => c.trim().replace(/"/g, ''));
              const at = cols.indexOf('doc_no');
              if (at >= 0) held.add(String(args[at]));
            }
            return { success: true };
          };
          return {
            run,
            first: async <T>() => {
              if (failOn?.test(sql)) throw new Error('simulated failure');
              reads.push(stmt);
              if (/FROM scm\."mfg_sales_orders" WHERE company_id=\? AND doc_no=\?/.test(sql)) {
                return (held.has(String(args[1])) ? ({ hit: 1 } as unknown as T) : null);
              }
              return null;
            },
            all: async () => {
              if (failOn?.test(sql)) throw new Error('simulated failure');
              reads.push(stmt);
              if (/information_schema\.columns/.test(sql)) {
                return { results: COLUMNS[String(args[0])] ?? [] };
              }
              return { results: [] };
            },
          };
        },
      };
    },
  };
  return { db, writes, reads };
}

function deliver(
  db: unknown,
  body: Record<string, unknown>,
  opts: { secret?: string } = {},
) {
  return soMirror.request(
    '/',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sync-secret': opts.secret ?? SECRET },
      body: JSON.stringify(body),
    },
    { DB: db, SYNC_SECRET: SECRET },
  );
}

const NEW_ORDER = {
  docNo: 'SO-2608-099',
  header: { doc_no: 'SO-2608-099', status: 'CONFIRMED', customer_name: 'Tan' },
  items: [{ id: 'i-1', doc_no: 'SO-2608-099', item_code: 'BARON-(K)', qty: 1 }],
  payments: [{ id: 'p-1', so_doc_no: 'SO-2608-099', amount_sen: 5000 }],
};

describe('so-mirror is import-once', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  test('a doc_no company 2 does NOT hold is imported, header + items + payments', async () => {
    const { db, writes } = fakeDatabase(new Set());
    const res = await deliver(db, NEW_ORDER);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, docNo: '2990-SO-2608-099', action: 'imported' });
    expect(writes.some((w) => /INSERT INTO scm\."mfg_sales_orders"/.test(w.sql))).toBe(true);
    expect(writes.some((w) => /INSERT INTO scm\."mfg_sales_order_items"/.test(w.sql))).toBe(true);
    expect(writes.some((w) => /INSERT INTO scm\."mfg_sales_order_payments"/.test(w.sql))).toBe(true);
  });

  test('a doc_no company 2 ALREADY holds is not touched — no statement writes anything', async () => {
    const { db, writes } = fakeDatabase(new Set(['2990-SO-2608-099']));
    const res = await deliver(db, NEW_ORDER);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true, docNo: '2990-SO-2608-099', action: 'skipped_existing', skipped: true,
    });
    expect(orderWrites(writes)).toEqual([]);
  });

  test('deleted:true on an order Houzs already holds is REFUSED, not applied', async () => {
    const held = new Set(['2990-SO-2608-099']);
    const { db, writes } = fakeDatabase(held);
    const res = await deliver(db, { docNo: 'SO-2608-099', deleted: true });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true, docNo: '2990-SO-2608-099', action: 'refused_delete', refused: true,
    });
    expect(orderWrites(writes)).toEqual([]);
    expect(held.has('2990-SO-2608-099')).toBe(true);
  });

  test('deleted:true for a doc we never held still acknowledges, exactly as before', async () => {
    const { db, writes } = fakeDatabase(new Set());
    const res = await deliver(db, { docNo: 'SO-2608-099', deleted: true });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, action: 'deleted' });
    expect(writes.some((w) => /DELETE FROM scm\."mfg_sales_orders"/.test(w.sql))).toBe(true);
  });

  /* The regression the fix itself could introduce. A first import that dies
     after the header would leave a header the retry reads as "already
     imported" — an order with no lines, which is the very symptom this change
     exists to stop. */
  test('a first import that fails after the header removes it, so the retry redoes the document', async () => {
    const held = new Set<string>();
    const { db, writes } = fakeDatabase(held, /INSERT INTO scm\."mfg_sales_order_items"/);
    const res = await deliver(db, NEW_ORDER);

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'mirror_failed' });
    expect(writes.some((w) => /DELETE FROM scm\."mfg_sales_orders"/.test(w.sql))).toBe(true);
  });

  test('an unreadable database refuses rather than importing over a live order', async () => {
    const { db, writes } = fakeDatabase(new Set(['2990-SO-2608-099']), /FROM scm\."mfg_sales_orders" WHERE company_id/);
    const res = await deliver(db, NEW_ORDER);

    expect(res.status).toBe(500);
    expect(writes).toEqual([]);
  });

  /* The durable half (mig 0311). Without a row here, "the mirror declined this
     delivery" survives only as a console line nobody was tailing — and with
     2990's outbox idle, a surviving edit proves nothing on its own. */
  test('a skipped re-delivery is RECORDED, counting up on the same doc', async () => {
    const { db, writes } = fakeDatabase(new Set(['2990-SO-2608-099']));
    await deliver(db, NEW_ORDER);

    const ledger = writes.filter((w) => /scm\."so_mirror_skips"/.test(w.sql));
    expect(ledger).toHaveLength(1);
    expect(ledger[0].args).toEqual([2, '2990-SO-2608-099', 'skipped_existing']);
    // hits climbs on the existing row rather than appending one per delivery —
    // the drainer retries every 10s, so append-per-event is unbounded.
    expect(ledger[0].sql).toMatch(/ON CONFLICT \(company_id, doc_no, action\)/);
    expect(ledger[0].sql).toMatch(/hits = scm\."so_mirror_skips"\.hits \+ 1/);
  });

  test('a refused delete is recorded under its own action', async () => {
    const { db, writes } = fakeDatabase(new Set(['2990-SO-2608-099']));
    await deliver(db, { docNo: 'SO-2608-099', deleted: true });

    const ledger = writes.filter((w) => /scm\."so_mirror_skips"/.test(w.sql));
    expect(ledger).toHaveLength(1);
    expect(ledger[0].args).toEqual([2, '2990-SO-2608-099', 'refused_delete']);
  });

  /* An audit must never break the operation it watches. Turning a correct
     refusal into a 500 would put the outbox row back to PENDING and wedge the
     queue behind it — the exact failure the 200 exists to avoid. */
  test('a ledger write that fails does NOT turn the refusal into a 500', async () => {
    const { db } = fakeDatabase(new Set(['2990-SO-2608-099']), /so_mirror_skips/);
    const res = await deliver(db, NEW_ORDER);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ action: 'skipped_existing', skipped: true });
  });

  test('an IMPORT writes no ledger row — the order itself is the evidence', async () => {
    const { db, writes } = fakeDatabase(new Set());
    await deliver(db, NEW_ORDER);

    expect(writes.filter((w) => /so_mirror_skips/.test(w.sql))).toEqual([]);
  });

  test('the shared-secret wall is untouched', async () => {
    const { db, writes, reads } = fakeDatabase(new Set());
    const res = await deliver(db, NEW_ORDER, { secret: 'wrong' });

    expect(res.status).toBe(401);
    expect(writes).toEqual([]);
    expect(reads).toEqual([]);
  });
});
