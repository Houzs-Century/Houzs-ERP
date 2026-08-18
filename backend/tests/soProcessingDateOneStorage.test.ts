import { describe, expect, test } from 'vitest';
import { soProcessingLocked } from '../src/scm/routes/mfg-sales-orders';

/* ONE STORAGE FOR THE PROCESSING DATE — the source pin.
 *
 * Owner, three times (2026-07-31, 2026-08-13, 2026-08-18, the last naming the
 * scope himself): there is ONE Processing Date across frontend, backend and
 * database. `scm.mfg_sales_orders.proceeded_at` was the second storage, and the
 * failure mode it produced is not a crash — it is two consumers of "is this
 * order proceeded" quietly answering differently, which is how every previous
 * Processing-Date bug in this repo started.
 *
 * A behavioural test cannot catch the regression this guards. Re-adding
 * `|| header.proceeded_at` to a lock predicate passes every existing test,
 * reads as defensive in review, and only shows up as an order somebody cannot
 * edit. So this asserts on the SOURCE of the deciding files, the way
 * frontend/src/pages/adminResetLink.test.ts pins the reset-link invariant.
 *
 * WHAT IT DOES NOT CLAIM, and this is the honest half. The column still EXISTS,
 * is still written, and ONE decision still reads it: the stock allocator's
 * `allocGated`. That read cannot move until the owner rules on 16 live
 * company-2 orders that carry a Proceed stamp with no Processing Date — moving
 * it gates all 16 and visibly drops 4 of them out of READY_TO_SHIP. So the
 * allocator is pinned here in its CURRENT state, deliberately, together with
 * the evidence that the divergence is known rather than forgotten. When the
 * follow-up flips it, these assertions fail and must be updated — which is how
 * a deferral stays a deferral instead of becoming the status quo. See
 * "RETIRING THE SECOND STORAGE" in shared/so-processing-date.ts. */

const sources = import.meta.glob(
  [
    '../src/scm/routes/mfg-sales-orders.ts',
    '../src/scm/routes/delivery-planning.ts',
    '../src/scm/lib/so-stock-allocation.ts',
  ],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

const srcOf = (suffix: string): string => {
  const hit = Object.entries(sources).find(([k]) => k.endsWith(suffix));
  if (!hit) throw new Error(`source not loaded: ${suffix} (have ${Object.keys(sources).join(', ')})`);
  return hit[1];
};

/* Comments legitimately discuss the retired column — this whole change is
   documented in them. Strip them so the assertions below are about CODE. */
const codeOnly = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');

describe('the deciding sources were actually loaded', () => {
  test('all three resolved and are non-trivial', () => {
    expect(Object.keys(sources)).toHaveLength(3);
    for (const s of Object.values(sources)) expect(s.length).toBeGreaterThan(2000);
  });
});

describe('no LOCK decision reads a second storage', () => {
  /* soProcessingLocked is THE soft edit lock: line items, customer
     State/Postcode, the schedule columns, and the mirror guard that decides
     whether the amendment door opens. It used to end
     `return Boolean(header.proceeded_at)`. */
  test('soProcessingLocked names only processing_date and status', () => {
    const src = codeOnly(srcOf('mfg-sales-orders.ts'));
    const start = src.indexOf('export function soProcessingLocked(');
    expect(start).toBeGreaterThan(-1);
    /* The next top-level declaration bounds the body — a fixed character
       window would silently swallow (or miss) the function as the file moves. */
    const rest = src.slice(start + 1);
    const end = rest.search(/\n(export )?(async )?function |\nconst SO_PROCEED/);
    const body = rest.slice(0, end === -1 ? rest.length : end);
    expect(body).toContain('processing_date');
    expect(body).not.toContain('proceeded_at');
  });

  test('every soProcessingLocked / soEditLocked call site fetches status, not a stamp', () => {
    const src = codeOnly(srcOf('mfg-sales-orders.ts'));
    /* Each cast at a call site declares the shape the predicate is handed. A
       cast that still names proceeded_at means a caller is still SELECTing it
       to decide a lock with. */
    for (const m of src.matchAll(/soProcessingLocked\(|soEditLocked\(/g)) {
      const window = src.slice(m.index, m.index + 320);
      expect(window).not.toContain('proceeded_at');
    }
  });

  test('the delivery-planning board decides the same way', () => {
    const src = codeOnly(srcOf('delivery-planning.ts'));
    expect(src).toContain("select('processing_date, status')");
    expect(src).not.toContain('proceeded_at');
  });
});

describe('the stock allocator is the ONE remaining reader, and it is pinned', () => {
  /* THE decision the owner was actually complaining about: its comment has
     described the Processing Date rule since 2026-08-10 while the code reads the
     other column. Not flipped here — see the file header. */
  test('there is exactly one gate, and today it still reads the stamp', () => {
    const src = codeOnly(srcOf('so-stock-allocation.ts'));
    const gates = [...src.matchAll(/const allocGated/g)];
    expect(gates).toHaveLength(1);
    const window = src.slice(gates[0]!.index, gates[0]!.index + 200);
    expect(window).toContain('!o.proceeded_at');
    /* FLIPPING THIS IS THE FOLLOW-UP. Replace with SO_PROCESSING_DATE_COLUMN
       here AND in the select above, delete the three write sites counted below,
       and update this test — after the owner has ruled on the 16. */
  });

  test('the gate and the select name the SAME column — no mixing', () => {
    const src = codeOnly(srcOf('so-stock-allocation.ts'));
    /* The failure this forbids is subtler than either column alone: selecting
       the date and gating on the stamp (or the reverse) would read `undefined`
       for every row and gate the ENTIRE book, or none of it. */
    const selects = [...src.matchAll(/\.select\('doc_no, status, created_at[^']*'\)/g)];
    expect(selects).toHaveLength(1);
    expect(selects[0]![0]).toContain('proceeded_at');
  });

  test('the divergence is documented with its measured blast radius', () => {
    /* Comments included on purpose here — the assertion IS about the comment.
       A silent flip would leave these numbers describing the wrong world. */
    const raw = srcOf('so-stock-allocation.ts');
    expect(raw).toContain('THE SENTENCE ABOVE AND THE LINE BELOW DISAGREE');
    expect(raw).toContain('probe-proceed-split');
    expect(raw).toContain('12 CONFIRMED, 4 READY_TO_SHIP');
    expect(raw).toContain('RETIRING THE SECOND STORAGE');
  });
});

describe('the retired column survives at exactly the sites the plan names', () => {
  /* This is the deferral, made mechanical. If someone deletes one of these, or
     adds a fourth, the count moves and this fails — which is how the follow-up
     change gets forced to update the plan instead of drifting away from it. */
  test('mfg-sales-orders.ts names it exactly 15 times and no more', () => {
    const src = codeOnly(srcOf('mfg-sales-orders.ts'));
    const hits = [...src.matchAll(/proceeded_at|proceededAt/g)].length;
    /* 1  create INSERT key
       2  /status IN_PRODUCTION read (select)
       3  ...its row type
       4  ...the first-proceed test
       5  ...the stamp write
       6  the PATCH map entry (camel)
       7  the PATCH map entry (snake)
       8  stamp-once filter: incoming !== undefined
       9  stamp-once filter: incoming !== null
      10  stamp-once filter: stored value
      11  stamp-once filter: delete updates
      12  stamp-once filter: delete body (camel)
      13  the header-PATCH proceed gate: !== undefined
      14  ...!== null
      15  the Remove-Processing-Date clear (this commit's leak fix) */
    expect(hits).toBe(15);
  });
});

describe('the lock behaviour itself, over the populations measured on prod', () => {
  /* probe-proceed-split, prod, 2026-08-18, run 32093080121. Every combination
     below is a real population, not a hypothetical — so a future edit to the
     predicate cannot silently change who may edit an order. `yesterday` is
     computed in Malaysia time exactly as the predicate does. */
  const ymdMY = (offsetDays: number): string =>
    new Date(Date.now() + 8 * 3600 * 1000 + offsetDays * 86400 * 1000)
      .toISOString().slice(0, 10);
  const past = ymdMY(-1);
  const today = ymdMY(0);
  const future = ymdMY(+1);

  /* company 1: 519 both-set live (440 CONFIRMED, 79 READY_TO_SHIP);
     company 2: 21 both-set live (14 CONFIRMED, 7 READY_TO_SHIP). */
  test.each(['CONFIRMED', 'READY_TO_SHIP'])(
    'a %s order past its processing day is LOCKED', (status) => {
      expect(soProcessingLocked({ processing_date: past, status })).toBe(true);
    },
  );

  /* company 2's MIRROR class: 5 live orders, ALL CONFIRMED, carrying a date and
     no stamp. Before this commit the lock already answered on the date, so
     these must not move. */
  test('the date alone decides — a stamp was never needed to lock', () => {
    expect(soProcessingLocked({ processing_date: past, status: 'CONFIRMED' })).toBe(true);
  });

  /* company 2's DANGEROUS class: 16 live orders (12 CONFIRMED, 4
     READY_TO_SHIP) with a stamp and NO date. The lock must leave them OPEN —
     no date, nothing to have elapsed. This is the assertion that would have
     caught "lock when either column says proceeded". */
  test.each(['CONFIRMED', 'READY_TO_SHIP'])(
    'a %s order with NO processing date is NOT locked, whatever else it carries',
    (status) => {
      expect(soProcessingLocked({ processing_date: null, status })).toBe(false);
      expect(soProcessingLocked({ status })).toBe(false);
    },
  );

  /* company 1: 2205 live orders in the neither class (2200 CONFIRMED,
     5 READY_TO_SHIP); company 2: 35, all CONFIRMED. */
  test('the neither class stays editable', () => {
    expect(soProcessingLocked({ processing_date: null, status: 'CONFIRMED' })).toBe(false);
  });

  test('the processing day itself is still open; only after it is locked', () => {
    expect(soProcessingLocked({ processing_date: today, status: 'CONFIRMED' })).toBe(false);
    expect(soProcessingLocked({ processing_date: future, status: 'CONFIRMED' })).toBe(false);
  });

  test('DRAFT and CANCELLED stay editable past the date', () => {
    expect(soProcessingLocked({ processing_date: past, status: 'DRAFT' })).toBe(false);
    expect(soProcessingLocked({ processing_date: past, status: 'CANCELLED' })).toBe(false);
    expect(soProcessingLocked({ processing_date: past, status: 'draft' })).toBe(false);
  });

  /* THE REPLACEMENT FOR THE DELETED MARKER. A header with no status can no
     longer be handed to this predicate without a compile error; if one arrives
     at runtime it must answer NOT LOCKED — the side the `proceeded_at` fallback
     was chosen to protect ("so we never over-lock a status-blind header"). */
  test('an empty status answers NOT locked, never locked', () => {
    expect(soProcessingLocked({ processing_date: past, status: '' })).toBe(false);
    expect(soProcessingLocked({ processing_date: past, status: null })).toBe(false);
  });

  test('an unparseable date is not a lock', () => {
    expect(soProcessingLocked({ processing_date: 'not-a-date', status: 'CONFIRMED' })).toBe(false);
    expect(soProcessingLocked(null)).toBe(false);
    expect(soProcessingLocked(undefined)).toBe(false);
  });

  test('a timestamp in the column reads as its calendar day', () => {
    expect(soProcessingLocked({ processing_date: `${past}T23:59:59Z`, status: 'CONFIRMED' })).toBe(true);
  });
});
