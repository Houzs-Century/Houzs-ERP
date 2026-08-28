// Mig 20260828T0746 — the DO leg of the owner's 2026-08-10 photo-carry rule.
// These pin the pure half of the carry (the map read + the row builder); the
// convert path itself is driven end-to-end by
// routes/delivery-orders-mfg.photo-carry.test.ts.
import { describe, expect, test, vi } from 'vitest';
import { buildDoItemRow, carriedPhotoUrls, loadCarriedSoLinePhotos } from './do-item-row';

/* The scoped read, faked at the PostgREST seam: `scope` receives the builder
   and the test asserts it was APPLIED — the predicate is the tenant boundary,
   so a helper that forgot to pass the query through `scope` would ship a
   cross-company photo read. */
function fakeSb(rows: Array<{ id: string; photo_urls: string[] | null }>) {
  const calls: Array<{ table: string; select: string; inIds: unknown[] }> = [];
  const sb = {
    from(table: string) {
      const call = { table, select: '', inIds: [] as unknown[] };
      calls.push(call);
      const q = {
        select(cols: string) { call.select = cols; return q; },
        in(_col: string, ids: unknown[]) {
          call.inIds = ids;
          return Promise.resolve({ data: rows.filter((r) => ids.includes(r.id)), error: null });
        },
      };
      return q;
    },
  };
  return { sb, calls };
}

describe('loadCarriedSoLinePhotos', () => {
  test('reads photos per linked line through the caller-supplied scope', async () => {
    const { sb, calls } = fakeSb([
      { id: 'si-1', photo_urls: ['so-items/SO-1/si-1/a.jpg'] },
      { id: 'si-2', photo_urls: null },
    ]);
    let scoped = 0;
    const map = await loadCarriedSoLinePhotos(
      sb,
      [{ soItemId: 'si-1' }, { soItemId: 'si-2' }, { soItemId: null }, {}],
      (q) => { scoped += 1; return q; },
    );
    expect(scoped).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.table).toBe('mfg_sales_order_items');
    expect(calls[0]!.inIds).toEqual(['si-1', 'si-2']);
    expect(map.get('si-1')).toEqual(['so-items/SO-1/si-1/a.jpg']);
    // A null photo_urls row lands in the map as [] — readers never see null.
    expect(map.get('si-2')).toEqual([]);
  });

  test('no linked lines means no query at all', async () => {
    const { sb, calls } = fakeSb([]);
    const map = await loadCarriedSoLinePhotos(sb, [{ soItemId: null }, {}], (q) => q);
    expect(map.size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test('duplicate soItemIds collapse to one id in the read', async () => {
    const { sb, calls } = fakeSb([{ id: 'si-1', photo_urls: ['k.jpg'] }]);
    await loadCarriedSoLinePhotos(sb, [{ soItemId: 'si-1' }, { soItemId: 'si-1' }], (q) => q);
    expect(calls[0]!.inIds).toEqual(['si-1']);
  });

  test('a failed read degrades to photo-less lines (empty map), never a throw', async () => {
    /* Best-effort by design — the keys stay on the SO line and a re-carry is
       possible, so a blip must not fail the delivery being cut. */
    const sb = {
      from: () => ({
        select: () => ({
          in: () => Promise.resolve({ data: null, error: { message: 'connection reset' } }),
        }),
      }),
    };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const map = await loadCarriedSoLinePhotos(sb, [{ soItemId: 'si-1' }], (q) => q);
      expect(map.size).toBe(0);
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('carriedPhotoUrls', () => {
  const map = new Map<string, string[]>([['si-1', ['a.jpg', 'b.png']]]);

  test('a linked line gets its own array, in order', () => {
    expect(carriedPhotoUrls(map, 'si-1')).toEqual(['a.jpg', 'b.png']);
  });

  test('unlinked and unknown lines get [] and never null (column is NOT NULL)', () => {
    expect(carriedPhotoUrls(map, null)).toEqual([]);
    expect(carriedPhotoUrls(map, undefined)).toEqual([]);
    expect(carriedPhotoUrls(map, 'si-unknown')).toEqual([]);
  });
});

describe('buildDoItemRow photo carry', () => {
  const photos = new Map<string, string[]>([['si-1', ['so-items/SO-1/si-1/build.jpg']]]);

  test('an SO-linked row carries the map entry', () => {
    const row = buildDoItemRow('do-1', { itemCode: 'SOFA-A', qty: 1, soItemId: 'si-1' }, 0, null, photos);
    expect(row.photo_urls).toEqual(['so-items/SO-1/si-1/build.jpg']);
    expect(row.so_item_id).toBe('si-1');
  });

  test('an ad-hoc row (no soItemId) stores [], never null', () => {
    const row = buildDoItemRow('do-1', { itemCode: 'ADHOC', qty: 1 }, 0, null, photos);
    expect(row.photo_urls).toEqual([]);
    expect(row.so_item_id).toBeNull();
  });

  test('per line, never deduplicated — two rows sharing one SO photo both keep it', () => {
    const shared = new Map<string, string[]>([
      ['si-1', ['so-items/SO-1/si-1/build.jpg']],
      ['si-2', ['so-items/SO-1/si-1/build.jpg']],
    ]);
    const r1 = buildDoItemRow('do-1', { itemCode: 'SOFA-A-LHF', qty: 1, soItemId: 'si-1' }, 0, null, shared);
    const r2 = buildDoItemRow('do-1', { itemCode: 'SOFA-A-RHF', qty: 1, soItemId: 'si-2' }, 1, null, shared);
    expect(r1.photo_urls).toEqual(['so-items/SO-1/si-1/build.jpg']);
    expect(r2.photo_urls).toEqual(['so-items/SO-1/si-1/build.jpg']);
  });
});
