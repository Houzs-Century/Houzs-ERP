import { describe, expect, test } from 'vitest';
import { bpsToPct, chargeText, pctToBps, readDoCharge } from './doCharge';

describe('a charge on each delivery order, on the card', () => {
  test('a typed % is kept in basis points and shown back as typed', () => {
    expect(pctToBps('9')).toBe(900);
    expect(pctToBps('6.5')).toBe(650);
    expect(pctToBps(' ')).toBe(0);
    expect(pctToBps('9.123')).toBeNull();
    expect(pctToBps('101')).toBeNull();
    expect(pctToBps('nine')).toBeNull();
    expect(bpsToPct(650)).toBe('6.5');
    expect(bpsToPct(0)).toBe('');
  });

  test('reads as the % of goods, the amount per DO, or both', () => {
    expect(chargeText({ bps: 900, amountSen: 0 })).toBe('9% of goods');
    expect(chargeText({ bps: 0, amountSen: 3_000 })).toBe('RM 30.00 per DO');
    expect(chargeText({ bps: 600, amountSen: 3_000 })).toBe('6% of goods + RM 30.00 per DO');
  });

  test('needs a name and something to charge', () => {
    expect(readDoCharge({ name: ' SST ', pct: '9', rm: '' })).toEqual({ ok: true, rule: { label: 'SST', bps: 900, amountSen: 0 } });
    expect(readDoCharge({ name: 'Permit', pct: '', rm: '30' })).toEqual({ ok: true, rule: { label: 'Permit', bps: 0, amountSen: 3_000 } });
    expect(readDoCharge({ name: '', pct: '9', rm: '' }).ok).toBe(false);
    expect(readDoCharge({ name: 'SST', pct: '', rm: '' }).ok).toBe(false);
    expect(readDoCharge({ name: 'SST', pct: 'x', rm: '' }).ok).toBe(false);
    expect(readDoCharge({ name: 'SST', pct: '', rm: '-1' }).ok).toBe(false);
  });
});
