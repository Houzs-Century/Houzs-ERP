// Folding address lines 3 / 4 away (owner 2026-11-18: two lines, then Postcode /
// City / State everywhere). The decision per row is pure; the script only
// reads and writes. Nothing typed may be lost and no filled field overwritten.
import { describe, it, expect } from 'vitest';
import { foldAddressRow, indexLocalities } from '../scripts/lib/fold-address-lines.mjs';
import { addressLineTwoView, repeatsTown } from '../src/scm/shared/address-two-lines.ts';
import { soInvoiceAddress } from '../src/services/autocount-address-fit.ts';

const loc = indexLocalities([
  { postcode: '11900', city: 'Bayan Lepas', state: 'Pulau Pinang' },
  { postcode: '11950', city: 'Bayan Lepas', state: 'Pulau Pinang' },
  { postcode: '43300', city: 'Seri Kembangan', state: 'Selangor' },
]);
const row = (o) => ({ line1: null, line2: null, line3: null, line4: null, postcode: null, city: null, state: null, ...o });

describe('foldAddressRow', () => {
  it('the owner\'s case: "11900 Bayan Lepas" / "Penang" fill empty postcode, city and state; lines 3 / 4 clear', () => {
    const d = foldAddressRow(row({ line1: 'TREED SUNGAI ARA', line3: '11900 Bayan Lepas', line4: 'Penang' }), loc, null);
    expect(d.action).toBe('fold');
    expect(d.next).toEqual({ line1: 'TREED SUNGAI ARA', line2: null, line3: null, line4: null, postcode: '11900', city: 'Bayan Lepas', state: 'Pulau Pinang' });
    expect(d.changed.sort()).toEqual(['city', 'line3', 'line4', 'postcode', 'state']);
  });

  it('lines that repeat the filled postcode / city / state are simply cleared', () => {
    const d = foldAddressRow(row({ line1: 'A', line3: '11900 BAYAN LEPAS', line4: 'Pulau Pinang', postcode: '11900', city: 'Bayan Lepas', state: 'Pulau Pinang' }), loc, null);
    expect(d.action).toBe('fold');
    expect(d.changed.sort()).toEqual(['line3', 'line4']);
  });

  it('an alias of the filled state ("Penang" beside "Pulau Pinang") is not a conflict', () => {
    const d = foldAddressRow(row({ line4: 'Penang', state: 'Pulau Pinang' }), loc, null);
    expect(d.action).toBe('fold');
    expect(d.changed).toEqual(['line4']);
  });

  it('never overwrites: a line 3 postcode that differs from the record\'s is a conflict and the row is left alone', () => {
    const d = foldAddressRow(row({ line3: '11900 Bayan Lepas', postcode: '43300', city: 'Seri Kembangan', state: 'Selangor' }), loc, null);
    expect(d.action).toBe('conflict');
    expect(d.next).toBeUndefined();
  });

  it('free text is appended to line 2 with ", " so nothing is lost', () => {
    const d = foldAddressRow(row({ line1: 'No 5', line2: 'Jalan Satu', line3: 'Taman Dua', line4: '11900 Bayan Lepas' }), loc, null);
    expect(d.action).toBe('fold');
    expect(d.next.line2).toBe('Jalan Satu, Taman Dua');
    expect(d.next.postcode).toBe('11900');
    expect(d.changed).toContain('line2');
  });

  it('free text with an empty line 2 becomes line 2', () => {
    const d = foldAddressRow(row({ line1: 'No 5', line3: 'Taman Dua' }), loc, null);
    expect(d.next.line2).toBe('Taman Dua');
  });

  it('an unknown postcode is free text, not a postcode', () => {
    const d = foldAddressRow(row({ line3: '99999 Nowhere' }), loc, null);
    expect(d.next.line2).toBe('99999 Nowhere');
    expect(d.next.postcode).toBeNull();
  });

  it('a sales order keeps line 2 within the account book\'s 40 characters: a longer fold is too_long and left alone', () => {
    const d = foldAddressRow(row({ line2: 'Jalan Panjang Sekali Nombor Lima Belas', line3: 'Taman Indah Permai' }), loc, 40);
    expect(d.action).toBe('too_long');
    expect(d.next).toBeUndefined();
  });

  it('a long line 2 already stored is no reason to refuse clearing a repeated town line (and the empty State is filled from the postcode)', () => {
    const d = foldAddressRow(row({ line2: 'Jalan Panjang Sekali Nombor Lima Belas Lagi', line3: '11900 Bayan Lepas', postcode: '11900', city: 'Bayan Lepas' }), loc, 40);
    expect(d.action).toBe('fold');
    expect(d.changed).toEqual(['line3', 'state']);
    expect(d.next.state).toBe('Pulau Pinang');
  });

  it('a city from a bare name must belong to the record\'s postcode', () => {
    const d = foldAddressRow(row({ line3: 'Seri Kembangan', postcode: '11900' }), loc, null);
    expect(d.action).toBe('conflict');
  });

  it('nothing in lines 3 / 4: nothing to do', () => {
    expect(foldAddressRow(row({ line1: 'A', line2: 'B' }), loc, null).action).toBe('none');
  });

  it('a blank-but-not-null line 3 is cleared to NULL', () => {
    const d = foldAddressRow(row({ line1: 'A', line3: '' , line4: '  ' }), loc, null);
    expect(d.action).toBe('fold');
    expect(d.next.line3).toBeNull();
  });
});

describe('a street stored in the State field (production suppliers)', () => {
  it('moves into line 1 when it is empty, clears State, and fills State / City from the postcode', () => {
    const d = foldAddressRow(row({ state: '1831-B JALAN KPB1, KAWASAN PERINDUSTRIAN', postcode: '43300' }), loc, null);
    expect(d.action).toBe('fold');
    expect(d.next).toMatchObject({ line1: '1831-B JALAN KPB1, KAWASAN PERINDUSTRIAN', state: 'Selangor', city: 'Seri Kembangan' });
    expect(d.changed.sort()).toEqual(['city', 'line1', 'state']);
  });

  it('appends to line 2 when line 1 is taken', () => {
    const d = foldAddressRow(row({ line1: 'Factory', state: 'LOT PT 3285, JALAN NELA', postcode: '11900', city: 'Bayan Lepas' }), loc, null);
    expect(d.next.line1).toBe('Factory');
    expect(d.next.line2).toBe('LOT PT 3285, JALAN NELA');
    expect(d.next.state).toBe('Pulau Pinang');
  });

  it('is not copied again when the lines (or the billing address) already hold it', () => {
    const street = 'E-28-02 & E-28-03, MENARA SUEZCAP';
    const d = foldAddressRow(row({ line1: 'Office', haystack: `${street} 2, KL ECO CITY`, state: street }), loc, null);
    expect(d.action).toBe('fold');
    expect(d.changed).toEqual(['state']);
    expect(d.next.state).toBeNull();
    expect(d.notes.join(' ')).toContain('State left empty');
  });

  it('a foreign state name ("Guangdong") is a state, not a street', () => {
    expect(foldAddressRow(row({ line1: 'A', state: 'Guangdong' }), loc, null).action).toBe('none');
  });
});

describe('the completion rule fills what the fold leaves empty', () => {
  it('a bare postcode in line 3 fills postcode, then its one city and state', () => {
    const d = foldAddressRow(row({ line1: 'A', line3: '43300' }), loc, null);
    expect(d.next).toMatchObject({ postcode: '43300', city: 'Seri Kembangan', state: 'Selangor' });
  });

  it('a filled State that my_localities contradicts is a conflict, not a silent change', () => {
    const d = foldAddressRow(row({ line3: 'Taman Dua', postcode: '43300', state: 'Johor' }), loc, null);
    expect(d.action).toBe('conflict');
  });
});

describe('the form view and the account book agree after a fold', () => {
  it('Address line 2 shows lines 3 / 4 unless they only repeat the town', () => {
    const town = { postcode: '11900', city: 'Bayan Lepas', state: 'Pulau Pinang' };
    expect(repeatsTown('11900 Bayan Lepas', town)).toBe(true);
    expect(addressLineTwoView('', '11900 Bayan Lepas', 'Penang', town)).toBe('Penang');
    expect(addressLineTwoView('Jalan Satu', 'Taman Dua', null, town)).toBe('Jalan Satu, Taman Dua');
    expect(addressLineTwoView('typing ', null, null, town)).toBe('typing ');
  });

  it('a folded sales order still fills all four AutoCount lines: line 3 = postcode + city, line 4 = state', () => {
    const d = foldAddressRow(row({ line1: 'TREED SUNGAI ARA', line3: '11900 Bayan Lepas', line4: 'Penang' }), loc, 40);
    const so = { address1: 'TREED SUNGAI ARA', address2: d.next.line2, address3: null, address4: null,
      postcode: d.next.postcode, city: d.next.city, customer_state: d.next.state };
    expect(soInvoiceAddress(so)).toEqual({ InvAddr1: 'TREED SUNGAI ARA', InvAddr2: null, InvAddr3: '11900 Bayan Lepas', InvAddr4: 'Pulau Pinang' });
  });
});
