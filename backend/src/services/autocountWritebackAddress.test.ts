// ----------------------------------------------------------------------------
// AN ADDRESS THAT DOES NOT FIT THE ACCOUNT BOOK STOPS THE WHOLE DOCUMENT.
//
// HC-SO-2609-006, 2026-09-09, in AutoCount's own words:
//
//   Cannot set column 'InvAddr1'. The value violates the MaxLength limit of this
//   column.
//
// Measured against AED_HOUZS the same day: all four InvAddr columns are 40
// characters. A customer whose street line runs past forty could not have a
// sales order in the accounts at all.
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import {
  fitAddressLines,
  soInvoiceAddress,
  AC_ADDRESS_LINE_MAX,
} from './autocount-writeback';
import { fitSoAddress } from './autocount-address-fit';

const LONG = 'No 12A, Jalan Perindustrian Bukit Minyak 5, Kawasan Perindustrian';

describe('an address that already fits is never touched', () => {
  /* THE RULE THAT MAKES THIS SAFE TO SHIP. Re-flowing every address would
     rewrite the line breaks of every document on its next edit, for the sake of
     the few that overflow. */
  test('four short lines come back exactly as they went in', () => {
    const input = ['No 1, Jalan Besar', 'Taman Sentosa', '43300 Seri Kembangan', 'Selangor'];
    expect(fitAddressLines(input).lines).toEqual(input);
    expect(fitAddressLines(input).dropped).toBeNull();
  });

  test('nulls survive as nulls', () => {
    expect(fitAddressLines(['No 1', null, null, null]).lines).toEqual(['No 1', null, null, null]);
  });

  test('exactly at the limit is still a fit', () => {
    const at = 'x'.repeat(AC_ADDRESS_LINE_MAX);
    expect(fitAddressLines([at, null, null, null]).lines[0]).toBe(at);
  });
});

describe('an overflowing address is RE-FLOWED, not cut', () => {
  const out = fitAddressLines([LONG, 'Taman Sentosa', '43300 Seri Kembangan', 'Selangor']);

  test('every line now fits the column', () => {
    for (const l of out.lines) expect((l ?? '').length).toBeLessThanOrEqual(AC_ADDRESS_LINE_MAX);
  });

  /* THE ADDRESS A DELIVERY IS PRINTED FROM. Losing part of it sends goods to
     the wrong place, so the words must all still be there and in order. */
  test('not one word is lost, and the order is kept', () => {
    const before = [LONG, 'Taman Sentosa', '43300 Seri Kembangan', 'Selangor'].join(' ').split(' ');
    const after = out.lines.filter(Boolean).join(' ').split(' ');
    expect(after).toEqual(before);
    expect(out.dropped).toBeNull();
  });

  test('it breaks between words, never inside one', () => {
    for (const l of out.lines) if (l) expect(l.startsWith(' ')).toBe(false);
  });
});

describe('what cannot fit is reported, never silently dropped', () => {
  test('past four lines of forty, the overflow is named', () => {
    const huge = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    const out = fitAddressLines([huge, null, null, null]);
    expect(out.lines.filter(Boolean)).toHaveLength(4);
    expect(out.dropped).toBeTruthy();
    /* The dropped text is the TAIL, so a reader can see what was lost. */
    expect(huge.endsWith(out.dropped as string)).toBe(true);
  });

  /* Nothing else can be done with a single token wider than the column. */
  test('one very long word is broken rather than dropped', () => {
    const word = 'A'.repeat(90);
    const out = fitAddressLines([word, null, null, null]);
    expect(out.lines.filter(Boolean).join('')).toBe(word);
  });
});

describe('soInvoiceAddress carries the fit', () => {
  test('a long street line reaches the book within the column width', () => {
    const inv = soInvoiceAddress({
      address1: LONG, address2: 'Taman Sentosa', postcode: '43300', city: 'Seri Kembangan',
      customer_state: 'Selangor',
    });
    for (const v of [inv.InvAddr1, inv.InvAddr2, inv.InvAddr3, inv.InvAddr4]) {
      expect((v ?? '').length).toBeLessThanOrEqual(AC_ADDRESS_LINE_MAX);
    }
    expect(inv.InvAddr1).toBeTruthy();
  });

  /* The shape every other test in this repo already asserts must not move. */
  test('the ordinary address is unchanged', () => {
    const inv = soInvoiceAddress({
      address1: 'No 1, Jalan Besar', address2: 'Taman Sentosa',
      postcode: '43300', city: 'Seri Kembangan', customer_state: 'Selangor',
    });
    expect(inv.InvAddr1).toBe('No 1, Jalan Besar');
    expect(inv.InvAddr2).toBe('Taman Sentosa');
    expect(inv.InvAddr3).toBe('43300 Seri Kembangan');
    expect(inv.InvAddr4).toBe('Selangor');
  });
});

/* ── THE SAVE SIDE — 「把我们的 address lock成 40 个字」 ────────────────────────
   Fitting on the way OUT was a patch. The owner asked for the data itself on
   2026-09-09, and this is the half that makes the ERP hold what the account book
   holds — so the two never disagree about where a customer lives, and a person
   reading the sales order sees the lines the invoice will carry. */
describe('fitSoAddress locks a stored address to the column', () => {
  test('a long street line is split across address1 and address2', () => {
    const out = fitSoAddress([LONG, null, null, null]);
    expect((out.address1 ?? '').length).toBeLessThanOrEqual(AC_ADDRESS_LINE_MAX);
    expect(out.address2).toBeTruthy();
    /* Not one word lost, and in order — this is the address a delivery is
       printed from. */
    expect([out.address1, out.address2, out.address3, out.address4]
      .filter(Boolean).join(' ')).toBe(LONG);
  });

  test('an address that already fits is stored exactly as typed', () => {
    const out = fitSoAddress(['No 1, Jalan Besar', 'Taman Sentosa', '43300 Seri Kembangan', 'Selangor']);
    expect(out).toEqual({
      address1: 'No 1, Jalan Besar',
      address2: 'Taman Sentosa',
      address3: '43300 Seri Kembangan',
      address4: 'Selangor',
    });
  });

  /* A line the fitted address no longer needs is BLANKED, not left holding what
     was there before — otherwise a re-flow that moves text up leaves a ghost. */
  test('a line the address no longer needs comes back null', () => {
    const out = fitSoAddress(['short', 'also short', null, null]);
    expect(out.address3).toBeNull();
    expect(out.address4).toBeNull();
  });
});
