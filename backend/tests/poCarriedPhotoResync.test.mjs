// The pure planner behind the PO carried-photo re-sync repair
// (backend/scripts/repair-po-carried-photos.mjs). The script's DB I/O is
// verified by dispatch (plan first); this pins the decision logic — what it
// re-syncs, and that it PRESERVES the PO's own uploads and never touches a line
// whose SO link is gone. docs/bugs/0789.
import { describe, it, expect } from 'vitest';
import { planPhotoResync, verifyPhotoResync } from '../scripts/lib/po-carried-photo-resync.mjs';

const SO_OLD = 'so-items/HC-SO-1/OLD/ac-1.jpg';   // stale carried key (object gone)
const SO_NEW = 'so-items/HC-SO-1/NEW/sketch.jpg'; // the SO line's current photo
const PO_OWN = 'po-items/HC-PO-1/L1/added.jpg';   // the PO's own upload

describe('planPhotoResync — re-align carried PO photos to the current SO line', () => {
  it('replaces a stale carried key with the SO line current photo', () => {
    const { toFix, skipped } = planPhotoResync([
      { poLineId: 'L1', poNumber: 'HC-PO-1', itemCode: 'X', poPhotoUrls: [SO_OLD], soLineExists: true, soPhotoUrls: [SO_NEW] },
    ]);
    expect(toFix).toEqual([{ poLineId: 'L1', poNumber: 'HC-PO-1', itemCode: 'X', from: [SO_OLD], to: [SO_NEW] }]);
    expect(skipped).toEqual([]);
  });

  it('PRESERVES the PO own uploads while re-syncing the carried keys', () => {
    const { toFix } = planPhotoResync([
      { poLineId: 'L1', poNumber: 'HC-PO-1', itemCode: 'X', poPhotoUrls: [PO_OWN, SO_OLD], soLineExists: true, soPhotoUrls: [SO_NEW] },
    ]);
    expect(toFix[0].to).toEqual([PO_OWN, SO_NEW]);
  });

  it('leaves a line already in sync with the SO', () => {
    const { toFix, skipped } = planPhotoResync([
      { poLineId: 'L1', poNumber: 'HC-PO-1', itemCode: 'X', poPhotoUrls: [SO_NEW], soLineExists: true, soPhotoUrls: [SO_NEW] },
    ]);
    expect(toFix).toEqual([]);
    expect(skipped[0].reason).toMatch(/already match/);
  });

  it('does NOT touch a line whose SO link is gone (a different problem)', () => {
    const { toFix, skipped } = planPhotoResync([
      { poLineId: 'L1', poNumber: 'HC-PO-1', itemCode: 'X', poPhotoUrls: [SO_OLD], soLineExists: false, soPhotoUrls: null },
    ]);
    expect(toFix).toEqual([]);
    expect(skipped[0].reason).toMatch(/no longer exists/);
  });

  it('empties a carried-only line when the SO line now has no photos (dead link removed)', () => {
    const { toFix } = planPhotoResync([
      { poLineId: 'L1', poNumber: 'HC-PO-1', itemCode: 'X', poPhotoUrls: [SO_OLD], soLineExists: true, soPhotoUrls: [] },
    ]);
    expect(toFix[0].to).toEqual([]);
  });
});

describe('verifyPhotoResync — the fresh-connection SHAPE check', () => {
  const toFix = [{ poLineId: 'L1', to: [SO_NEW] }];

  it('passes when the fixed line now carries the desired array', () => {
    expect(verifyPhotoResync(toFix, new Map([['L1', [SO_NEW]]]))).toEqual([]);
  });

  it('fails a line the write did not land on', () => {
    expect(verifyPhotoResync(toFix, new Map([['L1', [SO_OLD]]]))).toEqual(['L1']);
  });

  it('fails a line missing from the re-read', () => {
    expect(verifyPhotoResync(toFix, new Map())).toEqual(['L1']);
  });
});
