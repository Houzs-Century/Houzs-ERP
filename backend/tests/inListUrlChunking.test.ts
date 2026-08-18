/* An `.in()` filter is part of the REQUEST, and nothing was bounding it.
 *
 * `paginateAll` has always guarded the response — the 1000-row page cap. It does
 * nothing at all about the size of the filter that goes OUT, and
 * netDeliveredBySoItem put one uuid per SO LINE into `.in('so_item_id', …)` with
 * no batching. Two different limits; only the first was ever guarded.
 *
 * Observed in production, 2026-08-17/18, through the SAME throw at
 * do-unlinked-coverage.ts:
 *
 *   GET /api/scm/mrp?category=SOFA   Houzs Century (2,726 SOs)
 *       500 `delivered-sum read failed: Bad Request`
 *       …and 200 in ~495ms for the 100-order tenant next door. Same code, same
 *       day, same minute.
 *   GET /api/scm/delivery-planning   BOTH tenants, including the 100-order one
 *       500 `delivered-sum read failed: ` — message EMPTY (wrangler tail).
 *
 * The empty message is the load-bearing detail. A driver error with no body is
 * a request refused BEFORE PostgREST could serialize a JSON error — a gateway
 * rejecting the URI, not a query failing. "Bad Request" is the same cause caught
 * one layer later. Delivery Planning fails first because its doc set is "every
 * SO needing delivery", which reaches ~500 line uuids (~19.5KB of filter) at
 * only ~100 orders — so the DP-shaped input in §2 is not a smaller version of
 * the MRP one, it is the case that breaks EARLIEST and would stay broken behind
 * a test that only exercised MRP's scale.
 *
 * What this file asserts, in the order the reasoning goes:
 *
 *   §0  the sizing arithmetic itself, so the byte budget is CHECKED rather than
 *       asserted in a comment that ages;
 *   §1  no request the chunked path issues exceeds that budget — the property,
 *       independent of any fixture size, and the one that has to hold for
 *       tenants nobody has measured;
 *   §2  the DP-shaped input (100 orders / 500 uuids, the observed break point):
 *       the un-chunked shape is refused, the chunked one is not, and it returns
 *       the SAME numbers as an oracle computed from the fixture;
 *   §3  the MRP-shaped input (300 orders / 1,500 uuids), same three claims;
 *   §4  a duplicated id is still counted once — the ONE way chunking can be
 *       wrong that not chunking cannot.
 *
 * §2–§4 check numbers, not just absence of an error, because this read decides
 * how much of an order counts as already delivered. An under-count does not
 * surface as a failure; it surfaces as MRP telling Procurement to re-buy goods
 * that already shipped.
 */
import { describe, it, expect } from 'vitest';
import { netDeliveredBySoItem, type CoverageSoLine } from '../src/scm/lib/do-unlinked-coverage';
import { chunkSizeForUrl, URL_QUERY_BUDGET } from '../src/scm/lib/paginate-all';
import { makeFakePostgrest, type FakeDb, type Relationship, type Row } from './fakePostgrest';

const RELATIONSHIPS: Relationship[] = [
  { child: 'delivery_order_items', childCol: 'delivery_order_id', parent: 'delivery_orders', parentCol: 'id' },
];

const UUID_LEN = 36;
const SEPARATOR_BYTES = 3; // '%2C'

/* uuid-shaped, because the LENGTH is the whole problem. A short synthetic id
   would let the fixture clear a budget the real ids would blow. */
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const LINES_PER_SO = 5;
const LINE_QTY = 2;
const docNo = (i: number): string => `HOK-SO-2608-${String(i).padStart(4, '0')}`;

/* Per-line delivery shape, keyed off the line's position in its order. Spelled
   out once so the fixture and the oracle cannot drift apart. */
type Shape = { doQty: number; doStatus: string; delivered: number };
const SHAPES: Shape[] = [
  { doQty: 0, doStatus: '',          delivered: 0 }, // nothing shipped
  { doQty: 2, doStatus: 'DELIVERED', delivered: 2 }, // fully shipped
  { doQty: 1, doStatus: 'DELIVERED', delivered: 1 }, // part shipped
  { doQty: 2, doStatus: 'CANCELLED', delivered: 0 }, // a cancelled DO took nothing out
  { doQty: 2, doStatus: 'DRAFT',     delivered: 0 }, // a draft has not shipped
];

type Fixture = { db: FakeDb; soLines: CoverageSoLine[]; soDocNos: string[]; unlinkedOrders: number };

function fixture(orderCount: number, unlinkedOrders: number): Fixture {
  const soLines: CoverageSoLine[] = [];
  const doHeaders: Row[] = [];
  const doItems: Row[] = [];
  let seq = 0;

  for (let i = 0; i < orderCount; i++) {
    for (let j = 0; j < LINES_PER_SO; j++) {
      const soItemId = uuid(seq++);
      // A distinct code per line, so an attributed unlinked unit can only ever
      // land on the one line it was built for.
      soLines.push({ id: soItemId, docNo: docNo(i), itemCode: `ITEM-${i}-${j}`, qty: LINE_QTY });

      const shape = SHAPES[j]!;
      if (shape.doQty === 0) continue;
      const doId = uuid(seq++);
      doHeaders.push({ id: doId, so_doc_no: docNo(i), status: shape.doStatus });
      doItems.push({
        id: uuid(seq++), delivery_order_id: doId, so_item_id: soItemId,
        item_code: `ITEM-${i}-${j}`, qty: shape.doQty,
      });
    }
  }

  /* The second reading this module exists for: a shipment whose so_item_id the
     FK blanked, on a DO whose header still names the order. Its own reads chunk
     on DIFFERENT keys (doc numbers, then DO ids), so a fixture without it would
     leave half the function unexercised. Aimed at line 0 of each order — the one
     SHAPES leaves entirely undelivered — so it can never collide with a link. */
  for (let i = 0; i < unlinkedOrders; i++) {
    const doId = uuid(seq++);
    doHeaders.push({ id: doId, so_doc_no: docNo(i), status: 'DELIVERED' });
    doItems.push({
      id: uuid(seq++), delivery_order_id: doId, so_item_id: null,
      item_code: `ITEM-${i}-0`, qty: LINE_QTY,
    });
  }

  const db = makeFakePostgrest(
    { delivery_orders: doHeaders, delivery_order_items: doItems },
    RELATIONSHIPS,
  );
  return {
    db, soLines, unlinkedOrders,
    soDocNos: Array.from({ length: orderCount }, (_, i) => docNo(i)),
  };
}

/** What the delivered sum MUST be, derived from the fixture's own rules — not
 *  from a second run of the code under test. */
function expectedDelivered(f: Fixture): Map<string, number> {
  const out = new Map<string, number>();
  f.soLines.forEach((line, idx) => {
    const orderIdx = Math.floor(idx / LINES_PER_SO);
    const lineIdx = idx % LINES_PER_SO;
    let qty = SHAPES[lineIdx]!.delivered;
    if (lineIdx === 0 && orderIdx < f.unlinkedOrders) qty += LINE_QTY; // the link-blanked shipment
    if (qty > 0) out.set(line.id, qty);
  });
  return out;
}

type Budgeted = { sb: { from: (table: string) => unknown }; maxFilterBytes: () => number };

/* A PostgREST that refuses an over-long request URI, the way the real gateway
   does — and that RECORDS how long each filter got, so §1 can assert the bound
   directly instead of inferring it from "nothing threw". Sizes the string the
   way supabase-js builds it: `col=in.(v1,v2,…)`, one percent-encoded separator
   per value. */
function withUrlBudget(db: FakeDb, budget: number): Budgeted {
  let widest = 0;
  return {
    maxFilterBytes: () => widest,
    sb: {
      from(table: string) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const inner = db.from(table) as any;
        let bytes = `/rest/v1/${table}?`.length;
        const wrap = (): unknown => new Proxy({}, {
          get(_t, prop: string) {
            if (prop === 'then') {
              if (bytes > widest) widest = bytes;
              if (bytes > budget) {
                /* An EMPTY message, which is what production showed on the
                   delivery-planning path: the URI never reached PostgREST, so
                   there is no JSON error body to parse. */
                return (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => Promise
                  .resolve({ data: null, error: { message: '', code: '' } })
                  .then(ok, err);
              }
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              return (ok: any, err: any) => inner.then(ok, err);
            }
            return (...args: unknown[]) => {
              if (prop === 'in' && Array.isArray(args[1])) {
                bytes += String(args[0]).length + '=in.()'.length;
                for (const v of args[1] as unknown[]) bytes += String(v).length + SEPARATOR_BYTES;
              } else if (prop === 'select') {
                bytes += 'select='.length + String(args[0] ?? '').length;
              } else if (typeof args[0] === 'string') {
                bytes += String(args[0]).length + '=eq.'.length;
              }
              inner[prop](...args);
              return wrap();
            };
          },
        });
        return wrap();
      },
    },
  };
}

/** The literal query netDeliveredBySoItem used to build: every id, one filter. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const unchunkedRead = (sb: { from: (t: string) => unknown }, ids: string[]): Promise<any> =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (sb.from('delivery_order_items') as any)
    .select('id, so_item_id, qty, parent:delivery_orders(status)')
    .in('so_item_id', ids)
    .order('id')
    .range(0, 999);

describe('§0 the batch size is derived from URL bytes, not from a row count', () => {
  it('sizes a uuid list so the serialized filter stays inside the budget', () => {
    const ids = Array.from({ length: 5000 }, (_, i) => uuid(i));
    const size = chunkSizeForUrl(ids);
    const listBytes = size * (UUID_LEN + SEPARATOR_BYTES);
    // Inside the budget with the reserved overhead still to spend…
    expect(listBytes).toBeLessThan(URL_QUERY_BUDGET);
    // …and not needlessly small: one more value would eat into that reserve.
    expect(listBytes + (UUID_LEN + SEPARATOR_BYTES)).toBeGreaterThan(URL_QUERY_BUDGET - 1000);
  });

  it('never widens an existing batch: short values keep the historical 200', () => {
    const codes = Array.from({ length: 5000 }, (_, i) => `ITEM-${i}`);
    expect(chunkSizeForUrl(codes)).toBe(200);
  });

  it('is sized by the WIDEST value, not the average', () => {
    const mixed = [...Array.from({ length: 999 }, () => 'X'), uuid(1)];
    expect(chunkSizeForUrl(mixed)).toBe(chunkSizeForUrl([uuid(1)]));
  });

  it('the observed production break-point is outside the budget, and one batch is inside it', () => {
    /* 100 orders x 5 lines = the ~500 uuids delivery-planning reached in the
       SMALL tenant, and which the gateway refused. */
    expect(500 * (UUID_LEN + SEPARATOR_BYTES)).toBeGreaterThan(URL_QUERY_BUDGET);
    expect(chunkSizeForUrl([uuid(1)]) * (UUID_LEN + SEPARATOR_BYTES)).toBeLessThan(URL_QUERY_BUDGET);
  });
});

describe('§1 no request the chunked read issues can exceed the budget', () => {
  it('holds at a scale far past anything measured, without the budget having to reject anything', async () => {
    const f = fixture(600, 20); // 3,000 SO lines — ~117KB un-chunked
    /* Budget deliberately set ABOVE the real one so nothing is refused: this
       asserts the SIZE of what the code sends, not its recovery from a refusal.
       A test that only checked "no error" would pass on a fake with no limit. */
    const { sb, maxFilterBytes } = withUrlBudget(f.db, Number.MAX_SAFE_INTEGER);
    await netDeliveredBySoItem(sb, f.soDocNos, f.soLines);
    expect(maxFilterBytes()).toBeLessThanOrEqual(URL_QUERY_BUDGET);
  });
});

describe.each([
  // The DP break-point FIRST: it is the smaller input and the one that fails earlier.
  ['§2 DP-shaped — 100 orders, the size that killed the board in BOTH tenants', 100, 10],
  ['§3 MRP-shaped — 300 orders', 300, 10],
])('%s', (_name, orders, unlinked) => {
  it('the un-chunked shape is refused at this size', async () => {
    const f = fixture(orders, unlinked);
    const { sb } = withUrlBudget(f.db, URL_QUERY_BUDGET);
    const res = await unchunkedRead(sb, f.soLines.map((l) => l.id));
    /* If this ever comes back clean the budget has stopped biting and the
       assertions below prove nothing. */
    expect(res.data).toBeNull();
    expect(res.error).not.toBeNull();
  });

  it('the chunked read survives the same budget and returns the same numbers', async () => {
    const f = fixture(orders, unlinked);
    const { sb } = withUrlBudget(f.db, URL_QUERY_BUDGET);

    const { deliveredBySoItem, doLineToSoItem } = await netDeliveredBySoItem(sb, f.soDocNos, f.soLines);

    const expected = expectedDelivered(f);
    expect(deliveredBySoItem.size).toBe(expected.size);
    for (const [soItemId, qty] of expected) expect(deliveredBySoItem.get(soItemId)).toBe(qty);

    /* Every counted shipment stays traceable to its SO line — that map is what
       lets a Delivery Return net back out later. */
    const linkedActive = orders * SHAPES.filter((s) => s.delivered > 0).length;
    expect(doLineToSoItem.size).toBe(linkedActive + unlinked);

    // …and the batching actually happened, rather than the fixture fitting in one go.
    const perBatch = chunkSizeForUrl(f.soLines.map((l) => l.id));
    expect(f.soLines.length).toBeGreaterThan(perBatch);
    expect(f.db.reads.get('delivery_order_items')).toBeGreaterThanOrEqual(
      Math.ceil(f.soLines.length / perBatch),
    );
  });
});

describe('§4 batching must not double-count', () => {
  it('a duplicated SO-line id is still counted once, across batch boundaries', async () => {
    /* The one failure chunking can introduce that a single query cannot:
       PostgREST de-duplicates within one `in.(…)` list, so a repeated id matched
       its row once. Split across two batches it matches once PER BATCH and
       doubles the delivered qty — which reads as "more shipped than was
       ordered" and quietly closes an order that still owes goods. The duplicates
       are far enough apart to land in different batches. */
    const f = fixture(300, 10);
    const perBatch = chunkSizeForUrl(f.soLines.map((l) => l.id));
    const withDupes = [...f.soLines, ...f.soLines.slice(0, perBatch * 2)];
    const { sb } = withUrlBudget(f.db, URL_QUERY_BUDGET);

    const { deliveredBySoItem } = await netDeliveredBySoItem(sb, f.soDocNos, withDupes);

    for (const [soItemId, qty] of expectedDelivered(f)) {
      expect(deliveredBySoItem.get(soItemId)).toBe(qty);
    }
  });
});
