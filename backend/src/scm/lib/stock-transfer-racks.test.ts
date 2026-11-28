import { describe, expect, test } from 'vitest';
import { readLineRacks, rackShortages } from './stock-transfer-racks';
import { buildTransferPayload, payloadMovesRacks } from './stock-transfer-atomic';

const RACK_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const RACK_B = 'bbbbbbbb-0000-4000-8000-000000000001';

describe('readLineRacks', () => {
  test('blank, null and missing all mean no rack', () => {
    expect(readLineRacks({})).toEqual({ fromRackId: null, toRackId: null });
    expect(readLineRacks({ fromRackId: '', toRackId: null })).toEqual({ fromRackId: null, toRackId: null });
  });

  test('reads both rack ids', () => {
    expect(readLineRacks({ fromRackId: RACK_A, toRackId: RACK_B })).toEqual({ fromRackId: RACK_A, toRackId: RACK_B });
  });

  test('refuses a value that is not a rack id', () => {
    expect(() => readLineRacks({ fromRackId: 'L5.2' })).toThrow(/fromRackId is not a rack id/);
  });
});

describe('rackShortages', () => {
  test('two lines of the same item off the same rack are added together', () => {
    const lines = [
      { item_code: 'X', qty: 2, fromRackId: RACK_A },
      { item_code: 'X', qty: 2, fromRackId: RACK_A },
    ];
    expect(rackShortages(lines, new Map([[`${RACK_A}::X`, 3]]))).toEqual([
      { rackId: RACK_A, itemCode: 'X', requested: 4, held: 3 },
    ]);
    expect(rackShortages(lines, new Map([[`${RACK_A}::X`, 4]]))).toEqual([]);
  });

  test('a line with no From rack is never short', () => {
    expect(rackShortages([{ item_code: 'X', qty: 9, fromRackId: null }], new Map())).toEqual([]);
  });
});

describe('transfer payload racks', () => {
  const base = { item_code: 'X', product_name: null, variant_key: null, qty: 1 };

  test('a line with no rack builds the same payload as before racks existed', () => {
    const out = buildTransferPayload([{ ...base, from_rack_id: null, to_rack_id: null }], new Map());
    expect(out).toEqual([{ item_code: 'X', product_name: null, variant_key: '', qty: 1, batch_no: null }]);
    expect(payloadMovesRacks(out)).toBe(false);
  });

  test('a line with a rack carries it and routes the post through the racked function', () => {
    const out = buildTransferPayload([{ ...base, from_rack_id: RACK_A, to_rack_id: null }], new Map());
    expect(out[0]).toMatchObject({ from_rack_id: RACK_A });
    expect(out[0]).not.toHaveProperty('to_rack_id');
    expect(payloadMovesRacks(out)).toBe(true);
  });
});
