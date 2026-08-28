import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isPoOwnedPhotoKey,
  PO_PHOTO_KEY_PREFIX,
  poItemPhotoKey,
} from '../src/scm/routes/purchase-order-item-photos';

/**
 * The ownership split is the whole design (owner 2026-08-28): one photo_urls
 * column now holds SO-carried keys (so-items/..., mig 0274 — SAME R2 objects,
 * SO-owned) and PO-authored keys (po-items/... — this route's uploads plus the
 * AutoCount importer's historical keys). The PO may delete only its own.
 */
describe('PO photo key ownership', () => {
  it('po-items keys are PO-owned; carried so-items keys are not', () => {
    expect(isPoOwnedPhotoKey('po-items/po-1/it-1/abc.jpg')).toBe(true);
    expect(isPoOwnedPhotoKey('so-items/HC-SO-2608-021/it-1/abc.jpg')).toBe(false);
    expect(isPoOwnedPhotoKey('')).toBe(false);
    expect(isPoOwnedPhotoKey('slips/whatever.jpg')).toBe(false);
  });

  it('minted keys land under the PO prefix with the id path and extension', () => {
    expect(poItemPhotoKey('po-1', 'it-2', 'uuid-3', 'jpg')).toBe('po-items/po-1/it-2/uuid-3.jpg');
    expect(poItemPhotoKey('po-1', 'it-2', 'uuid-3', 'jpg').startsWith(PO_PHOTO_KEY_PREFIX)).toBe(true);
  });
});

/* Source-shape pins, same pattern as assrSearchSoLinkedAcDocno.test.ts: the
   scm harness rides Supabase Postgres, so the handlers cannot execute here —
   pin the load-bearing lines instead, with self-asserting anchors so a moved
   handler fails loudly rather than scanning nothing (CLAUDE.md trap 3). */
const SRC = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/scm/routes/purchase-order-item-photos.ts'),
  'utf8',
);

describe('handler source pins', () => {
  it('the DELETE handler refuses carried (non-PO-owned) keys with the named reason', () => {
    const start = SRC.indexOf("purchaseOrderItemPhotos.delete(");
    expect(start, 'the DELETE registration is gone — re-point this scan').toBeGreaterThan(-1);
    const body = SRC.slice(start);
    expect(body).toContain('isPoOwnedPhotoKey(photoKey)');
    expect(body).toContain("'carried_photo_readonly'");
  });

  it('both writes re-state the parent predicate on the UPDATE itself', () => {
    const updates = SRC.split(".update({ photo_urls: nextKeys })");
    expect(updates.length, 'expected exactly two photo_urls updates (upload append + delete filter)').toBe(3);
    for (const after of updates.slice(1)) {
      expect(after.slice(0, 200)).toContain(".eq('purchase_order_id', poId)");
    }
  });

  it('the upload path stores the client thumbnail the PO PDF prints', () => {
    expect(SRC).toContain('putOptionalThumb(');
  });
});
