import { describe, expect, test } from 'vitest';
import { fillMissingSoItemIds, claimedSoItemIdsOnDo, DO_LINE_AMBIGUOUS_SO_LINE } from '../src/scm/lib/derive-do-so-item-id';

/* The guard that stops a delivery-order line being written with no link to the
   sales-order line it ships. The silent null is the defect (owner 2026-08-14:
   24 such lines made MRP re-order goods that had already shipped), so what
   matters here is that the derivation happens, that an ad-hoc line still gets
   through, and that an unreadable sales order refuses rather than defaulting. */

/** Minimal PostgREST stand-in: .from().select().eq().eq() resolves. */
const fakeSb = (rows: unknown[] | null, error: { message: string } | null = null) => {
  const builder: Record<string, unknown> = {};
  builder.select = () => builder;
  builder.eq = () => builder;
  builder.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: rows, error }).then(resolve);
  return { from: () => builder } as never;
};

const soLine = (id: string, item_code: string, extra: Record<string, unknown> = {}) =>
  ({ id, doc_no: 'SO-1', item_code, qty: 1, variants: null, description2: null, ...extra });

describe('fillMissingSoItemIds', () => {
  test('fills the link the client omitted', async () => {
    const r = await fillMissingSoItemIds(fakeSb([soLine('s1', 'CODY-(K)')]), 'SO-1', [{ itemCode: 'CODY-(K)', qty: 1 }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.derived).toBe(1);
    expect(r.items[0].soItemId).toBe('s1');
  });

  test('never touches a link the client did send', async () => {
    // The client is the only one who knows it meant s2; the reading must not
    // second-guess a stated answer.
    const r = await fillMissingSoItemIds(
      fakeSb([soLine('s1', 'CODY-(K)'), soLine('s2', 'CODY-(K)')]),
      'SO-1',
      [{ itemCode: 'CODY-(K)', qty: 1, soItemId: 's2' }],
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.derived).toBe(0);
    expect(r.items[0].soItemId).toBe('s2');
  });

  test('lets an ad-hoc line through — its code is on no SO line', async () => {
    /* The delivery paths document this shape ("ad-hoc lines with no
       so_item_id"). Closing the hole is not a licence to break it. */
    const r = await fillMissingSoItemIds(fakeSb([soLine('s1', 'CODY-(K)')]), 'SO-1', [{ itemCode: 'FREE-GIFT', qty: 1 }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.derived).toBe(0);
    expect(r.items[0].soItemId).toBeUndefined();
  });

  test('refuses when the SO has two lines of the code and nothing tells them apart', async () => {
    const r = await fillMissingSoItemIds(
      fakeSb([soLine('s1', 'CODY-(K)'), soLine('s2', 'CODY-(K)')]),
      'SO-1',
      [{ itemCode: 'CODY-(K)', qty: 1 }],
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe(DO_LINE_AMBIGUOUS_SO_LINE);
    expect(r.message).toContain('CODY-(K)');
  });

  test('reads two same-code lines apart on the variant both documents carry', async () => {
    const r = await fillMissingSoItemIds(
      fakeSb([
        soLine('s-bf10', 'CODY-(K)', { variants: { colourId: 'BF-10' } }),
        soLine('s-bf12', 'CODY-(K)', { variants: { colourId: 'BF-12' } }),
      ]),
      'SO-1',
      [{ itemCode: 'CODY-(K)', qty: 1, variants: { colourId: 'BF-12' } }],
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.items[0].soItemId).toBe('s-bf12');
  });

  test('an SO line already used by THIS delivery order is not a candidate again', async () => {
    // Two DOs against one SO line is ordinary partial delivery; two lines on
    // ONE delivery order is not — so with s1 claimed, nothing is left to read.
    const r = await fillMissingSoItemIds(
      fakeSb([soLine('s1', 'CODY-(K)')]),
      'SO-1',
      [{ itemCode: 'CODY-(K)', qty: 1 }],
      ['s1'],
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.items[0].soItemId).toBeUndefined();   // falls through as ad-hoc, not mis-linked
  });

  test('a failed read refuses instead of writing the null it exists to prevent', async () => {
    const r = await fillMissingSoItemIds(fakeSb(null, { message: 'connection reset' }), 'SO-1', [{ itemCode: 'CODY-(K)', qty: 1 }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('so_lines_unreadable');
    expect(r.message).toContain('connection reset');
  });

  test('does nothing when there is no sales order, or nothing is missing', async () => {
    const adhocDo = await fillMissingSoItemIds(fakeSb([]), null, [{ itemCode: 'X', qty: 1 }]);
    expect(adhocDo.ok && adhocDo.derived).toBe(0);
    const allLinked = await fillMissingSoItemIds(fakeSb([]), 'SO-1', [{ itemCode: 'X', qty: 1, soItemId: 's9' }]);
    expect(allLinked.ok && allLinked.derived).toBe(0);
  });
});

/* The exclusion list feeding the guard above. Its failure mode is SILENT and it
   is one level up from the defect this file exists to close: if the read of
   "which SO lines has this DO already claimed" fails and we call that "nothing
   claimed", the exclusion empties, the ambiguity disappears with it, and the
   add path cheerfully pairs a second line on ONE delivery order to an SO line
   it is already shipping. That is why this reads `error` instead of `data ??
   []` — the shape check-swallowed-reads.mjs exists to find. */
describe('claimedSoItemIdsOnDo', () => {
  test('returns the links the DO already holds, nulls included', async () => {
    const r = await claimedSoItemIdsOnDo(fakeSb([{ so_item_id: 's1' }, { so_item_id: null }]), 'do-1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ids).toEqual(['s1', null]);
  });

  test('a failed read REFUSES rather than reporting an empty claim list', async () => {
    /* The whole point. `data ?? []` here would report "nothing claimed" for a
       database that never answered, and the caller would then be free to
       re-link a line the DO already ships. */
    const r = await claimedSoItemIdsOnDo(fakeSb(null, { message: 'connection reset' }), 'do-1');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('do_lines_unreadable');
    expect(r.message).toContain('connection reset');
  });

  test('an empty delivery order is an empty list, not a refusal', async () => {
    // "No lines yet" is a legitimate answer and must not read as a failure.
    const r = await claimedSoItemIdsOnDo(fakeSb([]), 'do-1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ids).toEqual([]);
  });
});
