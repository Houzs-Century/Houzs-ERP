import { describe, expect, test } from 'vitest';
import { caseAddressError, caseAddressFourLines, caseAddressLines, formatCaseAddress, postcodeInLines } from './assr-case-address';

/* Owner 2026-11-17: a service case's address prints in the SO's shape — lines,
   "<postcode> <city>", state — on every surface, and an old case whose lines
   already hold the postcode never prints it twice. */
describe('the case address in the SO shape', () => {
  const lines = { addr1: '1-G-9 Halaman Teratai', addr2: 'Lebuh Nipah 2', addr3: null, addr4: null };

  test('lines, then postcode + city, then state', () => {
    expect(caseAddressLines({ ...lines, postcode: '11900', city: 'Bayan Lepas', state: 'Pulau Pinang' }))
      .toEqual(['1-G-9 Halaman Teratai', 'Lebuh Nipah 2', '11900 Bayan Lepas', 'Pulau Pinang']);
  });

  test('an old case whose lines name the postcode / city / state does not repeat them', () => {
    const old = { addr1: '1-G-9 Halaman Teratai', addr2: 'lebuh nipah 2', addr3: '11900 Bayan Lepas', addr4: null };
    expect(formatCaseAddress({ ...old, postcode: '11900', city: 'Bayan Lepas', state: 'Pulau Pinang' }))
      .toBe('1-G-9 Halaman Teratai, lebuh nipah 2, 11900 Bayan Lepas, Pulau Pinang');
    expect(formatCaseAddress({ ...old, addr4: 'PULAU PINANG', postcode: '11900', city: 'bayan lepas', state: 'Pulau Pinang' }))
      .toBe('1-G-9 Halaman Teratai, lebuh nipah 2, 11900 Bayan Lepas, PULAU PINANG');
  });

  test('a postcode inside a longer number is not taken as named', () => {
    expect(formatCaseAddress({ addr1: 'Lot 119001', postcode: '11900' })).toBe('Lot 119001, 11900');
  });

  test('a case with no postcode / city / state prints its lines as before; nothing at all is null', () => {
    expect(formatCaseAddress(lines)).toBe('1-G-9 Halaman Teratai, Lebuh Nipah 2');
    expect(formatCaseAddress({ addr1: ' ', postcode: null })).toBeNull();
  });

  test('four cells: overflow shares line 3 so the state stays last', () => {
    expect(caseAddressFourLines({ addr1: 'A', addr2: 'B', addr3: 'C', addr4: null, postcode: '47300', city: 'Petaling Jaya', state: 'Selangor' }))
      .toEqual(['A', 'B', 'C, 47300 Petaling Jaya', 'Selangor']);
    expect(caseAddressFourLines({ addr1: 'A' })).toEqual(['A', null, null, null]);
  });

  test('the postcode an old case types in its lines', () => {
    expect(postcodeInLines({ addr1: 'x', addr2: null, addr3: '11900 Bayan Lepas', addr4: null })).toBe('11900');
    expect(postcodeInLines({ addr1: 'x' })).toBeNull();
  });

  test('the API refuses a non-text or over-long part, and accepts null', () => {
    expect(caseAddressError({ postcode: 11900 })).toBe('Postcode must be text.');
    expect(caseAddressError({ city: 'x'.repeat(81) })).toBe('City is longer than 80 characters.');
    expect(caseAddressError({ postcode: null, city: 'Bayan Lepas', state: 'Pulau Pinang' })).toBeNull();
  });
});
