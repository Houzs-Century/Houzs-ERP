import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  amendmentMixRefusal, createMixRefusal, lineMixRefusal, mixesSofaWithOtherMain,
  sofaMixRefusal, SOFA_MIX_ERROR, type MixRefusal,
} from './main-mix';

/* ═══════════════════════════════════════════════════════════════════════════
   "May a sofa share an order with a bedframe or a mattress?" — one rule, three
   FORMS, and the difference between them is the whole risk of this change.

   CREATE asks a FLAT question (does this document mix?). ADD / EDIT / SWAP and
   AMENDMENT ask a DIFFERENTIAL one (does this change INTRODUCE a mix?). Porting
   the flat form onto an edit path would make every order that already mixes —
   every order written before the rule existed — permanently uneditable, which
   is a worse bug than the hole being closed. The grandfathering cases below are
   the ones that must never go green by accident.

   And there is a THIRD answer besides yes and no: "we could not tell". Each
   function returns a refusal or null rather than a boolean so that a failed read
   cannot arrive dressed as a clean pass.
   ═══════════════════════════════════════════════════════════════════════════ */

/* The fake client and its chainable builder are structurally typed by the
   library under test, which takes an untyped client (see `Sb` in main-mix.ts). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see the comment above
type AnySb = any;

type Row = Record<string, unknown> & { _table: string };

/** Supabase-shaped mock: chainable `.select().eq().in()`, thenable. Records the
 *  filters so a test can prove the query was actually scoped, and can be told to
 *  fail a named table so the "could not tell" path is reachable. */
const makeSb = (rows: Row[], failTable?: string) => {
  const calls: Array<{ table: string; eqs: Array<[string, unknown]> }> = [];
  return {
    calls,
    from(table: string) {
      const eqs: Array<[string, unknown]> = [];
      const ins: Array<[string, unknown[]]> = [];
      calls.push({ table, eqs });
      const run = () => rows
        .filter((r) => r._table === table)
        .filter((r) => eqs.every(([col, v]) => r[col] === v))
        .filter((r) => ins.every(([col, vs]) => vs.includes(r[col])));
      const result = () => (table === failTable
        ? { data: null, error: { message: 'connection reset' } }
        : { data: run(), error: null });
      const builder: AnySb = {
        select: () => builder,
        order:  () => builder,
        eq: (col: string, v: unknown) => { eqs.push([col, v]); return builder; },
        in: (col: string, vs: unknown[]) => { ins.push([col, vs]); return builder; },
        maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
        then: (res: AnySb, rej: AnySb) => Promise.resolve(result()).then(res, rej),
      };
      return builder;
    },
  };
};

const product = (code: string, category: string, companyId = 1): Row => ({
  _table: 'mfg_products', company_id: companyId, code, category,
});

const coLine = (
  id: string, docNo: string, itemCode: string,
  extra: { item_group?: string | null; cancelled?: boolean } = {},
): Row => ({
  _table: 'consignment_sales_order_items',
  id, doc_no: docNo, item_code: itemCode,
  item_group: extra.item_group ?? null,
  cancelled: extra.cancelled ?? false,
});

const soLine = (id: string, docNo: string, itemCode: string, itemGroup: string | null = null): Row => ({
  _table: 'mfg_sales_order_items',
  id, doc_no: docNo, item_code: itemCode, item_group: itemGroup, cancelled: false,
});

const CATALOGUE = [
  product('SOFA-A', 'SOFA'),
  product('SOFA-B', 'SOFA'),
  product('BED-A', 'BEDFRAME'),
  product('MATT-A', 'MATTRESS'),
  product('SVC-DELIVERY', 'SERVICE'),
  product('ACC-PILLOW', 'ACCESSORY'),
];

/** The three outcomes, named — so a test that means "allowed" cannot silently
 *  accept "we could not tell". */
const verdict = (r: MixRefusal | null): 'allowed' | 'refused' | 'unavailable' =>
  r === null ? 'allowed' : r.body.error === SOFA_MIX_ERROR ? 'refused' : 'unavailable';

/* The unavailable path logs the driver's message. Silence it here, and assert on
   it where that is the point of the test. */
const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});
afterEach(() => { vi.restoreAllMocks(); });

describe('mixesSofaWithOtherMain — the pure predicate', () => {
  it('refuses SOFA next to BEDFRAME or MATTRESS', () => {
    expect(mixesSofaWithOtherMain(['SOFA', 'BEDFRAME'])).toBe(true);
    expect(mixesSofaWithOtherMain(['MATTRESS', 'SOFA'])).toBe(true);
  });

  it('allows a sofa-only order, and a bedframe + mattress order', () => {
    expect(mixesSofaWithOtherMain(['SOFA', 'SOFA'])).toBe(false);
    expect(mixesSofaWithOtherMain(['BEDFRAME', 'MATTRESS'])).toBe(false);
  });

  it('SERVICE / ACCESSORY / OTHERS ride on any order', () => {
    expect(mixesSofaWithOtherMain(['SOFA', 'SERVICE', 'ACCESSORY', 'PILLOW', '', null])).toBe(false);
  });

  /* The classifier is so-readiness.normCategory — a SUBSTRING match, so the
     free-text item_group the create paths fall back to ('Sofa Set', 'BEDFRAME -
     DIVAN') lands in the right bucket. The old soMainMixIntroduced used exact
     equality on the catalogue enum and would have missed these. */
  it('normalises free-text groups the way every other category reader does', () => {
    expect(mixesSofaWithOtherMain(['Sofa Set', 'BEDFRAME - DIVAN'])).toBe(true);
    expect(mixesSofaWithOtherMain([' sofa ', ' Mattress  '])).toBe(true);
  });

  it('the refusal body carries the one code the frontend message map keys off', () => {
    expect(sofaMixRefusal().body.error).toBe(SOFA_MIX_ERROR);
    expect(sofaMixRefusal().body.error).toBe('so_sofa_no_other_main');
    expect(sofaMixRefusal().status).toBe(400);
    expect(sofaMixRefusal().body.reason.length).toBeLessThan(200); // authed-fetch discards ≥200
  });
});

describe('createMixRefusal — the FLAT form (whole document at once)', () => {
  it('refuses a sofa + bedframe document', async () => {
    const sb = makeSb(CATALOGUE);
    expect(verdict(await createMixRefusal(sb, [{ itemCode: 'SOFA-A' }, { itemCode: 'BED-A' }], 1))).toBe('refused');
  });

  it('allows sofa + service + accessory', async () => {
    const sb = makeSb(CATALOGUE);
    expect(verdict(await createMixRefusal(
      sb, [{ itemCode: 'SOFA-A' }, { itemCode: 'SVC-DELIVERY' }, { itemCode: 'ACC-PILLOW' }], 1,
    ))).toBe('allowed');
  });

  it('a BLANK code is the DRAFT placeholder — it classifies from the client itemGroup', async () => {
    const sb = makeSb(CATALOGUE);
    expect(verdict(await createMixRefusal(
      sb, [{ itemCode: '', itemGroup: 'sofa' }, { itemCode: 'BED-A' }], 1,
    ))).toBe('refused');
  });

  it('reads the catalogue within the caller company', async () => {
    /* Company 2's SOFA-A is a MATTRESS. Scoped to company 1 it is a sofa and
       the order is refused; scoped to company 2 it is not and the order is a
       plain mattress + bedframe, which is allowed. */
    const both = [...CATALOGUE, product('SOFA-A', 'MATTRESS', 2), product('BED-A', 'BEDFRAME', 2)];
    expect(verdict(await createMixRefusal(makeSb(both), [{ itemCode: 'SOFA-A' }, { itemCode: 'BED-A' }], 1)))
      .toBe('refused');
    expect(verdict(await createMixRefusal(makeSb(both), [{ itemCode: 'SOFA-A' }, { itemCode: 'BED-A' }], 2)))
      .toBe('allowed');
  });

  it('an empty document does not even issue the read', async () => {
    const sb = makeSb(CATALOGUE);
    expect(verdict(await createMixRefusal(sb, [], 1))).toBe('allowed');
    expect(sb.calls).toEqual([]);
  });

  /* A CODE THAT WAS JUST VALIDATED AND DOES NOT COME BACK IS A FAILED READ.
     validateItemCodes proved it exists moments earlier under the same company
     predicate. Treating it as "unclassified" is how a blip turns into a pass. */
  it('refuses when a validated code does not come back from the catalogue', async () => {
    quiet();
    const sb = makeSb(CATALOGUE, 'mfg_products');
    expect(verdict(await createMixRefusal(sb, [{ itemCode: 'SOFA-A' }, { itemCode: 'BED-A' }], 1)))
      .toBe('unavailable');
  });
});

describe('lineMixRefusal on a CONSIGNMENT ORDER — the hole this closes', () => {
  /* THE LIVE DEFECT. `POST /:docNo/items` and `PATCH /:docNo/items/:itemId` ran
     the catalogue guard, the self-scope guard, the downstream lock and the
     allowed-options gate, and NO composition check. coHasDownstream only blocks
     once a DO / SI exists, so a fresh bedframe-only CO — which the create path
     legitimately permits, there being no sofa in it — accepted a sofa line. */
  const co = (rows: Row[], fail?: string) => makeSb([...CATALOGUE, ...rows], fail);
  const ask = (sb: AnySb, exclude: string | null, code: string) =>
    lineMixRefusal(sb, 'consignment_sales_order_items', 'CO-1', exclude, code, 1);

  it('REFUSES adding a sofa to a bedframe-only CO', async () => {
    expect(verdict(await ask(co([coLine('l1', 'CO-1', 'BED-A')]), null, 'SOFA-A'))).toBe('refused');
  });

  it('REFUSES swapping a CO line to a sofa when a bedframe stays behind', async () => {
    const sb = co([coLine('l1', 'CO-1', 'BED-A'), coLine('l2', 'CO-1', 'ACC-PILLOW')]);
    expect(verdict(await ask(sb, 'l2', 'SOFA-A'))).toBe('refused');
  });

  it('ALLOWS the swap that REPLACES the last bedframe with a sofa', async () => {
    /* After the swap the document is sofa-only. There is no mix to refuse, and
       refusing it would be the flat form leaking onto an edit path. */
    expect(verdict(await ask(co([coLine('l1', 'CO-1', 'BED-A')]), 'l1', 'SOFA-A'))).toBe('allowed');
  });

  it('ALLOWS adding a second sofa to a sofa-only CO', async () => {
    expect(verdict(await ask(co([coLine('l1', 'CO-1', 'SOFA-A')]), null, 'SOFA-B'))).toBe('allowed');
  });

  it('ALLOWS adding a service / accessory line to a sofa CO', async () => {
    const sb = () => co([coLine('l1', 'CO-1', 'SOFA-A')]);
    expect(verdict(await ask(sb(), null, 'SVC-DELIVERY'))).toBe('allowed');
    expect(verdict(await ask(sb(), null, 'ACC-PILLOW'))).toBe('allowed');
  });

  /* ─── GRANDFATHERING. The risk that would make this change worse than the
     bug: an order written before the rule existed already mixes, and its
     operator must still be able to edit it. ─────────────────────────────── */
  it('an ALREADY-MIXED CO still accepts an unrelated line edit', async () => {
    const sb = makeSb([
      ...CATALOGUE,
      coLine('l1', 'CO-OLD', 'SOFA-A'),
      coLine('l2', 'CO-OLD', 'BED-A'),
      coLine('l3', 'CO-OLD', 'ACC-PILLOW'),
    ]);
    // Swapping the accessory for a different accessory changes nothing about
    // the mix that was already there.
    expect(verdict(await lineMixRefusal(
      sb, 'consignment_sales_order_items', 'CO-OLD', 'l3', 'SVC-DELIVERY', 1,
    ))).toBe('allowed');
  });

  it('an ALREADY-MIXED CO still accepts ANOTHER sofa or bedframe line', async () => {
    const rows = [...CATALOGUE, coLine('l1', 'CO-OLD', 'SOFA-A'), coLine('l2', 'CO-OLD', 'BED-A')];
    for (const code of ['SOFA-B', 'MATT-A']) {
      expect(verdict(await lineMixRefusal(
        makeSb(rows), 'consignment_sales_order_items', 'CO-OLD', null, code, 1,
      )), `adding ${code} to an already-mixed CO`).toBe('allowed');
    }
  });

  /* ─── CANCELLED LINES. The CO item table carries the same soft-cancel flag as
     the SO one; a cancelled bedframe is not on the document. ─────────────── */
  it('a CANCELLED bedframe does not block a sofa', async () => {
    expect(verdict(await ask(co([coLine('l1', 'CO-1', 'BED-A', { cancelled: true })]), null, 'SOFA-A')))
      .toBe('allowed');
  });

  it('queries the CO line table by doc_no and cancelled=false', async () => {
    const sb = co([coLine('l1', 'CO-1', 'BED-A')]);
    await ask(sb, null, 'SOFA-A');
    const lineRead = sb.calls.find((x) => x.table === 'consignment_sales_order_items');
    expect(lineRead, 'the CO line table was never read').toBeTruthy();
    expect(lineRead!.eqs).toEqual([['doc_no', 'CO-1'], ['cancelled', false]]);
  });

  /* ─── "WE COULD NOT TELL" is not "allowed". A failed line read makes an order
     look EMPTY, and an empty order can never mix — so the discarded error the
     old helper carried was a silent pass on exactly the request the gate
     exists to refuse. ─────────────────────────────────────────────────────── */
  it('refuses when the line read fails, instead of reading the order as empty', async () => {
    const spy = quiet();
    const sb = co([coLine('l1', 'CO-1', 'BED-A')], 'consignment_sales_order_items');
    const out = await ask(sb, null, 'SOFA-A');
    expect(verdict(out)).toBe('unavailable');
    expect(out!.status).toBe(409);
    expect(out!.body.reason, 'the operator sentence must not carry driver internals')
      .not.toMatch(/connection reset/);
    expect(spy, 'the driver detail belongs in the log, not in the response').toHaveBeenCalled();
  });

  it('refuses when the catalogue read fails', async () => {
    quiet();
    const sb = co([coLine('l1', 'CO-1', 'BED-A')], 'mfg_products');
    expect(verdict(await ask(sb, null, 'SOFA-A'))).toBe('unavailable');
  });
});

describe('lineMixRefusal on a SALES ORDER — same body, other table', () => {
  it('REFUSES adding a sofa to a bedframe-only SO', async () => {
    const sb = makeSb([...CATALOGUE, soLine('l1', 'SO-1', 'BED-A')]);
    expect(verdict(await lineMixRefusal(sb, 'mfg_sales_order_items', 'SO-1', null, 'SOFA-A', 1))).toBe('refused');
  });

  it('an already-mixed SO stays editable', async () => {
    const sb = makeSb([...CATALOGUE, soLine('l1', 'SO-OLD', 'SOFA-A'), soLine('l2', 'SO-OLD', 'MATT-A')]);
    expect(verdict(await lineMixRefusal(sb, 'mfg_sales_order_items', 'SO-OLD', null, 'BED-A', 1))).toBe('allowed');
  });

  it('reads the table it was handed, and not the other one', async () => {
    const sb = makeSb([
      ...CATALOGUE,
      soLine('l1', 'SO-1', 'BED-A'),
      coLine('l9', 'SO-1', 'SOFA-A'),   // same doc_no in the OTHER table — a trap
    ]);
    await lineMixRefusal(sb, 'mfg_sales_order_items', 'SO-1', null, 'SOFA-A', 1);
    expect(sb.calls.some((x) => x.table === 'consignment_sales_order_items')).toBe(false);
  });

  /* The line whose product left the catalogue. soMainMixIntroduced read the
     catalogue ONLY, so such a line classified as nothing at all and a sofa
     could be added on top of a bedframe that was invisible to the gate. Every
     other category reader in this tree falls back to the stored item_group
     (delivery-planning, delivery-zones, so-display-branding); this one now does
     too. It cannot break the grandfathering — a fallback only makes `before`
     MORE complete, i.e. an already-mixed document MORE editable. */
  it('a line whose code left the catalogue is classified from its stored item_group', async () => {
    const sb = makeSb([...CATALOGUE, soLine('l1', 'SO-1', 'RETIRED-BED', 'bedframe')]);
    expect(verdict(await lineMixRefusal(sb, 'mfg_sales_order_items', 'SO-1', null, 'SOFA-A', 1))).toBe('refused');
  });

  it('...and that fallback still grandfathers an order that already mixed', async () => {
    const sb = makeSb([
      ...CATALOGUE,
      soLine('l1', 'SO-OLD', 'RETIRED-BED', 'bedframe'),
      soLine('l2', 'SO-OLD', 'SOFA-A'),
    ]);
    expect(verdict(await lineMixRefusal(sb, 'mfg_sales_order_items', 'SO-OLD', null, 'SOFA-B', 1))).toBe('allowed');
  });
});

describe('amendmentMixRefusal — the third home, found while wiring the other two', () => {
  /* POST /:docNo/amendments is the ONE path that can add a line without going
     through POST /:docNo/items. It checked the catalogue and not the
     composition, and applySoAmendment does not check it either. */
  const amd = (l: Partial<{ salesOrderItemId: string | null; changeType: string; newItemCode: string }>) => ({
    salesOrderItemId: l.salesOrderItemId ?? null,
    changeType: l.changeType ?? 'SPEC',
    newItemCode: l.newItemCode ?? null,
  });

  it('REFUSES an ADD line that puts a sofa on a bedframe order', async () => {
    const sb = makeSb([...CATALOGUE, soLine('l1', 'SO-1', 'BED-A')]);
    expect(verdict(await amendmentMixRefusal(sb, 'SO-1', [amd({ changeType: 'ADD', newItemCode: 'SOFA-A' })], 1)))
      .toBe('refused');
  });

  it('REFUSES a SPEC swap that turns an accessory line into a sofa beside a bedframe', async () => {
    const sb = makeSb([...CATALOGUE, soLine('l1', 'SO-1', 'BED-A'), soLine('l2', 'SO-1', 'ACC-PILLOW')]);
    expect(verdict(await amendmentMixRefusal(
      sb, 'SO-1', [amd({ salesOrderItemId: 'l2', newItemCode: 'SOFA-A' })], 1,
    ))).toBe('refused');
  });

  it('ALLOWS an amendment that REMOVES the last bedframe in the same request as it adds the sofa', async () => {
    /* The case that makes the naive "does the result mix" check wrong: ignoring
       REMOVE would refuse a perfectly legal conversion of a bedframe order into
       a sofa order. Modelled the way applySoAmendment dispatches it. */
    const sb = makeSb([...CATALOGUE, soLine('l1', 'SO-1', 'BED-A')]);
    expect(verdict(await amendmentMixRefusal(sb, 'SO-1', [
      amd({ salesOrderItemId: 'l1', changeType: 'REMOVE' }),
      amd({ changeType: 'ADD', newItemCode: 'SOFA-A' }),
    ], 1))).toBe('allowed');
  });

  it('ALLOWS an ADD of a service line to a sofa order', async () => {
    const sb = makeSb([...CATALOGUE, soLine('l1', 'SO-1', 'SOFA-A')]);
    expect(verdict(await amendmentMixRefusal(sb, 'SO-1', [amd({ changeType: 'ADD', newItemCode: 'SVC-DELIVERY' })], 1)))
      .toBe('allowed');
  });

  it('an ALREADY-MIXED order stays amendable', async () => {
    const sb = makeSb([...CATALOGUE, soLine('l1', 'SO-OLD', 'SOFA-A'), soLine('l2', 'SO-OLD', 'BED-A')]);
    expect(verdict(await amendmentMixRefusal(sb, 'SO-OLD', [amd({ changeType: 'ADD', newItemCode: 'MATT-A' })], 1)))
      .toBe('allowed');
  });

  it('a QTY / SPEC-only amendment costs NOTHING — it never issues a read', async () => {
    const sb = makeSb([...CATALOGUE, soLine('l1', 'SO-1', 'BED-A')]);
    expect(verdict(await amendmentMixRefusal(sb, 'SO-1', [
      amd({ salesOrderItemId: 'l1', changeType: 'QTY' }),
      amd({ salesOrderItemId: 'l1', changeType: 'REMOVE' }),
    ], 1))).toBe('allowed');
    expect(sb.calls, 'a change with no requested item code cannot move a category').toEqual([]);
  });

  it('an empty amendment is not a refusal', async () => {
    const sb = makeSb([...CATALOGUE, soLine('l1', 'SO-1', 'BED-A')]);
    expect(verdict(await amendmentMixRefusal(sb, 'SO-1', [], 1))).toBe('allowed');
  });

  it('refuses when the order cannot be read', async () => {
    quiet();
    const sb = makeSb([...CATALOGUE, soLine('l1', 'SO-1', 'BED-A')], 'mfg_sales_order_items');
    expect(verdict(await amendmentMixRefusal(sb, 'SO-1', [amd({ changeType: 'ADD', newItemCode: 'SOFA-A' })], 1)))
      .toBe('unavailable');
  });
});
