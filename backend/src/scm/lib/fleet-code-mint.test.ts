import { describe, expect, it } from 'vitest';
import { nextCode, isMintedShape, CODE_PREFIX } from './fleet-code-mint';


describe('nextCode', () => {
  it('starts at 001 on an empty roster', () => {
    expect(nextCode('DRV', [])).toBe('DRV-001');
  });

  it('reads BOTH padding schemes and takes the real highest', () => {
    const live = ['DRV-001', 'DRV-002', 'DRV-003', 'DRV-004', 'DRV-005', 'DRV-006', 'DRV-007',
                  'DRV-05', 'DRV-050', 'DRV-06', 'DRV-07', 'DRV-08', 'DRV-09'];
    expect(nextCode('DRV', live)).toBe('DRV-051');
  });

  it('ignores hand-typed junk instead of stopping or counting it as zero', () => {
    expect(nextCode('DRV', ['DRV-004', 'DRV-TEMP', '', null, undefined, 'ABC-999'])).toBe('DRV-005');
  });

  it('is case-insensitive — drv-012 still holds the number', () => {
    expect(nextCode('DRV', ['drv-012'])).toBe('DRV-013');
  });

  it('a roster of only junk still starts at 001', () => {
    expect(nextCode('HLP', ['HLP-', 'HLP-abc', 'nonsense'])).toBe('HLP-001');
  });

  it('grows past the padding rather than wrapping or truncating', () => {
    expect(nextCode('DRV', ['DRV-999'])).toBe('DRV-1000');
    expect(nextCode('DRV', ['DRV-1000'])).toBe('DRV-1001');
  });

  it('does not confuse one prefix for another', () => {
    expect(nextCode('HLP', ['DRV-500', 'HLP-002'])).toBe('HLP-003');
    expect(nextCode('3PL', ['3PL-0007'])).toBe('3PL-008');
  });

  it('refuses to be pushed past a safe integer by a silly code', () => {
    expect(nextCode('DRV', ['DRV-99999999999999999999', 'DRV-004'])).toBe('DRV-005');
  });
});

describe('the four-wide prefixes (mig 0248)', () => {
  it('mints BD and WO four wide, matching the migration backfill', () => {
    expect(nextCode(CODE_PREFIX.BREAKDOWN, [])).toBe('BD-0001');
    expect(nextCode(CODE_PREFIX.WORK_ORDER, [])).toBe('WO-0001');
  });
  it('continues from a backfilled register', () => {
    expect(nextCode(CODE_PREFIX.WORK_ORDER, ['WO-0001', 'WO-0002'])).toBe('WO-0003');
  });
  it('does not widen the three-wide prefixes', () => {
    expect(nextCode(CODE_PREFIX.DRIVER, [])).toBe('DRV-001');
    expect(nextCode(CODE_PREFIX.WORKSHOP, [])).toBe('WS-001');
  });
  it('reads a differently-padded existing code rather than restarting', () => {
    expect(nextCode(CODE_PREFIX.WORK_ORDER, ['WO-7'])).toBe('WO-0008');
  });
  it('past the pad width the number simply gets longer', () => {
    expect(nextCode(CODE_PREFIX.WORK_ORDER, ['WO-9999'])).toBe('WO-10000');
  });
});

describe('isMintedShape', () => {
  it('recognises the shapes we write', () => {
    expect(isMintedShape(CODE_PREFIX.DRIVER, 'DRV-001')).toBe(true);
    expect(isMintedShape(CODE_PREFIX.DRIVER, 'drv-5')).toBe(true);
  });
  it('rejects what a human typed', () => {
    expect(isMintedShape(CODE_PREFIX.DRIVER, 'DRV-TEMP')).toBe(false);
    expect(isMintedShape(CODE_PREFIX.DRIVER, 'Shakti')).toBe(false);
    expect(isMintedShape(CODE_PREFIX.DRIVER, '')).toBe(false);
    expect(isMintedShape(CODE_PREFIX.DRIVER, null)).toBe(false);
  });
});
