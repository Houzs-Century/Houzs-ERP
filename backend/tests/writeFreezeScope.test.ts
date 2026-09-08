// The freeze is PER COMPANY (owner 2026-08-10: "是 Houzs company 而已, 2990
// remain") and, since the staged lift, PER MODULE. A regression here either
// stops a business that has no reason to stop, or quietly reopens the writes the
// cutover exists to prevent. Both directions are pinned.
//
// THE FIRST BLOCK IS THE ONE THAT MATTERS TODAY. app_config holds '1'. Every
// assertion under "the value the row holds today" is the CURRENT production
// behaviour, written down before the grammar was extended, so the extension can
// be proved not to have moved it.
import { describe, it, expect } from 'vitest';
import { parseFreezeValue, isFrozen, type FreezeValue } from '../src/scm/lib/write-freeze';

const HOUZS = 1;
const TWENTY_NINE_NINETY = 2;

describe("the value the row holds today ('1') is unchanged", () => {
  const v = parseFreezeValue('1');

  it('freezes company 1 and nobody else', () => {
    expect(v.scope).toEqual([HOUZS]);
    expect(v.open).toEqual([]);
    expect(v.unknown).toEqual([]);
    expect(v.malformed).toBe(false);
  });

  it('refuses every Houzs area, exactly as before', () => {
    for (const area of [
      'scm.sales.orders',
      'scm.procurement.po',
      'scm.sales.delivery',
      'scm.procurement.grn',
      'scm.procurement.pi',
      'scm.sales.invoices',
      'scm.warehouse.inventory',
      'scm.finance.accounting',
    ]) {
      expect(isFrozen(v, HOUZS, area), area).toBe(true);
    }
  });

  it('refuses the unguarded routers too (area null)', () => {
    expect(isFrozen(v, HOUZS, null)).toBe(true);
  });

  it('leaves 2990 trading normally', () => {
    expect(isFrozen(v, TWENTY_NINE_NINETY, 'scm.sales.orders')).toBe(false);
    expect(isFrozen(v, TWENTY_NINE_NINETY, null)).toBe(false);
  });

  it('lets an unattributable request through rather than guessing', () => {
    // Refusing what we cannot attribute would take 2990 down on a
    // companies-master blip — the exact outage the scoping exists to avoid.
    expect(isFrozen(v, undefined, 'scm.sales.orders')).toBe(false);
  });
});

describe('open values', () => {
  it('treats absent / off / falsey / whitespace as open', () => {
    for (const raw of [null, undefined, '', '   ', '\t\n ', 'off', 'OFF', ' Off ', '0', 'false']) {
      const v = parseFreezeValue(raw);
      expect(v.scope, String(raw)).toBe('off');
      expect(v.malformed, String(raw)).toBe(false);
    }
  });

  it('an absent row is the seeded default, not a typo — it stays open', () => {
    // Migration 0272 seeds 'off'; every fresh environment reads absent/empty.
    // Failing closed here would freeze every dev, CI and staging environment.
    expect(isFrozen(parseFreezeValue(undefined), HOUZS, 'scm.sales.orders')).toBe(false);
    expect(isFrozen(parseFreezeValue(''), HOUZS, null)).toBe(false);
  });
});

describe('company scope', () => {
  it("freezes every company only on 'all' / 'true'", () => {
    for (const raw of ['all', 'ALL', ' All ', 'true', 'TRUE']) {
      expect(parseFreezeValue(raw).scope, raw).toBe('all');
    }
    expect(isFrozen(parseFreezeValue('all'), TWENTY_NINE_NINETY, 'scm.sales.orders')).toBe(true);
  });

  it('parses a company id list, whitespace and all', () => {
    expect(parseFreezeValue('1').scope).toEqual([1]);
    expect(parseFreezeValue('1,3').scope).toEqual([1, 3]);
    expect(parseFreezeValue(' 1 , 3 ').scope).toEqual([1, 3]);
  });

  it('de-duplicates a repeated company', () => {
    expect(parseFreezeValue('1,1,3').scope).toEqual([1, 3]);
  });

  it('does not invent company 0 from a trailing comma', () => {
    // The previous parser used Number(), and Number('') is 0.
    expect(parseFreezeValue('1,').scope).toEqual([1]);
    expect(parseFreezeValue('1, ,3').scope).toEqual([1, 3]);
  });
});

describe('the staged lift grammar', () => {
  it('freezes a company EXCEPT a named area', () => {
    const v = parseFreezeValue('1 - scm.sales.orders');
    expect(v.scope).toEqual([1]);
    expect(v.open).toEqual(['scm.sales.orders']);
    expect(isFrozen(v, HOUZS, 'scm.sales.orders')).toBe(false);
    expect(isFrozen(v, HOUZS, 'scm.procurement.po')).toBe(true);
  });

  it('accepts several areas, and any spacing around the dash and commas', () => {
    for (const raw of [
      '1 - scm.sales.orders, scm.procurement.po',
      '1-scm.sales.orders,scm.procurement.po',
      '  1   -   scm.sales.orders ,  scm.procurement.po  ',
      '1 - scm.sales.orders,scm.procurement.po,',
    ]) {
      const v = parseFreezeValue(raw);
      expect(v.scope, raw).toEqual([1]);
      expect([...v.open].sort(), raw).toEqual(['scm.procurement.po', 'scm.sales.orders']);
      expect(v.malformed, raw).toBe(false);
    }
  });

  it('is case-insensitive', () => {
    const v = parseFreezeValue('1 - SCM.Sales.Orders');
    expect(v.open).toEqual(['scm.sales.orders']);
  });

  it('lets the scm. prefix be left off', () => {
    expect(parseFreezeValue('1 - sales.orders').open).toEqual(['scm.sales.orders']);
    expect(parseFreezeValue('1 - sales.orders, procurement.po').open.length).toBe(2);
  });

  it('de-duplicates a repeated area', () => {
    const v = parseFreezeValue('1 - scm.sales.orders, sales.orders, SCM.SALES.ORDERS');
    expect(v.open).toEqual(['scm.sales.orders']);
  });

  it('a dash with nothing after it is just a plain freeze', () => {
    const v = parseFreezeValue('1 -');
    expect(v.scope).toEqual([1]);
    expect(v.open).toEqual([]);
    expect(isFrozen(v, HOUZS, 'scm.sales.orders')).toBe(true);
  });

  it("works with 'all' too", () => {
    const v = parseFreezeValue('all - scm.sales.orders');
    expect(v.scope).toBe('all');
    expect(isFrozen(v, TWENTY_NINE_NINETY, 'scm.sales.orders')).toBe(false);
    expect(isFrozen(v, TWENTY_NINE_NINETY, 'scm.procurement.po')).toBe(true);
  });
});

describe('a lift NEVER leaks across companies', () => {
  it('does not open an area for a company the value did not freeze', () => {
    // 2990 is not in scope at all, so it was already free — and the exception
    // list is never consulted for it.
    const v = parseFreezeValue('1 - scm.sales.orders');
    expect(isFrozen(v, TWENTY_NINE_NINETY, 'scm.procurement.po')).toBe(false);
    expect(isFrozen(v, HOUZS, 'scm.procurement.po')).toBe(true);
  });

  it('freezing 2990 only does not touch Houzs', () => {
    const v = parseFreezeValue('2 - scm.sales.orders');
    expect(isFrozen(v, TWENTY_NINE_NINETY, 'scm.sales.orders')).toBe(false);
    expect(isFrozen(v, TWENTY_NINE_NINETY, 'scm.procurement.po')).toBe(true);
    expect(isFrozen(v, HOUZS, 'scm.procurement.po')).toBe(false);
  });

  it('applies the exception to every company named, and only those', () => {
    const v = parseFreezeValue('1,2 - scm.sales.orders');
    expect(isFrozen(v, HOUZS, 'scm.sales.orders')).toBe(false);
    expect(isFrozen(v, TWENTY_NINE_NINETY, 'scm.sales.orders')).toBe(false);
    expect(isFrozen(v, 3, 'scm.sales.orders')).toBe(false); // never frozen
    expect(isFrozen(v, HOUZS, 'scm.procurement.grn')).toBe(true);
  });
});

describe('FAIL CLOSED — a value nobody can parse freezes, never opens', () => {
  // The worst outcome this feature can have is a typo that silently unfreezes
  // production. Every malformed shape below resolves to a freeze of EVERY
  // company, which is loud, visible within the cache TTL, and reversed by one
  // UPDATE (docs/write-freeze-staged-lift.md). It is deliberately NOT 'off'.
  const GARBAGE = [
    'yes please',
    'houzs',
    'on',
    'frozen',
    '- scm.sales.orders',
    'company 1',
    '1;2',
    'all companies',
    '1.5',
    'null',
    'undefined',
    '{"companies":[1]}',
  ];

  for (const raw of GARBAGE) {
    it(`${JSON.stringify(raw)} freezes everything`, () => {
      const v = parseFreezeValue(raw);
      expect(v.scope, raw).toBe('all');
      expect(v.malformed, raw).toBe(true);
      expect(isFrozen(v, HOUZS, 'scm.sales.orders'), raw).toBe(true);
      expect(isFrozen(v, TWENTY_NINE_NINETY, 'scm.sales.orders'), raw).toBe(true);
      expect(isFrozen(v, undefined, null), raw).toBe(true);
    });
  }

  it('a malformed company scope carries NO lift, even a well-spelled one', () => {
    const v = parseFreezeValue('houzs - scm.sales.orders');
    expect(v.scope).toBe('all');
    expect(v.open).toEqual([]);
    expect(isFrozen(v, HOUZS, 'scm.sales.orders')).toBe(true);
  });

  it('a typo in the DASH does not escalate past the company that was named', () => {
    /* '1 -- scm.sales.orders' splits on the FIRST dash, so the head ('1') is
       intelligible and only the exception token is junk. The two failures are
       graded on purpose: an unreadable COMPANY part means we cannot tell who to
       freeze, so everyone is frozen; an unreadable AREA token means we simply do
       not lift it. Escalating this one to 'all' would stop 2990 over a
       stray keystroke in Houzs's exception list — an outage the value never
       asked for. Either way NOTHING opens, which is the property that matters. */
    const v = parseFreezeValue('1 -- scm.sales.orders');
    expect(v.scope).toEqual([1]);
    expect(v.open).toEqual([]);
    expect(v.unknown).toEqual(['- scm.sales.orders']);
    expect(isFrozen(v, HOUZS, 'scm.sales.orders')).toBe(true);
    expect(isFrozen(v, TWENTY_NINE_NINETY, 'scm.sales.orders')).toBe(false);
  });

  it('an UNKNOWN area is discarded, not lifted — and is reported', () => {
    const v = parseFreezeValue('1 - scm.sales.order');
    expect(v.scope).toEqual([1]);
    expect(v.open).toEqual([]);
    expect(v.unknown).toEqual(['scm.sales.order']);
    expect(v.malformed).toBe(false);
    // The freeze stands. The typo cost a non-lift, never an accidental lift.
    expect(isFrozen(v, HOUZS, 'scm.sales.orders')).toBe(true);
  });

  it('a good area beside a bad one still lifts only the good one', () => {
    const v = parseFreezeValue('1 - scm.sales.orders, scm.sales.nonsense');
    expect(v.open).toEqual(['scm.sales.orders']);
    expect(v.unknown).toEqual(['scm.sales.nonsense']);
    expect(isFrozen(v, HOUZS, 'scm.sales.orders')).toBe(false);
    expect(isFrozen(v, HOUZS, 'scm.procurement.po')).toBe(true);
  });

  it('cannot be talked into lifting a router that has no area key', () => {
    // The unguarded routers (hr, staff, localities, ...) resolve to area null,
    // and null is never in `open` because `open` only ever holds real keys.
    for (const raw of ['1 - /hr', '1 - hr', '1 - scm.hr', '1 - *', '1 - all']) {
      const v = parseFreezeValue(raw);
      expect(v.open, raw).toEqual([]);
      expect(isFrozen(v, HOUZS, null), raw).toBe(true);
    }
  });
});

describe('isFrozen is total', () => {
  it('never throws on any shape parseFreezeValue can return', () => {
    const shapes: FreezeValue[] = [
      parseFreezeValue('off'),
      parseFreezeValue('all'),
      parseFreezeValue('1'),
      parseFreezeValue('1 - scm.sales.orders'),
      parseFreezeValue('garbage'),
    ];
    for (const v of shapes) {
      for (const co of [undefined, 0, 1, 2, 999]) {
        for (const area of [null, 'scm.sales.orders', 'not.an.area']) {
          expect(typeof isFrozen(v, co, area)).toBe('boolean');
        }
      }
    }
  });
});

/* ── The GO-LIVE lift, as a value, before anybody types it into production ───

   The row does NOT hold '1' any more. Measured on prod 2026-09-08 10:31 MYT
   (Actions -> "SCM write freeze — status (read-only)", run 34180338466):

     scm.write_freeze = "1 - scm.procurement.products"   (updated 2026-09-02)

   So sales orders are opened by ADDING to that clause, and the stage table in
   docs/write-freeze-staged-lift.md §6 — which starts from a blank `areas` — is
   the trap: `areas` is CUMULATIVE, and its stage-1 row would silently re-close
   product setup. Both values are pinned below, the right one and the wrong one,
   because the difference between them is invisible in the row and expensive on
   the floor. */
describe('the go-live lift for sales orders', () => {
  const LIVE_TODAY = '1 - scm.procurement.products';
  const LIFT = '1 - scm.procurement.products, scm.sales.orders';

  it('today, sales orders are frozen and product setup is not', () => {
    const v = parseFreezeValue(LIVE_TODAY);
    expect(v.malformed).toBe(false);
    expect(v.unknown).toEqual([]);
    expect(isFrozen(v, HOUZS, 'scm.sales.orders')).toBe(true);
    expect(isFrozen(v, HOUZS, 'scm.procurement.products')).toBe(false);
  });

  it('the lift opens sales orders and KEEPS product setup open', () => {
    const v = parseFreezeValue(LIFT);
    expect(v.malformed).toBe(false);
    expect(v.unknown).toEqual([]);
    expect(v.open).toEqual(['scm.procurement.products', 'scm.sales.orders']);
    expect(isFrozen(v, HOUZS, 'scm.sales.orders')).toBe(false);
    expect(isFrozen(v, HOUZS, 'scm.procurement.products')).toBe(false);
  });

  /* Everything else must stay shut. Named individually rather than looped over
     SCM_AREAS, because the point is that a reader can SEE that purchase orders,
     goods receipts, deliveries and invoices are still paused. */
  it('opens NOTHING else — POs, GRNs, PIs, deliveries, invoices, stock all stay shut', () => {
    const v = parseFreezeValue(LIFT);
    for (const area of [
      'scm.procurement.po', 'scm.procurement.grn', 'scm.procurement.pi', 'scm.procurement.pr',
      'scm.procurement.mrp', 'scm.procurement.suppliers',
      'scm.sales.delivery', 'scm.sales.invoices', 'scm.sales.returns',
      'scm.warehouse.inventory', 'scm.warehouse.adjustments', 'scm.warehouse.transfers',
      'scm.warehouse.stock_take', 'scm.finance.accounting', 'scm.finance.outstanding',
      'scm.transportation.drivers',
    ]) {
      expect(isFrozen(v, HOUZS, area), area).toBe(true);
    }
  });

  it('a router with no area key stays shut — nothing can name it', () => {
    expect(isFrozen(parseFreezeValue(LIFT), HOUZS, null)).toBe(true);
  });

  it('2990 is untouched by the lift, as it is by the freeze', () => {
    expect(isFrozen(parseFreezeValue(LIFT), TWENTY_NINE_NINETY, 'scm.sales.orders')).toBe(false);
  });

  /* THE MISTAKE, PINNED. The runbook's stage-1 row reads `areas =
     scm.sales.orders`. Typed against the row as it stands, that CLOSES product
     setup — a lift that takes something away. */
  it('the runbook stage-1 value, typed today, silently RE-CLOSES product setup', () => {
    const wrong = parseFreezeValue('1 - scm.sales.orders');
    expect(isFrozen(wrong, HOUZS, 'scm.sales.orders')).toBe(false);
    expect(isFrozen(wrong, HOUZS, 'scm.procurement.products')).toBe(true);
  });

  it('putting it back is the value that is live today', () => {
    const back = parseFreezeValue(LIVE_TODAY);
    expect(isFrozen(back, HOUZS, 'scm.sales.orders')).toBe(true);
  });
});
