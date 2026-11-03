import { describe, expect, test } from 'vitest';
import { orderAddressLines, soStreetTail } from './order-address';

/* 2990-0036 (2990-SO-2611-009): the POS sent the whole address as address1 and
   the save spilled its end into address3, which the SO print left out. */
describe('a street that runs on into lines 3 and 4 prints', () => {
  const SPILLED = {
    address1: "A-05-07, D'Clover Residences, A-UG1-11,", address2: 'Dataran Sentral Damansara, No 3,',
    address3: 'Jalan PJU 8/8B', address4: null,
    postcode: '47820', city: 'Petaling Jaya', customer_state: 'Selangor',
  };

  test('line 3 follows line 2, then the locality', () => {
    expect(orderAddressLines(SPILLED)).toEqual([
      "A-05-07, D'Clover Residences, A-UG1-11,",
      'Dataran Sentral Damansara, No 3,',
      'Jalan PJU 8/8B',
      '47820 Petaling Jaya Selangor',
    ]);
  });

  test('a cutover town line naming the postcode is not street', () => {
    expect(soStreetTail({
      address1: 'No 1', address3: '51200 Kuala Lumpur', address4: 'Kuala Lumpur',
      postcode: '51200', city: 'Kuala Lumpur',
    })).toEqual([]);
  });

  test('a legacy row with no postcode keeps address3 as the city', () => {
    expect(orderAddressLines({ address1: 'No 1', address3: 'Ipoh', address4: '30000' }))
      .toEqual(['No 1', '30000 Ipoh']);
  });
});
