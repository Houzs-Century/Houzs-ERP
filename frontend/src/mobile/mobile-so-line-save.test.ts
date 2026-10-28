import { describe, expect, test } from 'vitest';
import { mobileLineAddHeaders } from './mobile-so-line-save';

describe('mobile Sales Order line add intent', () => {
  test('a retry reuses the draft key and a different draft remains distinct', () => {
    const first = { addIdempotencyKey: 'add-intent-1' };
    const second = { addIdempotencyKey: 'add-intent-2' };

    expect(mobileLineAddHeaders(first, 'lease-1')).toEqual(mobileLineAddHeaders(first, 'lease-1'));
    expect(mobileLineAddHeaders(first, 'lease-1')['Idempotency-Key'])
      .not.toBe(mobileLineAddHeaders(second, 'lease-1')['Idempotency-Key']);
  });
});
