// ----------------------------------------------------------------------------
// The shared State / City / Postcode cascade — both directions.
//
// localities-reverse-resolve.test.ts pins the RESOLVERS. This pins the WIRING
// the forms now share: which options each select offers given what is already
// picked, and what the next triple is after each pick. The two properties that
// matter most, and that the hand-copied wiring got wrong:
//   - top-down keeps narrowing: a picked State narrows Postcode too, not only
//     City (the copies fell back to the nationwide pool whenever City was blank)
//   - bottom-up never destroys the pick: the postcode the operator just chose
//     survives the State it back-fills
// ----------------------------------------------------------------------------
import { describe, it, expect } from 'vitest';
import {
  cityOptionsFor,
  postcodeOptionsFor,
  pickState,
  pickCity,
  pickPostcode,
  cityPlaceholder,
  postcodePlaceholder,
} from './address-cascade';
import type { LocalityRow } from './localities-queries';

const row = (postcode: string, city: string, state: string): LocalityRow => ({
  postcode, city, state, stateCode: '', country: 'Malaysia',
});

// "Taman Melati" deliberately sits under TWO states — the ambiguity the
// resolvers refuse to guess at, and that the cascade still has to behave under.
const ROWS: LocalityRow[] = [
  row('43300', 'Seri Kembangan', 'Selangor'),
  row('47810', 'Petaling Jaya', 'Selangor'),
  row('47820', 'Petaling Jaya', 'Selangor'),
  row('50000', 'Kuala Lumpur', 'Wilayah Persekutuan Kuala Lumpur'),
  row('10000', 'George Town', 'Pulau Pinang'),
  row('81100', 'Taman Melati', 'Johor'),
  row('53100', 'Taman Melati', 'Wilayah Persekutuan Kuala Lumpur'),
];

const empty = { state: '', city: '', postcode: '' };

describe('cityOptionsFor', () => {
  it('narrows to the state when one is picked', () => {
    expect(cityOptionsFor(ROWS, 'Selangor')).toEqual(['Petaling Jaya', 'Seri Kembangan']);
  });

  it('offers the cross-state pool when no state is picked, so City can start the cascade', () => {
    expect(cityOptionsFor(ROWS, '')).toContain('George Town');
    expect(cityOptionsFor(ROWS, '')).toContain('Seri Kembangan');
  });
});

describe('postcodeOptionsFor', () => {
  it('narrows to the (state, city) pair when both are picked', () => {
    expect(postcodeOptionsFor(ROWS, 'Selangor', 'Petaling Jaya')).toEqual(['47810', '47820']);
  });

  /* The regression the hand-copied wiring carried: with a State picked and City
     still blank every copy showed the NATIONWIDE list, so top-down narrowed
     City but not Postcode. */
  it('still narrows to the STATE when only the state is picked', () => {
    expect(postcodeOptionsFor(ROWS, 'Selangor', '')).toEqual(['43300', '47810', '47820']);
    expect(postcodeOptionsFor(ROWS, 'Selangor', '')).not.toContain('50000');
  });

  it('narrows to the city name when the city is ambiguous and left the state blank', () => {
    expect(postcodeOptionsFor(ROWS, '', 'Taman Melati')).toEqual(['53100', '81100']);
  });

  it('offers everything when nothing is picked, so Postcode can start the cascade', () => {
    expect(postcodeOptionsFor(ROWS, '', '')).toHaveLength(7);
  });
});

describe('pickState', () => {
  it('resets City and Postcode — they belonged to the old state', () => {
    expect(pickState('Johor')).toEqual({ state: 'Johor', city: '', postcode: '' });
  });
});

describe('pickCity — bottom-up', () => {
  it('back-fills the State from an unambiguous city', () => {
    expect(pickCity(ROWS, empty, 'George Town')).toEqual({
      state: 'Pulau Pinang', city: 'George Town', postcode: '',
    });
  });

  it('REFUSES to guess a state for a city shared by two states', () => {
    expect(pickCity(ROWS, empty, 'Taman Melati')).toEqual({
      state: '', city: 'Taman Melati', postcode: '',
    });
  });

  it('leaves an already-picked State alone when the city does not contradict it', () => {
    const cur = { state: 'Selangor', city: 'Seri Kembangan', postcode: '43300' };
    expect(pickCity(ROWS, cur, 'Petaling Jaya').state).toBe('Selangor');
  });

  it('corrects the State when the city unambiguously names a different one', () => {
    const cur = { state: 'Selangor', city: 'Petaling Jaya', postcode: '47810' };
    expect(pickCity(ROWS, cur, 'George Town').state).toBe('Pulau Pinang');
  });

  it('clears the Postcode, which belonged to the previous city', () => {
    const cur = { state: 'Selangor', city: 'Petaling Jaya', postcode: '47810' };
    expect(pickCity(ROWS, cur, 'Seri Kembangan').postcode).toBe('');
  });

  it('keeps an unknown city verbatim without touching the State', () => {
    const cur = { state: 'Johor', city: '', postcode: '' };
    expect(pickCity(ROWS, cur, 'Nowhere')).toEqual({ state: 'Johor', city: 'Nowhere', postcode: '' });
  });
});

describe('pickPostcode — bottom-up', () => {
  it('back-fills State AND City, and KEEPS the postcode just picked', () => {
    expect(pickPostcode(ROWS, empty, '43300')).toEqual({
      state: 'Selangor', city: 'Seri Kembangan', postcode: '43300',
    });
  });

  /* The trap PR #2117 called out: routing the back-filled State through the
     State picker's own handler would clear City and Postcode, so the operator
     watches the value they just chose disappear. */
  it('does not wipe itself when the resolved state differs from the current one', () => {
    const cur = { state: 'Johor', city: 'Taman Melati', postcode: '81100' };
    expect(pickPostcode(ROWS, cur, '10000')).toEqual({
      state: 'Pulau Pinang', city: 'George Town', postcode: '10000',
    });
  });

  it('keeps an unknown postcode and leaves State and City untouched (no guess)', () => {
    const cur = { state: 'Selangor', city: 'Petaling Jaya', postcode: '' };
    expect(pickPostcode(ROWS, cur, '99999')).toEqual({
      state: 'Selangor', city: 'Petaling Jaya', postcode: '99999',
    });
  });

  it('clearing the Postcode leaves the rest of the address standing', () => {
    const cur = { state: 'Selangor', city: 'Petaling Jaya', postcode: '47810' };
    expect(pickPostcode(ROWS, cur, '')).toEqual({
      state: 'Selangor', city: 'Petaling Jaya', postcode: '',
    });
  });
});

describe('placeholders advertise the field as a starting point', () => {
  it('says the State will fill in when City is the first thing picked', () => {
    expect(cityPlaceholder('')).toBe('Pick city — State fills in');
    expect(cityPlaceholder('Selangor')).toBe('Pick city');
  });

  it('names exactly the fields a Postcode pick will fill', () => {
    expect(postcodePlaceholder('', '')).toBe('Pick postcode — State and City fill in');
    expect(postcodePlaceholder('Selangor', '')).toBe('Pick postcode — City fills in');
    expect(postcodePlaceholder('Selangor', 'Petaling Jaya')).toBe('Pick postcode');
  });
});

describe('a round trip through both directions agrees with itself', () => {
  /* The two directions read the SAME my_localities rows, so a postcode picked
     bottom-up must land on a state/city pair the top-down lists would offer. */
  it('bottom-up lands on a triple top-down would have produced', () => {
    const viaPostcode = pickPostcode(ROWS, empty, '47810');
    expect(cityOptionsFor(ROWS, viaPostcode.state)).toContain(viaPostcode.city);
    expect(postcodeOptionsFor(ROWS, viaPostcode.state, viaPostcode.city)).toContain(viaPostcode.postcode);
  });
});
