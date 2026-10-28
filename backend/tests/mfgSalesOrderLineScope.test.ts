import { describe, expect, test } from 'vitest';
import { scopeSoItemToDocument, soLineWriteLeaseMatches } from '../src/scm/routes/mfg-sales-orders';

describe('Sales Order line route scope', () => {
  test('always constrains a line query by both route docNo and itemId', () => {
    const predicates: Array<[string, string]> = [];
    const query = {
      eq(column: string, value: string) {
        predicates.push([column, value]);
        return this;
      },
    };

    expect(scopeSoItemToDocument(query, 'SO-OWNER', 'item-1')).toBe(query);
    expect(predicates).toEqual([
      ['doc_no', 'SO-OWNER'],
      ['id', 'item-1'],
    ]);
  });

  test('accepts only the matching unexpired server lease', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();

    expect(soLineWriteLeaseMatches({ edit_lease_token: 'lease-a', edit_lease_expires_at: future }, 'lease-a')).toBe(true);
    expect(soLineWriteLeaseMatches({ edit_lease_token: 'lease-a', edit_lease_expires_at: future }, 'lease-b')).toBe(false);
    expect(soLineWriteLeaseMatches({ edit_lease_token: 'lease-a', edit_lease_expires_at: past }, 'lease-a')).toBe(false);
    expect(soLineWriteLeaseMatches({ edit_lease_token: null, edit_lease_expires_at: null }, 'lease-a')).toBe(false);
  });
});
