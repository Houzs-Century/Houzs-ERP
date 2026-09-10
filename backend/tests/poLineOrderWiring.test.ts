// ----------------------------------------------------------------------------
// A PURCHASE ORDER LINE'S POSITION IS PART OF THE DOCUMENT.
//
// Owner, 2026-09-10: 「我们的 Sales Order 都是从 L 到 R（L 在第一，R 在最后）」 and
// 「照片是根据 line item 的顺序来的」. `scm.purchase_order_items` had no
// line-order column, so a converted sofa's lines — all written by one insert,
// all sharing a created_at — came back in whatever order Postgres felt like.
//
// TWO THINGS THIS PINS, and neither can be seen by a unit test of the helper:
//   1. every WRITE that borns PO lines numbers them;
//   2. the READ and the PDF both apply the stored order.
//
// WHAT IT CANNOT SEE, said rather than implied: the window scan below proves a
// numbering construct sits NEAR each insert, not that it numbers THAT payload.
// The load-bearing half is the ENUMERATION — the exact list of insert sites is
// asserted, so a NEW one fails this test and has to be decided on rather than
// silently shipping un-numbered lines. That is the same shape as
// `acLineOrderWiring.test.ts`, and the same reason: no test over the helper can
// see a caller that forgot to call it.
//
// NO CONSTRUCTED REGEX for the needles — `acLineOrderWiring.test.ts` was
// written twice with a matcher that escaped itself into matching nothing and
// passed against the source it was written to reject. Every needle here is
// asserted PRESENT before anything is asserted about it.
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import poRoutesSrc from '../src/scm/routes/mfg-purchase-orders.ts?raw';
import poRevisionSrc from '../src/scm/lib/po-revision.ts?raw';
import soRevisionSrc from '../src/scm/lib/so-revision.ts?raw';
import poPdfSrc from '../../frontend/src/vendor/scm/lib/purchase-order-pdf.ts?raw';

/** Comments quote the shapes this file forbids, so they are stripped. */
const code = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const SOURCES: Array<[string, string]> = [
  ['mfg-purchase-orders.ts', code(poRoutesSrc)],
  ['po-revision.ts', code(poRevisionSrc)],
  ['so-revision.ts', code(soRevisionSrc)],
];

/** Every `from('purchase_order_items') … .insert(` in one file, as offsets. */
function insertSites(src: string): number[] {
  const out: number[] = [];
  const re = /from\('purchase_order_items'\)[\s\S]{0,400}?\.insert\(/g;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) out.push(m.index);
  return out;
}

describe('every write that borns a PO line numbers it', () => {
  /* THE ENUMERATION. Written out so a NEW insert site is a failing test rather
     than a document that silently prints in Postgres order. Update it in the
     same change that adds the site — and number the lines while you are there. */
  const EXPECTED_SITES: Record<string, number> = {
    'mfg-purchase-orders.ts': 5, // POST /, convert append, convert create, POST /:id/items, POST /:id/convert-from-so
    'po-revision.ts': 1,         // amendment ADD
    'so-revision.ts': 1,         // SO amendment (12c), a line added to a bound PO
  };

  test.each(SOURCES)('%s: the insert-site matcher still matches', (name, src) => {
    expect(insertSites(src).length, `${name}: no purchase_order_items insert found — the matcher is stale`)
      .toBeGreaterThan(0);
  });

  test.each(SOURCES)('%s: the set of insert sites is the enumerated one', (name, src) => {
    expect(insertSites(src).length).toBe(EXPECTED_SITES[name]);
  });

  test.each(SOURCES)('%s: every insert site numbers its lines', (name, src) => {
    for (const at of insertSites(src)) {
      const window = src.slice(Math.max(0, at - 1400), at + 400);
      expect(
        /stampPoLineNos\(|line_no:/.test(window),
        `${name}: a purchase_order_items insert near offset ${at} carries no line_no`,
      ).toBe(true);
    }
  });
});

describe('the stored order reaches the screen and the paper', () => {
  test('the detail read goes through the one helper', () => {
    const src = code(poRoutesSrc);
    expect(src).toContain("inPoLineOrder(supabase.from('purchase_order_items').select(ITEM_COLS)");
    /* The column has to be SELECTED or the order is invisible to the PDF, which
       re-sorts on it client-side. */
    expect(src).toContain("'line_no, id, purchase_order_id,");
  });

  test('no read spells the order out by hand beside the helper', () => {
    const src = code(poRoutesSrc);
    expect(src).not.toContain(".select(ITEM_COLS).eq('purchase_order_id', id).order('created_at')");
  });

  test('the PDF sorts on it, and that same const drives the PHOTO block', () => {
    const src = code(poPdfSrc);
    expect(src).toContain('sortLinesByStoredLineNo(');
    /* The owner's second sentence — 「照片是根据 line item 的顺序来的」. If these
       ever stop reading the same const the photos scramble on their own. */
    expect(src).toContain('const orderedItems = orderSofaModuleRowsWithinBuilds(');
    expect(src).toContain('buildPhotoGroups(orderedItems.map(');
    expect(src).toContain('const rows: Row[] = orderedItems.map(');
  });

  test('inPoLineOrder is line_no NULLS FIRST, then created_at, then id', async () => {
    const { inPoLineOrder } = await import('../src/scm/lib/po-line-order');
    const calls: Array<[string, boolean, boolean | undefined]> = [];
    const stub = {
      order(col: string, o: { ascending: boolean; nullsFirst?: boolean }) {
        calls.push([col, o.ascending, o.nullsFirst]);
        return stub;
      },
    };
    inPoLineOrder(stub);
    /* NULLS FIRST is the load-bearing one: a PO whose lines predate the column
       answers max(line_no) = NULL, so an appended line takes 1 and must land
       AFTER them. `created_at` alone is a PARTIAL order — one insert gives a
       whole sofa the same timestamp — and `id` is what makes it total. */
    expect(calls).toEqual([
      ['line_no', true, true],
      ['created_at', true, undefined],
      ['id', true, undefined],
    ]);
  });
});

describe('nextPoLineNo', () => {
  const stub = (result: { data: unknown; error: unknown }) => ({
    from: () => ({ select: () => ({ eq: () => ({ order: () => ({ limit: () => ({ maybeSingle: () => Promise.resolve(result) }) }) }) }) }),
  });

  test('an empty PO, and a PO whose lines predate the column, both answer 1', async () => {
    const { nextPoLineNo } = await import('../src/scm/lib/po-line-order');
    expect(await nextPoLineNo(stub({ data: null, error: null }), 'po-1')).toBe(1);
    expect(await nextPoLineNo(stub({ data: { line_no: null }, error: null }), 'po-1')).toBe(1);
  });

  test('it continues after the highest', async () => {
    const { nextPoLineNo } = await import('../src/scm/lib/po-line-order');
    expect(await nextPoLineNo(stub({ data: { line_no: 7 }, error: null }), 'po-1')).toBe(8);
  });

  test('a FAILED read throws — it must not read as "this PO has no lines"', async () => {
    /* supabase-js does not throw on its own, so an unbound error here would be
       indistinguishable from an empty PO and would put line_no 1 on a document
       that already has ten (check-swallowed-reads.mjs). */
    const { nextPoLineNo } = await import('../src/scm/lib/po-line-order');
    await expect(nextPoLineNo(stub({ data: null, error: { message: 'connection lost' } }), 'po-1'))
      .rejects.toThrow('connection lost');
  });
});

describe('sortLinesByStoredLineNo', () => {
  test('orders by the stored position', async () => {
    const { sortLinesByStoredLineNo } = await import('../src/scm/shared/so-line-display');
    const out = sortLinesByStoredLineNo([
      { code: '1NA', line_no: 2 },
      { code: '1A(RHF)', line_no: 3 },
      { code: 'L(LHF)', line_no: 1 },
    ]);
    expect(out.map((r) => r.code)).toEqual(['L(LHF)', '1NA', '1A(RHF)']);
  });

  test('un-numbered lines come FIRST and keep the order they arrived in', () => {
    /* A historical document has no line_no on any line; a line appended to it
       today takes 1. NULLS FIRST is what keeps the old lines in front, and the
       stability is what stops the sort re-sequencing a document it has no
       evidence about. */
    return import('../src/scm/shared/so-line-display').then(({ sortLinesByStoredLineNo }) => {
      const out = sortLinesByStoredLineNo([
        { code: 'old-a', line_no: null },
        { code: 'old-b', line_no: null },
        { code: 'appended', line_no: 1 },
      ]);
      expect(out.map((r) => r.code)).toEqual(['old-a', 'old-b', 'appended']);
    });
  });

  test('a row with no line_no key at all is treated as un-numbered, not as 0', async () => {
    const { sortLinesByStoredLineNo } = await import('../src/scm/shared/so-line-display');
    const out = sortLinesByStoredLineNo([{ code: 'numbered', line_no: 4 }, { code: 'absent' }]);
    expect(out.map((r) => r.code)).toEqual(['absent', 'numbered']);
  });

  test('the frontend copy of the rule is byte-identical to the backend one', async () => {
    /* so-line-display is one of the 17 IDENTICAL mirrors
       (backend/scripts/check-shared-mirrors.mjs). A PO PDF that sorted by a
       drifted copy of this rule would print a different document from the one
       the screen shows. */
    const be = (await import('../src/scm/shared/so-line-display.ts?raw')).default;
    const fe = (await import('../../frontend/src/vendor/shared/so-line-display.ts?raw')).default;
    expect(fe.replace(/\r\n/g, '\n')).toBe(be.replace(/\r\n/g, '\n'));
  });
});
