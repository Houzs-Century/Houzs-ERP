import { describe, expect, test } from 'vitest';

import { composePaymentUdf } from './autocount-writeback';
// @ts-expect-error - the cutover parser is untyped JS on purpose; that is what it is.
import * as cutover from '../../scripts/lib/ac-payment-udf.mjs';

describe('what the write-back sends, the cutover parser reads back', () => {
  test('one payment with both references', () => {
    const udf = composePaymentUdf([{ account_sheet: 'MAYBANK', approval_code: '123456' }]);
    expect(udf).toBe('(MAYBANK/123456)');
    expect(cutover.parsePayment(udf)).toMatchObject({ acct: 'MAYBANK', appr: '123456' });
  });

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

  test('no references at all sends nothing', () => {
    expect(composePaymentUdf([])).toBeNull();
    expect(composePaymentUdf([{ account_sheet: null, approval_code: null }])).toBeNull();
    expect(composePaymentUdf([{ account_sheet: '   ', approval_code: '' }])).toBeNull();
  });

  test('a blank payment between two real ones is skipped, not emitted', () => {
    const udf = composePaymentUdf([
      { account_sheet: 'MAYBANK', approval_code: '111' },
      { account_sheet: null, approval_code: null },
      { account_sheet: 'CIMB', approval_code: '222' },
    ]);
    expect(udf).toBe('(MAYBANK/111) (CIMB/222)');
  });

  test('a value carrying a delimiter cannot corrupt the pair', () => {
    const udf = composePaymentUdf([{ account_sheet: 'MBB/CIMB', approval_code: 'A(1)' }]);
    expect(udf).toBe('(MBB CIMB/A 1)');
    expect(cutover.parsePayment(udf)).toMatchObject({ acct: 'MBB CIMB', appr: 'A 1' });
  });

  test('a malformed row is skipped rather than thrown on', () => {
    expect(composePaymentUdf([{} as never])).toBeNull();
  });
});

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

/* THE FIELD HOLDS FIFTY CHARACTERS (docs/bugs/0921). `SO.UDF_PAYEMENT` is
   nvarchar(50) in the live book (INFORMATION_SCHEMA, 2026-09-15). A longer value
   was refused by AutoCount and the host swallowed the refusal, so HC-SO-2609-011
   (63 characters, three payments) kept an empty field through three sends. */
describe('a payment text longer than the field', () => {
  const three = [
    { account_sheet: 'PUBLIC BANK', approval_code: '474367' },
    { account_sheet: 'Bank Transfer', approval_code: '470709' },
    { account_sheet: 'Bank Transfer', approval_code: '478704' },
  ];

  test('three payments over the field, as on HC-SO-2609-011: the text fits, keeps whole references from the first, and parses to the first pair', () => {
    const udf = composePaymentUdf(three);
    expect(udf).not.toBeNull();
    expect((udf as string).length).toBeLessThanOrEqual(50);
    expect(udf).toBe('(PUBLIC BANK/474367)(Bank Transfer/470709)');
    expect(cutover.parsePayment(udf)).toMatchObject({ acct: 'PUBLIC BANK', appr: '474367' });
  });

  test('CONTROL: a text that already fits is sent exactly as before', () => {
    expect(composePaymentUdf(three.slice(0, 2))).toBe('(PUBLIC BANK/474367) (Bank Transfer/470709)');
  });

  test('a single reference longer than the field sends nothing rather than half of it', () => {
    expect(composePaymentUdf([{ account_sheet: 'A'.repeat(40), approval_code: 'B'.repeat(20) }])).toBeNull();
  });
});
