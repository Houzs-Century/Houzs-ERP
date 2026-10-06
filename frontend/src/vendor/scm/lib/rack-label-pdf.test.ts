import { describe, expect, it } from 'vitest';
import {
  LABELS_PER_PAGE,
  RACK_LABEL_MM,
  rackLabelCell,
  rackLabelsInPrintOrder,
} from './rack-label-pdf';
import { RACK_QR_PREFIX, rackQrPayload } from './rack-qr';

describe('rack label sheet', () => {
  it('encodes the rack LABEL behind the shelf prefix, not a row id', () => {
    expect(rackQrPayload(' L12.1 ')).toBe(`${RACK_QR_PREFIX}L12.1`);
  });

  it('prints in natural rack order and drops blank labels', () => {
    expect(rackLabelsInPrintOrder(['L10.1', 'L2.2', '  ', 'L2.1', 'R1.1'])).toEqual(['L2.1', 'L2.2', 'L10.1', 'R1.1']);
  });

  it('lays stickers out left-to-right, top-to-bottom, and starts a new page after a full sheet', () => {
    const first = rackLabelCell(0);
    const second = rackLabelCell(1);
    const third = rackLabelCell(2);
    expect(first.page).toBe(0);
    expect(second.y).toBe(first.y);
    expect(second.x).toBeGreaterThan(first.x);
    expect(third.x).toBe(first.x);
    expect(third.y).toBeGreaterThan(first.y);
    expect(rackLabelCell(LABELS_PER_PAGE - 1).page).toBe(0);
    expect(rackLabelCell(LABELS_PER_PAGE)).toEqual({ ...first, page: 1 });
  });

  it('stays under the 60mm beam face it is stuck on', () => {
    expect(RACK_LABEL_MM.h).toBeLessThanOrEqual(60);
    expect(rackLabelCell(LABELS_PER_PAGE - 1).y + RACK_LABEL_MM.h).toBeLessThanOrEqual(297 - 5);
  });

  it('fits the 76-slot KL warehouse on 8 sheets', () => {
    expect(rackLabelCell(75).page + 1).toBe(8);
  });
});
