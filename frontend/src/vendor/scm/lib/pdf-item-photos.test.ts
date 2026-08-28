// pdf-item-photos — the pure grouping / packing / page-fit logic behind the
// SO + PO "ITEM PHOTOS · 照片对照" block, plus the fetch-collect and draw
// plumbing driven through stubs (no jsPDF, no canvas, no network needed).
import { describe, expect, it } from 'vitest';

import {
  appendPhotoMarker,
  blobToSquarePdfImage,
  buildPhotoGroups,
  collectPhotoImages,
  drawItemPhotosBlock,
  GROUP_GAP_X_MM,
  GROUP_HEADER_MM,
  groupBoxSize,
  groupGridSize,
  HEADING_MM,
  ITEM_PHOTOS_CJK_TEXT,
  ITEM_PHOTOS_HEADING,
  ITEM_PHOTOS_HEADING_CONT,
  layoutPhotoGroups,
  MAX_THUMBS_PER_ROW,
  PHOTO_MARKER,
  photoKeyOwners,
  photoKeysOf,
  rangeLabel,
  sniffImageMime,
  THUMB_GAP_MM,
  THUMB_MM,
  type PdfDocLike,
  type PdfPhotoImage,
  type PhotoGroup,
} from './pdf-item-photos';

describe('photoKeysOf', () => {
  it('keeps only non-empty strings and tolerates junk', () => {
    expect(photoKeysOf(['a.jpg', '', '  ', 42, null, 'b.jpg'])).toEqual(['a.jpg', 'b.jpg']);
    expect(photoKeysOf(null)).toEqual([]);
    expect(photoKeysOf(undefined)).toEqual([]);
    expect(photoKeysOf('a.jpg')).toEqual([]);
  });
});

describe('appendPhotoMarker', () => {
  it('marks the first line only and copies the rest', () => {
    const input = ['SOFA XAMMAR L(LHF)', 'CG-001 Pearl'];
    expect(appendPhotoMarker(input)).toEqual([`SOFA XAMMAR L(LHF)${PHOTO_MARKER}`, 'CG-001 Pearl']);
    // The input array is not mutated.
    expect(input[0]).toBe('SOFA XAMMAR L(LHF)');
  });

  it('still produces the marker for an empty description', () => {
    expect(appendPhotoMarker([])).toEqual([PHOTO_MARKER.trim()]);
  });
});

describe('buildPhotoGroups (row chips + the consecutive-identical range rule)', () => {
  const row = (code: string, photoKeys: string[]) => ({ code, photoKeys });

  it('keys single groups by the printed row number and drops photo-less rows', () => {
    const groups = buildPhotoGroups([
      row('A', ['p1.jpg']),
      row('B', []),
      row('C', ['p2.jpg']),
    ]);
    expect(groups).toEqual([
      { chip: '#1', code: 'A', photoKeys: ['p1.jpg'] },
      { chip: '#3', code: 'C', photoKeys: ['p2.jpg'] },
    ]);
  });

  it('merges consecutive rows with deep-equal photo lists into ONE range chip', () => {
    const shared = ['build.jpg', 'fabric.jpg'];
    const groups = buildPhotoGroups([
      row('MATT-K', ['m.jpg']),
      row('XAMMAR-L(LHF)', [...shared]),
      row('XAMMAR-2A', [...shared]),
      row('XAMMAR-CNR', [...shared]),
      row('SVC-DELIVERY', []),
    ]);
    expect(groups.map((g) => g.chip)).toEqual(['#1', '#2-4']);
    // The sofa-set shared photo prints ONCE per set.
    expect(groups[1]!.photoKeys).toEqual(shared);
    expect(groups[1]!.code).toBe('XAMMAR');
  });

  it('does not merge equal lists that are not adjacent, nor different orders', () => {
    const groups = buildPhotoGroups([
      row('A', ['x.jpg', 'y.jpg']),
      row('B', ['y.jpg', 'x.jpg']),
      row('C', ['x.jpg', 'y.jpg']),
    ]);
    expect(groups.map((g) => g.chip)).toEqual(['#1', '#2', '#3']);
  });
});

describe('rangeLabel', () => {
  it('uses the meaningful common prefix of a set', () => {
    expect(rangeLabel(['XAMMAR-L(LHF)', 'XAMMAR-2A', 'XAMMAR-CNR'])).toBe('XAMMAR');
  });
  it('falls back to the first code when the prefix is too short', () => {
    expect(rangeLabel(['AB-1', 'CD-2'])).toBe('AB-1');
    expect(rangeLabel(['ONLY'])).toBe('ONLY');
    expect(rangeLabel([])).toBe('');
  });
});

describe('photoKeyOwners', () => {
  it('assigns each key to the first line that lists it and skips id-less rows', () => {
    const owners = photoKeyOwners([
      { id: 'line-1', photoKeys: ['shared.jpg', 'a.jpg'] },
      { id: null, photoKeys: ['orphan.jpg'] },
      { id: 'line-3', photoKeys: ['shared.jpg', 'b.jpg'] },
    ]);
    expect(owners.get('shared.jpg')).toBe('line-1');
    expect(owners.get('b.jpg')).toBe('line-3');
    expect(owners.has('orphan.jpg')).toBe(false);
  });
});

describe('grid + box sizing', () => {
  it('wraps at six thumbs per row', () => {
    expect(groupGridSize(1)).toEqual({ cols: 1, rows: 1 });
    expect(groupGridSize(6)).toEqual({ cols: 6, rows: 1 });
    expect(groupGridSize(7)).toEqual({ cols: 6, rows: 2 });
    expect(groupGridSize(0)).toEqual({ cols: 0, rows: 0 });
  });

  it('sizes the box from the grid plus the header line', () => {
    expect(groupBoxSize(1)).toEqual({ w: THUMB_MM, h: GROUP_HEADER_MM + THUMB_MM });
    expect(groupBoxSize(7)).toEqual({
      w: MAX_THUMBS_PER_ROW * THUMB_MM + (MAX_THUMBS_PER_ROW - 1) * THUMB_GAP_MM,
      h: GROUP_HEADER_MM + 2 * THUMB_MM + THUMB_GAP_MM,
    });
  });
});

describe('layoutPhotoGroups', () => {
  const pageRegion = { x: 14, y: 20, w: 182, bottom: 272 };

  it('flows groups left-to-right and wraps on width', () => {
    const s = { w: 80, h: 31 };
    const { placements, pagesAdded } = layoutPhotoGroups(
      [s, s, s],
      [{ x: 14, y: 100, w: 182, bottom: 272 }],
      pageRegion,
    );
    expect(pagesAdded).toBe(0);
    expect(placements[0]).toEqual({ x: 14, y: 100, page: 0 });
    expect(placements[1]).toEqual({ x: 14 + 80 + GROUP_GAP_X_MM, y: 100, page: 0 });
    // Third does not fit beside the second — wraps below the tallest row.
    expect(placements[2]!.x).toBe(14);
    expect(placements[2]!.y).toBeGreaterThan(100);
    expect(placements[2]!.page).toBe(0);
  });

  it('moves a group that cannot fit vertically WHOLE onto the next page', () => {
    const { placements, pagesAdded, endY } = layoutPhotoGroups(
      [{ w: 54, h: 31 }, { w: 54, h: 59 }],
      [{ x: 14, y: 240, w: 182, bottom: 272 }],
      pageRegion,
    );
    expect(placements[0]).toEqual({ x: 14, y: 240, page: 0 });
    // 240 + 59 > 272 — the whole group moves; nothing splits.
    expect(placements[1]).toEqual({ x: pageRegion.x, y: pageRegion.y, page: 1 });
    expect(pagesAdded).toBe(1);
    expect(endY).toBe(pageRegion.y + 59);
  });

  it('fills a beside-zone first, then wraps below it (the PO sofa case)', () => {
    const side = { x: 120, y: 200, w: 76, bottom: 240 };
    const below = { x: 14, y: 240, w: 182, bottom: 272 };
    const one = { w: 26, h: 31 };
    const { placements, pagesAdded } = layoutPhotoGroups(
      [one, one, one],
      [side, below],
      pageRegion,
    );
    expect(pagesAdded).toBe(0);
    expect(placements[0]).toEqual({ x: 120, y: 200, page: 0 });
    expect(placements[1]).toEqual({ x: 120 + 26 + GROUP_GAP_X_MM, y: 200, page: 0 });
    // Width exhausted in the side zone — the third lands in the below zone.
    expect(placements[2]).toEqual({ x: 14, y: 240, page: 0 });
  });

  it('places a group taller than a whole page rather than looping forever', () => {
    const monster = { w: 166, h: 999 };
    const { placements, pagesAdded } = layoutPhotoGroups(
      [monster],
      [{ x: 14, y: 100, w: 182, bottom: 272 }],
      pageRegion,
    );
    expect(placements).toHaveLength(1);
    expect(placements[0]!.x).toBe(pageRegion.x);
    expect(pagesAdded).toBeGreaterThan(0);
  });
});

describe('sniffImageMime', () => {
  it('recognises the four container signatures and rejects the rest', () => {
    expect(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    const webp = new Uint8Array(12);
    webp.set([0x52, 0x49, 0x46, 0x46], 0);
    webp.set([0x57, 0x45, 0x42, 0x50], 8);
    expect(sniffImageMime(webp)).toBe('image/webp');
    expect(sniffImageMime(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('image/gif');
    expect(sniffImageMime(new Uint8Array([0x00, 0x01, 0x02, 0x03]))).toBeNull();
    expect(sniffImageMime(new Uint8Array([]))).toBeNull();
  });
});

describe('blobToSquarePdfImage', () => {
  it('returns null instead of throwing when decoding is impossible here', async () => {
    // jsdom has no real 2d canvas / createImageBitmap pipeline — the
    // per-photo best-effort contract is "skip, never fail".
    const out = await blobToSquarePdfImage(new Blob([new Uint8Array([1, 2, 3])]));
    expect(out).toBeNull();
  });
});

describe('collectPhotoImages', () => {
  const img: PdfPhotoImage = { dataUrl: 'data:image/jpeg;base64,x', format: 'JPEG' };
  const groups: PhotoGroup[] = [
    { chip: '#1', code: 'A', photoKeys: ['a.jpg', 'shared.jpg'] },
    { chip: '#2-3', code: 'B', photoKeys: ['shared.jpg', 'bad.jpg'] },
  ];

  it('fetches each unique key once and skips failures silently', async () => {
    const fetched: string[] = [];
    const out = await collectPhotoImages(
      groups,
      (key) => {
        fetched.push(key);
        if (key === 'bad.jpg') return Promise.reject(new Error('404'));
        return Promise.resolve(new Blob([key]));
      },
      () => Promise.resolve(img),
      2,
    );
    expect(fetched.sort()).toEqual(['a.jpg', 'bad.jpg', 'shared.jpg']);
    expect([...out.keys()].sort()).toEqual(['a.jpg', 'shared.jpg']);
  });

  it('skips a photo whose transcode returns null (unsupported format)', async () => {
    const out = await collectPhotoImages(
      [{ chip: '#1', code: 'A', photoKeys: ['weird.bin'] }],
      () => Promise.resolve(new Blob(['?'])),
      () => Promise.resolve(null),
    );
    expect(out.size).toBe(0);
  });
});

/* A recording stub for the drawing surface — asserts real behaviour (headings,
   page breaks, tile geometry) without booting jsPDF. */
type Op =
  | { op: 'text'; text: string; x: number; y: number }
  | { op: 'rect'; x: number; y: number; w: number; h: number }
  | { op: 'image'; x: number; y: number; w: number; h: number }
  | { op: 'addPage' };

function stubDoc(): { doc: PdfDocLike; ops: Op[] } {
  const ops: Op[] = [];
  const doc: PdfDocLike = {
    addPage: () => ops.push({ op: 'addPage' }),
    setFont: () => undefined,
    setFontSize: () => undefined,
    setTextColor: () => undefined,
    setDrawColor: () => undefined,
    setLineWidth: () => undefined,
    text: (text, x, y) => ops.push({ op: 'text', text, x, y }),
    rect: (x, y, w, h) => ops.push({ op: 'rect', x, y, w, h }),
    addImage: (_d, _f, x, y, w, h) => ops.push({ op: 'image', x, y, w, h }),
    getTextWidth: (t) => t.length * 1.5,
  };
  return { doc, ops };
}

describe('drawItemPhotosBlock', () => {
  const img: PdfPhotoImage = { dataUrl: 'data:image/jpeg;base64,x', format: 'JPEG' };
  const baseOpts = {
    margin: 14,
    contentW: 182,
    startY: 120,
    pageBottom: 272,
    pageTop: 14,
    side: null,
    onNewPage: null,
  };

  it('draws nothing at all when no photo actually fetched', () => {
    const { doc, ops } = stubDoc();
    const res = drawItemPhotosBlock(
      doc,
      [{ chip: '#1', code: 'A', photoKeys: ['missing.jpg'] }],
      new Map(),
      baseOpts,
    );
    expect(res).toEqual({ drew: false, endY: 120, pagesAdded: 0 });
    expect(ops).toHaveLength(0);
  });

  it('draws the heading, chip, code and one bordered tile per fetched photo', () => {
    const { doc, ops } = stubDoc();
    const images = new Map([['a.jpg', img], ['b.jpg', img]]);
    const res = drawItemPhotosBlock(
      doc,
      [{ chip: '#2', code: 'AKEMI-K', photoKeys: ['a.jpg', 'gone.jpg', 'b.jpg'] }],
      images,
      baseOpts,
    );
    expect(res.drew).toBe(true);
    expect(res.pagesAdded).toBe(0);
    const texts = ops.filter((o): o is Extract<Op, { op: 'text' }> => o.op === 'text');
    expect(texts.map((t) => t.text)).toEqual([ITEM_PHOTOS_HEADING, '#2', 'AKEMI-K']);
    // gone.jpg never fetched — the group renders its two live photos side by
    // side with a thin border each, below the header line.
    const tiles = ops.filter((o) => o.op === 'image');
    const borders = ops.filter((o) => o.op === 'rect');
    expect(tiles).toHaveLength(2);
    expect(borders).toHaveLength(2);
    expect(tiles[0]).toMatchObject({ x: 14, y: 120 + HEADING_MM + GROUP_HEADER_MM, w: THUMB_MM, h: THUMB_MM });
    expect(tiles[1]).toMatchObject({ x: 14 + THUMB_MM + THUMB_GAP_MM, w: THUMB_MM, h: THUMB_MM });
    expect(res.endY).toBe(120 + HEADING_MM + GROUP_HEADER_MM + THUMB_MM);
  });

  it('moves a group that cannot fit to a fresh page with a continued heading and the page hook', () => {
    const { doc, ops } = stubDoc();
    let headerRepaints = 0;
    const sixKeys = ['b1.jpg', 'b2.jpg', 'b3.jpg', 'b4.jpg', 'b5.jpg', 'b6.jpg'];
    const images = new Map([['a.jpg', img], ...sixKeys.map((k) => [k, img] as const)]);
    const res = drawItemPhotosBlock(
      doc,
      [
        { chip: '#1', code: 'A', photoKeys: ['a.jpg'] },
        { chip: '#2', code: 'B', photoKeys: sixKeys },
      ],
      images,
      { ...baseOpts, startY: 230, onNewPage: () => { headerRepaints += 1; } },
    );
    // Group 1 fits at 230 + heading; group 2 (a full six-wide row) cannot fit
    // beside it, and the wrapped row would start below pageBottom — so the
    // WHOLE group moves to an added page.
    expect(res.pagesAdded).toBe(1);
    expect(headerRepaints).toBe(1);
    expect(ops.filter((o) => o.op === 'addPage')).toHaveLength(1);
    const texts = ops.filter((o): o is Extract<Op, { op: 'text' }> => o.op === 'text');
    expect(texts.some((t) => t.text === ITEM_PHOTOS_HEADING_CONT)).toBe(true);
  });

  it('lays the first groups beside the sofa zone and the overflow below it', () => {
    const { doc, ops } = stubDoc();
    const images = new Map([['a.jpg', img], ['b.jpg', img], ['c.jpg', img], ['d.jpg', img]]);
    const side = { x: 120, y: 196, w: 76, bottom: 240 };
    const res = drawItemPhotosBlock(
      doc,
      [
        { chip: '#1', code: 'A', photoKeys: ['a.jpg'] },
        { chip: '#2', code: 'B', photoKeys: ['b.jpg'] },
        { chip: '#3', code: 'C', photoKeys: ['c.jpg', 'd.jpg'] },
      ],
      images,
      { ...baseOpts, startY: 240, side },
    );
    expect(res.drew).toBe(true);
    const texts = ops.filter((o): o is Extract<Op, { op: 'text' }> => o.op === 'text');
    // Heading sits in the beside-zone, not at the left margin.
    expect(texts[0]).toMatchObject({ text: ITEM_PHOTOS_HEADING, x: 120 });
    const tiles = ops.filter((o): o is Extract<Op, { op: 'image' }> => o.op === 'image');
    // #1 and #2 (26mm each + gap) fit beside; #3 (54mm) wraps below full-width.
    expect(tiles[0]!.x).toBe(120);
    expect(tiles[1]!.x).toBe(120 + THUMB_MM + GROUP_GAP_X_MM);
    expect(tiles[2]!.x).toBe(14);
    expect(tiles[2]!.y).toBeGreaterThanOrEqual(240 + GROUP_HEADER_MM);
  });
});

describe('CJK probe text', () => {
  it('carries the heading and the row marker so ensurePdfCjkFont sees them', () => {
    expect(ITEM_PHOTOS_CJK_TEXT).toContain('照片对照');
    expect(ITEM_PHOTOS_CJK_TEXT).toContain('图');
  });
});
