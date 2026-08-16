// The PAYEMENT UDF has to survive the trip back out.
//
// WHY A ROUND TRIP AND NOT ASSERTED STRINGS. The format of AutoCount's
// `UDF_PAYEMENT` was never designed here — it is whatever `parsePayment` reads,
// and that function is the one the cutover actually ran over 13,015 headers to
// fill `mfg_sales_order_payments.account_sheet` and `.approval_code`. So the
// specification is executable, and the only honest test is to compose with the
// write-back's function and parse with the CUTOVER'S, in one assertion.
//
// Asserting a literal string instead would pin what I think the format is. This
// pins what the importer can actually read, which is the thing that matters:
// get it wrong and the field reads as garbage to the next person who opens the
// document, and to any future re-import.
//
// The two live in one file (`backend/scripts/lib/ac-payment-udf.mjs` holds the
// parser and a mirror of the composer) for the reason `check-shared-mirrors`
// exists — but the write-back cannot import a script at runtime, so the TS copy
// is the one that ships and this file is the referee.
import { describe, expect, test } from 'vitest';

import { composePaymentUdf } from './autocount-writeback';
/* The CUTOVER'S parser, unchanged, moved out of import-ac-outstanding-so.mjs so
   a test can reach it. No shebang on that file, deliberately — see CLAUDE.md. */
// @ts-expect-error - the cutover parser is untyped JS on purpose; that is what it is.
import * as cutover from '../../scripts/lib/ac-payment-udf.mjs';

describe('what the write-back sends, the cutover parser reads back', () => {
  test('one payment with both references', () => {
    const udf = composePaymentUdf([{ account_sheet: 'MAYBANK', approval_code: '123456' }]);
    expect(udf).toBe('(MAYBANK/123456)');
    expect(cutover.parsePayment(udf)).toMatchObject({ acct: 'MAYBANK', appr: '123456' });
  });

  /* The parser takes the FIRST non-empty part it sees for each of the two, so a
     second payment must not overwrite the first. This is the case that would
     silently reorder the book's text if the read were unordered. */
  test('several payments keep the first one as the parsed pair', () => {
    const udf = composePaymentUdf([
      { account_sheet: 'MAYBANK', approval_code: '111' },
      { account_sheet: 'CIMB', approval_code: '222' },
    ]);
    expect(udf).toBe('(MAYBANK/111) (CIMB/222)');
    expect(cutover.parsePayment(udf)).toMatchObject({ acct: 'MAYBANK', appr: '111' });
  });

  test('only an account sheet', () => {
    const udf = composePaymentUdf([{ account_sheet: 'Cash', approval_code: null }]);
    expect(cutover.parsePayment(udf)).toMatchObject({ acct: 'Cash', appr: null });
  });

  test('only an approval code', () => {
    const udf = composePaymentUdf([{ account_sheet: null, approval_code: 'A-77' }]);
    expect(cutover.parsePayment(udf)).toMatchObject({ acct: null, appr: 'A-77' });
  });

  /* NOTHING TO SAY MUST BE NULL, NOT AN EMPTY STRING. `udf()` drops a null and
     the key never reaches the service; an empty string is a value, and `Str`
     would write it over whatever the account book holds — including the
     cutover's own text on an order whose payments predate the ERP. */
  test('no references at all sends nothing', () => {
    expect(composePaymentUdf([])).toBeNull();
    expect(composePaymentUdf([{ account_sheet: null, approval_code: null }])).toBeNull();
    expect(composePaymentUdf([{ account_sheet: '   ', approval_code: '' }])).toBeNull();
  });

  /* A payment carrying neither reference is SKIPPED, not emitted as `(/)` — the
     parser discards that group anyway, so emitting it would put noise in a
     field people read off a printed document. */
  test('a blank payment between two real ones is skipped, not emitted', () => {
    const udf = composePaymentUdf([
      { account_sheet: 'MAYBANK', approval_code: '111' },
      { account_sheet: null, approval_code: null },
      { account_sheet: 'CIMB', approval_code: '222' },
    ]);
    expect(udf).toBe('(MAYBANK/111) (CIMB/222)');
  });

  /* THE THREE CHARACTERS THE FORMAT OWNS. `(`, `)` and `/` are its delimiters,
     so a bank name like "MBB/CIMB" would parse back as acct `MBB`, appr `CIMB`
     and lose the approval code entirely. They become spaces. Lossy, and
     predictable — a human typing into this field in AutoCount's own UI is under
     exactly the same constraint. */
  test('a value carrying a delimiter cannot corrupt the pair', () => {
    const udf = composePaymentUdf([{ account_sheet: 'MBB/CIMB', approval_code: 'A(1)' }]);
    expect(udf).toBe('(MBB CIMB/A 1)');
    /* The point: the pair still comes back as a pair. */
    expect(cutover.parsePayment(udf)).toMatchObject({ acct: 'MBB CIMB', appr: 'A 1' });
  });

  /* A defensive shape, because this is a read off a live table: a row with the
     columns missing entirely must not throw inside a composer that a document
     save depends on. */
  test('a malformed row is skipped rather than thrown on', () => {
    expect(composePaymentUdf([{} as never])).toBeNull();
  });
});

/* THE MIRROR. scripts/lib carries a copy of the composer so an ops script can
   build the same text without importing TypeScript. Two implementations of one
   format is exactly the drift this repo gates elsewhere (check-shared-mirrors),
   so they are held to the same outputs here rather than trusted to stay level. */
describe('the scripts/lib mirror agrees with the shipped composer', () => {
  const CASES = [
    [{ account_sheet: 'MAYBANK', approval_code: '123456' }],
    [{ account_sheet: 'Cash', approval_code: null }],
    [{ account_sheet: null, approval_code: 'A-77' }],
    [{ account_sheet: 'MBB/CIMB', approval_code: 'A(1)' }],
    [{ account_sheet: null, approval_code: null }],
    [
      { account_sheet: 'MAYBANK', approval_code: '111' },
      { account_sheet: 'CIMB', approval_code: '222' },
    ],
    [],
  ];

  test.each(CASES.map((c, i) => [i, c] as const))('case %i', (_i, payments) => {
    expect(cutover.composePaymentUdf(payments)).toBe(composePaymentUdf(payments as never));
  });
});
