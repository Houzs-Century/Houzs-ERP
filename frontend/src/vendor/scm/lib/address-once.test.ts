import { describe, expect, test } from 'vitest';
import { addressOnce } from './address-once';

describe('addressOnce', () => {
  test('drops a City / Postcode the address lines already carry, keeps a new State', () => {
    expect(addressOnce('2775F JALAN INDUSTRI 12,, KAMPUNG BARU SUNGAI BULOH,, 47000 SUNGAI BULOH., Sungai Buloh, 47000, Selangor'))
      .toBe('2775F JALAN INDUSTRI 12, KAMPUNG BARU SUNGAI BULOH, 47000 SUNGAI BULOH, Selangor');
  });

  test('an address without them keeps City, Postcode and State', () => {
    expect(addressOnce('12 Jalan Mawar, Taman Indah, Klang, 41200, Selangor'))
      .toBe('12 Jalan Mawar, Taman Indah, Klang, 41200, Selangor');
  });

  test('matches whole words only: 4700 is not inside 47000', () => {
    expect(addressOnce('Lot 47000 Jalan A, 4700')).toBe('Lot 47000 Jalan A, 4700');
  });

  test('empty and null', () => {
    expect(addressOnce(null)).toBe('');
    expect(addressOnce(' , ,')).toBe('');
  });
});
