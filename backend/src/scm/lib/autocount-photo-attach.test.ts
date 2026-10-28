import { describe, expect, test, vi } from 'vitest';

import { AC_HOST_MAX_BODY_BYTES, PHOTOS_NOT_SENT_PREFIX, PHOTOS_BAD_FORMAT_PREFIX, attachPhotos, planPhotoBudget } from './autocount-photo-attach';

/* docs/bugs/0899. The host refuses a body over 2 MiB, and one phone photo is
   enough: HC-SO-013496 carries a single 4.20 MB picture (5.6 MB encoded). */
const MB = 1024 * 1024;

describe('planPhotoBudget', () => {
  test('a single picture larger than the limit is left behind, and the rest still fit', () => {
    const plan = planPhotoBudget(4_000, [
      { dtlKey: 1, sizes: [Math.round(4.2 * MB)] },
      { dtlKey: 2, sizes: [200_000, 150_000] },
    ]);
    expect(plan.attach).toEqual([2]);
    expect(plan.tooLarge).toEqual([{ dtlKey: 1, bytes: Math.round(4.2 * MB) }]);
  });

  test('greedy in payload order: the line that would cross the limit is the one left', () => {
    const plan = planPhotoBudget(0, [
      { dtlKey: 1, sizes: [900_000] },
      { dtlKey: 2, sizes: [900_000] },
      { dtlKey: 3, sizes: [10_000] },
    ]);
    /* 900 KB is 1.2 MB encoded: one fits, the second would pass 2 MiB, the small third still fits. */
    expect(plan.attach).toEqual([1, 3]);
    expect(plan.tooLarge.map((t) => t.dtlKey)).toEqual([2]);
  });

  test('small pictures all fit, as every cutover photograph did', () => {
    expect(planPhotoBudget(2_000, [{ dtlKey: 7, sizes: [8_000, 9_000] }]).tooLarge).toEqual([]);
    expect(AC_HOST_MAX_BODY_BYTES).toBe(2 * MB);
  });
});

const bucket = (sizes: Record<string, number>) => ({
  SO_ITEM_PHOTOS: {
    get: async (k: string) => (sizes[k] === undefined ? null : { arrayBuffer: async () => new Uint8Array(sizes[k]).buffer }),
  },
});

describe('attachPhotos', () => {
  test('the oversized line sends no Photos key, the other line sends all of its own, and the note names the line', async () => {
    const body = { DocType: 'SO', DocNo: 'SO-013496', Header: {}, Lines: [{ DtlKey: 101 }, { DtlKey: 102 }] };
    const note = await attachPhotos(bucket({ big: Math.round(4.2 * MB), a: 30_000, b: 20_000 }), body, [
      { dtlKey: 101, keys: ['big'] },
      { dtlKey: 102, keys: ['a', 'b'] },
    ], 'SO HC-SO-013496');

    expect(body.Lines[0]).not.toHaveProperty('Photos');
    expect((body.Lines[1] as { Photos?: unknown[] }).Photos).toHaveLength(2);
    expect(note).toMatch(new RegExp(`^${PHOTOS_NOT_SENT_PREFIX}`));
    expect(note).toContain('line 101 (4.20 MB)');
  });

  test('everything fits: no note', async () => {
    const body = { Lines: [{ DtlKey: 5 }] };
    expect(await attachPhotos(bucket({ a: 1_000 }), body, [{ dtlKey: 5, keys: ['a'] }], 'SO X')).toBeNull();
    expect((body.Lines[0] as { Photos?: unknown[] }).Photos).toHaveLength(1);
  });

  test('an unreadable picture drops its line quietly, as before, and is not reported as too large', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const body = { Lines: [{ DtlKey: 5 }] };
    expect(await attachPhotos(bucket({ a: 1_000 }), body, [{ dtlKey: 5, keys: ['a', 'gone'] }], 'SO X')).toBeNull();
    expect(body.Lines[0]).not.toHaveProperty('Photos');
    warn.mockRestore();
  });

  test('a WebP picture is dropped so the whole edit is not lost to "Parameter is not valid.", and the note names it (HC-SO-2609-080)', async () => {
    const body = { Lines: [{ DtlKey: 5 }] };
    const note = await attachPhotos(bucket({ 'a.webp': 1_000 }), body, [{ dtlKey: 5, keys: ['a.webp'] }], 'SO X');
    expect(body.Lines[0]).not.toHaveProperty('Photos');
    expect(note?.startsWith(PHOTOS_BAD_FORMAT_PREFIX)).toBe(true);
    expect(note).toContain('line 5 (webp)');
  });

  test('a JPEG beside a WebP still goes; only the WebP is dropped', async () => {
    const body = { Lines: [{ DtlKey: 5 }] };
    const note = await attachPhotos(bucket({ 'ok.jpg': 1_000, 'bad.webp': 1_000 }), body, [{ dtlKey: 5, keys: ['ok.jpg', 'bad.webp'] }], 'SO X');
    expect((body.Lines[0] as { Photos?: unknown[] }).Photos).toHaveLength(1);
    expect(note).toContain('line 5 (webp)');
  });
});
