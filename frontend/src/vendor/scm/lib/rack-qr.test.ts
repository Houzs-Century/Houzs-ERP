import { describe, expect, it } from 'vitest';
import { rackQrPayload, rackScanRefusal, resolveRackScan } from './rack-qr';

const racks = [
  { id: 'r1', rack: 'L12.1' },
  { id: 'r2', rack: 'L12.2' },
];

describe('resolveRackScan', () => {
  it('round-trips the printed payload to the rack row in this warehouse', () => {
    expect(resolveRackScan(rackQrPayload('L12.2'), racks)).toEqual({ kind: 'ok', rackId: 'r2', label: 'L12.2' });
  });

  it('tolerates case and stray whitespace from the camera', () => {
    expect(resolveRackScan('  hzrack: l12.1 ', racks)).toEqual({ kind: 'ok', rackId: 'r1', label: 'L12.1' });
  });

  it('refuses a QR that is not a rack sticker, such as a DO scan link', () => {
    const r = resolveRackScan('https://erp.example/d/abc', racks);
    expect(r).toEqual({ kind: 'not_rack' });
    expect(rackScanRefusal({ kind: 'not_rack' })).toBe('That is not a rack label.');
    expect(resolveRackScan('HZRACK:', racks)).toEqual({ kind: 'not_rack' });
  });

  it('names the rack when the sticker belongs to another warehouse', () => {
    const r = resolveRackScan('HZRACK:R3.1', racks);
    expect(r).toEqual({ kind: 'not_here', label: 'R3.1' });
    if (r.kind !== 'ok') expect(rackScanRefusal(r)).toContain('R3.1');
  });

  it('will not guess when the same label is listed twice', () => {
    expect(resolveRackScan('HZRACK:L12.1', [...racks, { id: 'r9', rack: 'L12.1' }])).toEqual({ kind: 'ambiguous', label: 'L12.1' });
  });
});
