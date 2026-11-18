import { describe, expect, test } from 'vitest';
import { caseAddressFromSo } from '../src/services/assrSoContext';
import { assrBoardLocation } from '../src/scm/lib/assr-board-scope';

/* Owner 2026-11-17: picking the SO fills the case's address in the SO's shape. */
describe('caseAddressFromSo — an order address as the case stores it', () => {
  test('an ERP order: street lines + its postcode / city / state; the stale town line is dropped', () => {
    expect(caseAddressFromSo({
      address1: '1-G-9 Halaman Teratai', address2: 'Lebuh Nipah 2', address3: '51200 Kuala Lumpur', address4: 'Kuala Lumpur',
      postcode: '11900', city: 'Bayan Lepas', customer_state: 'Pulau Pinang',
    })).toEqual({
      addr1: '1-G-9 Halaman Teratai', addr2: 'Lebuh Nipah 2', addr3: null, addr4: null,
      postcode: '11900', city: 'Bayan Lepas', state: 'Pulau Pinang',
    });
  });

  test('an AutoCount-mirror order (lines only): lines kept, postcode and state lifted out of them', () => {
    expect(caseAddressFromSo({
      address1: '1-G-9 Halaman Teratai', address2: 'lebuh nipah 2', address3: '11900 Bayan Lepas', address4: 'PENANG',
      postcode: null, city: null, customer_state: null,
    })).toEqual({
      addr1: '1-G-9 Halaman Teratai', addr2: 'lebuh nipah 2', addr3: '11900 Bayan Lepas', addr4: 'PENANG',
      postcode: '11900', city: null, state: 'Pulau Pinang',
    });
  });

  test('no address at all is null', () => {
    expect(caseAddressFromSo({ address1: '', address2: null, address3: null, address4: null, postcode: null, city: null, customer_state: null })).toBeNull();
  });
});

describe('assrBoardLocation — the DP board prefers the case\'s own postcode / state', () => {
  test('own values first', () => {
    expect(assrBoardLocation('47300 Petaling Jaya', 'Selangor', 'Johor', '81200', { postcode: '11900', state: 'Penang' }))
      .toEqual({ postcode: '11900', state: 'Pulau Pinang' });
  });
  test('none of its own: address lines, then the SO, as before', () => {
    expect(assrBoardLocation('47300 Petaling Jaya', 'Selangor', 'Johor', '81200', { postcode: null, state: null }))
      .toEqual({ postcode: '47300', state: 'Selangor' });
    expect(assrBoardLocation(null, null, 'Johor', '81200', null)).toEqual({ postcode: '81200', state: 'Johor' });
  });
});
