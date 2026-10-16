import { describe, expect, it } from 'vitest';
import { fillCollectedBy } from './default-collected-by';

describe('fillCollectedBy (DEV-44)', () => {
  it('fills a blank row with the signed-in salesperson', () => {
    expect(fillCollectedBy([{ collectedBy: '' }], 'me')).toEqual([{ collectedBy: 'me' }]);
  });

  it('keeps a collector someone already picked', () => {
    expect(fillCollectedBy([{ collectedBy: 'other' }], 'me')).toEqual([{ collectedBy: 'other' }]);
  });

  it('leaves a converted row alone (the server sets its collector)', () => {
    const row = { collectedBy: '', convertedFromDocNo: 'HC-SO-1' };
    expect(fillCollectedBy([row], 'me')).toEqual([row]);
  });
});
