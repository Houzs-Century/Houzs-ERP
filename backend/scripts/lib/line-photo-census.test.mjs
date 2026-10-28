/**
 * node --test backend/scripts/lib/line-photo-census.test.mjs
 *
 * Zero dependencies, so it runs on a bare checkout.
 * NO SHEBANG — see the header of line-photo-keys.mjs.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compareCensus, missingDtlKeyFile } from './line-photo-census.mjs';

/** One book line: the document, the line key, and how many pictures it holds. */
const L = (doc, dtl, pics = 1) => ({ DocNo: doc, DtlKey: dtl, pics });
/** One manifest row — the shape export-ac-line-photos.py writes. */
const M = (doc, dtl, n = 1) => ({ DocNo: doc, DtlKey: dtl, file: `${doc}__${dtl}_${n}.jpg` });

test('a book line we hold in full is neither missing nor partial', () => {
  const r = compareCensus({
    bookLines: [L('SO-1', 100)],
    manifestRows: [M('SO-1', 100)],
    filesOnDisk: new Set(['SO-1__100_1.jpg']),
  });
  assert.equal(r.bookLines, 1);
  assert.equal(r.bookPictures, 1);
  assert.equal(r.heldLines, 1);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.partial, []);
});

test('a book line with no manifest row at all is MISSING', () => {
  const r = compareCensus({
    bookLines: [L('SO-1', 100), L('SO-2', 200)],
    manifestRows: [M('SO-1', 100)],
    filesOnDisk: new Set(['SO-1__100_1.jpg']),
  });
  assert.equal(r.bookLines, 2);
  assert.equal(r.heldLines, 1);
  assert.deepEqual(r.missing.map((m) => m.DtlKey), [200]);
});

test('the count is of LINES, and a multi-picture line is still ONE line', () => {
  // The PO side really does this: 152 lines carrying up to 5 pictures each.
  const r = compareCensus({
    bookLines: [L('PO-9', 300, 3)],
    manifestRows: [M('PO-9', 300, 1), M('PO-9', 300, 2), M('PO-9', 300, 3)],
    filesOnDisk: new Set(['PO-9__300_1.jpg', 'PO-9__300_2.jpg', 'PO-9__300_3.jpg']),
  });
  assert.equal(r.bookLines, 1);
  assert.equal(r.bookPictures, 3);
  assert.equal(r.heldLines, 1);
  assert.deepEqual(r.missing, []);
});

test('holding SOME pictures of a line is PARTIAL, not held and not missing', () => {
  const r = compareCensus({
    bookLines: [L('PO-9', 300, 3)],
    manifestRows: [M('PO-9', 300, 1)],
    filesOnDisk: new Set(['PO-9__300_1.jpg']),
  });
  assert.equal(r.heldLines, 0);
  assert.deepEqual(r.missing, []);
  assert.equal(r.partial.length, 1);
  assert.equal(r.partial[0].have, 1);
  assert.equal(r.partial[0].pics, 3);
});

/* THE 0668 CLASS. A manifest row is a record of what was DECODED, never of
   what exists on disk or in the bucket. A census that counts manifest rows as
   "held" repeats the bug that attached 30 addresses when 21 objects existed. */
test('a manifest row whose JPEG is not on disk does NOT count as held', () => {
  const r = compareCensus({
    bookLines: [L('SO-1', 100)],
    manifestRows: [M('SO-1', 100)],
    filesOnDisk: new Set(),
  });
  assert.equal(r.heldLines, 0);
  assert.deepEqual(r.missing.map((m) => m.DtlKey), [100]);
  assert.equal(r.manifestWithoutFile.length, 1);
});

test('a manifest row for a line the book no longer shows is reported, not deleted', () => {
  const r = compareCensus({
    bookLines: [L('SO-1', 100)],
    manifestRows: [M('SO-1', 100), M('SO-GONE', 999)],
    filesOnDisk: new Set(['SO-1__100_1.jpg', 'SO-GONE__999_1.jpg']),
  });
  assert.deepEqual(r.manifestNotInBook.map((m) => m.DtlKey), [999]);
  assert.equal(r.missing.length, 0);
});

/* The checkpoint bug (0655) in one assertion: a picture pasted onto an OLD
   line keeps that line's low DtlKey, so a census that is right must find it
   BELOW the highest key already exported. */
test('a missing line BELOW the highest held key is still found', () => {
  const r = compareCensus({
    bookLines: [L('SO-old', 802568), L('SO-new', 926836)],
    manifestRows: [M('SO-new', 926836)],
    filesOnDisk: new Set(['SO-new__926836_1.jpg']),
  });
  assert.deepEqual(r.missing.map((m) => m.DtlKey), [802568]);
});

test('the DtlKey file is what export-ac-line-photos.py DTLKEY_FILE reads', () => {
  const txt = missingDtlKeyFile({
    so: [{ DocNo: 'SO-2', DtlKey: 200 }],
    po: [{ DocNo: 'PO-9', DtlKey: 300 }],
  });
  const rows = txt.split('\n').filter((l) => l && !l.startsWith('#'));
  assert.deepEqual(rows, ['so 200', 'po 300']);
});

test('an empty census produces an empty key file, and says so rather than lying', () => {
  const r = compareCensus({ bookLines: [], manifestRows: [], filesOnDisk: new Set() });
  assert.equal(r.bookLines, 0);
  assert.deepEqual(r.missing, []);
  assert.equal(missingDtlKeyFile({ so: [], po: [] }).split('\n').filter((l) => l && !l.startsWith('#')).length, 0);
});
