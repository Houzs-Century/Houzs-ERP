/* Gap review G16: the Delivery Orders Revenue card summed every row on screen,
   cancelled deliveries included. */
import { describe, expect, it } from 'vitest';
import { doRevenueSen } from './do-list-status';

const rows = [
  { status: 'DELIVERED', local_total_sen: 100_00 },
  { status: 'CANCELLED', local_total_sen: 40_00 },
  { status: 'LOADED', local_total_sen: 25_00 },
  { status: 'cancelled', local_total_sen: 5_00 },
  { status: 'DRAFT', local_total_sen: null },
];

describe('doRevenueSen', () => {
  it('leaves cancelled deliveries out on the All tab', () => {
    expect(doRevenueSen(rows, 'all')).toBe(125_00);
  });

  it('counts them on the Cancelled tab, where they are what was asked for', () => {
    expect(doRevenueSen(rows.filter((r) => r.status.toUpperCase() === 'CANCELLED'), 'cancelled')).toBe(45_00);
  });

  it('a status tab sums its own rows', () => {
    expect(doRevenueSen([rows[0]!], 'delivered')).toBe(100_00);
  });
});
