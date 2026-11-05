// HC-0184: a photo added to an SO line after its PO was raised never reached
// the PO (HC-SO-2610-400 STOOL drawing vs HC-PO-2610-438_R1).
import { describe, expect, test } from 'vitest';
import { carrySoPhotoToPoLines } from './so-photo-po-carry';

type Line = { id: string; purchase_order_id: string; photo_urls: string[] | null; so_item_id: string };

function fakeSb(lines: Line[], pos: Array<{ id: string; status: string }>) {
  const updates: Array<{ id: string; photo_urls: string[] }> = [];
  const sb = {
    from(table: string) {
      let patch: { photo_urls: string[] } | null = null;
      const q = {
        select() { return q; },
        update(p: { photo_urls: string[] }) { patch = p; return q; },
        eq(col: string, val: string) {
          if (patch) {
            updates.push({ id: val, photo_urls: patch.photo_urls });
            return Promise.resolve({ error: null });
          }
          return Promise.resolve({ data: lines.filter((l) => (l as Record<string, unknown>)[col] === val), error: null });
        },
        in(_col: string, ids: string[]) {
          return Promise.resolve({ data: table === 'purchase_orders' ? pos.filter((p) => ids.includes(p.id)) : [], error: null });
        },
      };
      return q;
    },
  };
  return { sb, updates };
}

const KEY = 'so-items/HC-SO-2610-400/si-stool/drawing.webp';

describe('carrySoPhotoToPoLines', () => {
  test('a photo added on the SO line lands on its live PO line, after the PO own uploads', async () => {
    const { sb, updates } = fakeSb(
      [
        { id: 'pl-1', purchase_order_id: 'po-438', photo_urls: ['po-items/po-438/pl-1/own.jpg'], so_item_id: 'si-stool' },
        { id: 'pl-2', purchase_order_id: 'po-old', photo_urls: [], so_item_id: 'si-stool' },
      ],
      [{ id: 'po-438', status: 'SUBMITTED' }, { id: 'po-old', status: 'CANCELLED' }],
    );
    expect(await carrySoPhotoToPoLines(sb, 'si-stool', { add: KEY })).toBeNull();
    expect(updates).toEqual([{ id: 'pl-1', photo_urls: ['po-items/po-438/pl-1/own.jpg', KEY] }]);
  });

  test('a removed SO photo leaves the PO line; a key already there is not added twice', async () => {
    const lines = [{ id: 'pl-1', purchase_order_id: 'po-438', photo_urls: [KEY], so_item_id: 'si-stool' }];
    const pos = [{ id: 'po-438', status: 'SUBMITTED' }];
    const added = fakeSb(lines, pos);
    await carrySoPhotoToPoLines(added.sb, 'si-stool', { add: KEY });
    expect(added.updates).toEqual([]);
    const removed = fakeSb(lines, pos);
    await carrySoPhotoToPoLines(removed.sb, 'si-stool', { remove: KEY });
    expect(removed.updates).toEqual([{ id: 'pl-1', photo_urls: [] }]);
  });

  test('an SO line with no PO line writes nothing', async () => {
    const { sb, updates } = fakeSb([], []);
    expect(await carrySoPhotoToPoLines(sb, 'si-none', { add: KEY })).toBeNull();
    expect(updates).toEqual([]);
  });
});
