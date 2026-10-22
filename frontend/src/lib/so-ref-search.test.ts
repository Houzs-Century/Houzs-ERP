import { describe, expect, it } from 'vitest';
import {
  deliveryReturnMatchesSearch,
  deliveryReturnSearchText,
  matchesSearch,
  searchText,
  soRefOfCamelStamp,
  soRefOfStamp,
} from './so-ref-search';

describe('soRefOfStamp / soRefOfCamelStamp — the one rule, via customerRefOf', () => {
  it('prefers ref, falls back to customer_so_no, empty when neither', () => {
    expect(soRefOfStamp({ so_ref: 'MR TAN', so_customer_so_no: 'OLD' })).toBe('MR TAN');
    expect(soRefOfStamp({ so_ref: null, so_customer_so_no: 'CUST-PO-7' })).toBe('CUST-PO-7');
    expect(soRefOfStamp({})).toBe('');
    expect(soRefOfStamp(null)).toBe('');
    expect(soRefOfCamelStamp({ soRef: ' SUNWAY ', soCustomerSoNo: null })).toBe('SUNWAY');
    expect(soRefOfCamelStamp({ soRef: '', soCustomerSoNo: 'CUST-PO-7' })).toBe('CUST-PO-7');
    expect(soRefOfCamelStamp(undefined)).toBe('');
  });
});

describe('matchesSearch', () => {
  it('matches a case-insensitive substring of any part; blank term matches all', () => {
    expect(matchesSearch(['HC-DO-1', 'Mr Tan / Sunway'], 'sunway')).toBe(true);
    expect(matchesSearch(['HC-DO-1', null, undefined, ''], '  do-1 ')).toBe(true);
    expect(matchesSearch(['HC-DO-1'], 'sunway')).toBe(false);
    expect(matchesSearch([], '   ')).toBe(true);
    expect(matchesSearch([42], '4')).toBe(true);
  });

  it('never matches across two adjacent fields', () => {
    expect(matchesSearch(['AB', 'CD'], 'bc')).toBe(false);
    expect(searchText(['AB', null, 'CD'])).toBe('ab\ncd');
  });
});

describe('the Delivery Returns search — one predicate for desktop and phone', () => {
  const row = {
    return_number: 'HC-DR-2609-001', do_doc_no: 'HC-DO-2609-010', debtor_name: 'Tan Ah Kow',
    debtor_code: '300-T001', salesperson_id: null, ref: null, customer_so_no: 'CUST-PO-7',
    branding: 'Houzs', sales_location: 'KL', reason: 'Damaged', venue: 'IOI',
  };

  it("finds a return by its order's reference", () => {
    expect(deliveryReturnMatchesSearch(row, 'cust-po')).toBe(true);
    expect(deliveryReturnMatchesSearch({ ...row, ref: 'MR TAN / SUNWAY' }, 'sunway')).toBe(true);
  });

  it('still finds by number, DO, customer and the other listed fields', () => {
    for (const term of ['DR-2609', 'do-2609-010', 'tan ah', '300-t001', 'houzs', 'kl', 'damaged', 'ioi']) {
      expect(deliveryReturnMatchesSearch(row, term)).toBe(true);
    }
    expect(deliveryReturnMatchesSearch(row, 'nothing-like-this')).toBe(false);
  });

  it('the phone reads the same text the desktop matches', () => {
    expect(deliveryReturnSearchText(row)).toContain('cust-po-7');
    expect(deliveryReturnSearchText(row).includes('tan ah kow')).toBe(true);
  });
});
