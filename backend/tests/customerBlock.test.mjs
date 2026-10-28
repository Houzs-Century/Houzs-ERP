// The city rule, pinned. AutoCount has NO city column — `InvAddr4` is the STATE
// — so a city can only be READ out of the address text, and reading is where the
// migration lost 1,935 of them: import-ac-outstanding-so.mjs subtracts the state
// name from the text after the postcode, which deletes the whole value whenever
// the city and the state are the same word.
//
// What these tests pin is not the derivation but its REFUSALS. A rule that says
// yes too often stamps "Selangor" onto thousands of orders as a city; the gate
// is the ERP's own postcode -> city master, and the cases below are the ones
// that decide whether it is doing its job.
import { describe, expect, it } from 'vitest';

import { DO_CARRY, cityFromBook, cityTextOf, postcodeOf, vacant } from '../scripts/lib/customer-block.mjs';

/* scm.my_localities, as the scripts read it: postcode -> the cities it lists. */
const master = new Map([
  ['52200', ['Kuala Lumpur']],
  ['50000', ['Kuala Lumpur']],
  ['40000', ['Shah Alam']],
  ['75000', ['Melaka']],
  ['09600', ['Lunas']],
  ['09000', ['Kulim']],
  ['11900', ['Bayan Lepas']],
]);
const cityOf = (pc) => master.get(String(pc)) ?? [];

describe('cityFromBook', () => {
  it('accepts the city the book states when the address master confirms it', () => {
    const r = cityFromBook('No34,Jalan Cemara 3/3, 52200 Kuala Lumpur, Kuala Lumpur', cityOf);
    expect(r.city).toBe('Kuala Lumpur');
  });

  it('is exactly the case the state subtraction erased — city and state one word', () => {
    // The importer computed "Kuala Lumpur".replace(/Kuala Lumpur/i, "") -> "".
    const r = cityFromBook('1 Jalan X, 75000 Melaka, Melaka', cityOf);
    expect(r.city).toBe('Melaka');
  });

  it('recovers a value the subtraction left as punctuation', () => {
    const r = cityFromBook('1 Jalan X, 50000 KUALA LUMPUR., Kuala Lumpur', cityOf);
    expect(r.city).toBe('Kuala Lumpur'); // the MASTER's spelling, not the book's
  });

  it('trims a trailing state written on the same line', () => {
    const r = cityFromBook('12 Jalan Y, 09600 LUNAS KEDAH, Kedah', cityOf);
    expect(r.city).toBe('Lunas');
  });

  it('REFUSES a state name written where a city goes', () => {
    const r = cityFromBook('3 Jalan Z, 40000 Selangor, Selangor', cityOf);
    expect(r.city).toBeNull();
    expect(r.reason).toMatch(/does not list it/);
  });

  it('REFUSES a postcode with nothing after it — the book has no city', () => {
    const r = cityFromBook('4 Jalan A, 40000, Selangor', cityOf);
    expect(r.city).toBeNull();
    expect(r.reason).toMatch(/nothing after the postcode/);
  });

  it('REFUSES an abbreviation the master does not carry', () => {
    const r = cityFromBook('5 Jalan B, 09000 BALING, Kedah', cityOf);
    expect(r.city).toBeNull();
  });

  it('REFUSES an address with no postcode at all', () => {
    const r = cityFromBook('6 Jalan C, Selangor', cityOf);
    expect(r.city).toBeNull();
    expect(r.reason).toMatch(/no 5-digit postcode/);
  });

  it('REFUSES a postcode the master does not know', () => {
    const r = cityFromBook('7 Jalan D, 99999 Somewhere', cityOf);
    expect(r.city).toBeNull();
    expect(r.reason).toMatch(/not in the address master/);
  });

  it('never invents a city from the postcode alone', () => {
    // 11900 IS in the master, but the book wrote a state where a city goes.
    expect(cityFromBook('8 Jalan E, 11900 PENANG, Penang', cityOf).city).toBeNull();
  });
});

describe('vacant', () => {
  it('treats a value with no letter or digit as absent', () => {
    expect(vacant('.')).toBe(true);
    expect(vacant('  ')).toBe(true);
    expect(vacant(null)).toBe(true);
    expect(vacant('Kuala Lumpur')).toBe(false);
  });
});

describe('the address text helpers', () => {
  it('reads the postcode and the text after it', () => {
    expect(postcodeOf('a, 52200 Kuala Lumpur, b')).toBe('52200');
    expect(cityTextOf('a, 52200 Kuala Lumpur, b')).toBe('Kuala Lumpur');
    expect(cityTextOf('a, no postcode here')).toBeNull();
  });
});

describe('DO_CARRY', () => {
  it('folds the sales order\'s four address lines into the delivery order\'s two', () => {
    const so = { address1: 'No 1 Jalan X', address2: null, address3: '52200 KL', address4: 'Kuala Lumpur' };
    const pick = Object.fromEntries(DO_CARRY);
    expect(pick.address1(so)).toBe('No 1 Jalan X');
    expect(pick.address2(so)).toBe('52200 KL, Kuala Lumpur');
  });

  it('carries no line, quantity, price or payment field', () => {
    const cols = DO_CARRY.map(([c]) => c);
    expect(cols.some((c) => /qty|price|sen|paid|balance|status|item|line/.test(c))).toBe(false);
  });

  it('does not carry venue — canonicalised on write, and not measured here', () => {
    expect(DO_CARRY.map(([c]) => c)).not.toContain('venue');
    expect(DO_CARRY.map(([c]) => c)).not.toContain('venue_id');
  });
});
