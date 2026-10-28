// ----------------------------------------------------------------------------
// THE PO'S LINE EDITOR MUST OFFER PHOTOS, and it did not.
//
// The owner, 2026-08-28, on the screen a purchaser is actually on when they want
// to attach a photo: 「还是不能添加照片啊」. #2759 had already put the strip on the
// PO's TABLE view and given the server its upload and delete routes — the rich
// line editor was the gap.
//
// The cause is worth a test rather than a comment: PoLineCard was extracted as
// "the same SHAPE as SoLineCard" — a copy of the layout, not a use of the
// component — so the photo rail SoLineCard grew afterwards never arrived here.
// Two cards that look alike and drift apart is the shape of this defect, and it
// will recur the next time one of them grows something.
//
// Read from source rather than rendered: the assertion is about which surfaces
// WIRE the control, which is exactly what went missing, and a render test of one
// card cannot see that the other one lacks it.
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(resolve(here, p), 'utf8');

const CARD = read('./PoLineCard.tsx');
const EDIT = read('../../../pages/scm-v2/PurchaseOrderDetail.tsx');
const TABLE = read('../../../pages/scm-v2/PurchaseOrderDetailV2.tsx');

describe('a PO line offers photos wherever it is editable', () => {
  test('the card takes a photo slot', () => {
    expect(CARD).toContain('photos?: React.ReactNode');
    expect(CARD).toContain('{photos}');
  });

  test('the EDIT screen fills it — the one that was missing', () => {
    expect(EDIT).toContain('<SoLinePhotoStrip');
    expect(EDIT).toContain('source="po"');
    expect(EDIT).toContain('uploadPoItemPhoto');
    expect(EDIT).toContain('deletePoItemPhoto');
  });

  test('BOTH surfaces gate on the same cohort and the same key ownership', () => {
    /* Two screens writing to one column must not disagree about who may write
       or about which keys they own — a carried SO key is managed on the Sales
       Order and the server refuses its deletion either way. */
    for (const [name, src] of [['edit', EDIT], ['table', TABLE]] as const) {
      expect(src, `${name} must use the shared cohort gate`).toContain('canOperatePurchaseOrders');
      expect(src, `${name} must use the shared key-ownership test`).toContain('isPoOwnedPhotoKey');
    }
  });

  test('a line with no id is TOLD why, not silently left without a rail', () => {
    /* The photo key is `po-items/<po>/<item id>/…`, so an unsaved line has
       nowhere to put one. Saying so is the whole point: a rail that is simply
       absent is what sent the owner looking for it. */
    expect(EDIT).toContain('Save this line first');
  });

  test('the card itself knows nothing about documents or permissions', () => {
    /* The slot is a node so the card stays a layout. If it ever grows an
       upload of its own there will be two, and they will drift. */
    expect(CARD).not.toContain('uploadPoItemPhoto');
    expect(CARD).not.toContain('canOperatePurchaseOrders');
  });
});
