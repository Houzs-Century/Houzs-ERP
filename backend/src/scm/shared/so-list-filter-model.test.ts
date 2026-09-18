// The Sales Order list's second-level filters (owner 2026-09-14: "the status
// filter is the first filter ... I want a second filter — Created By, Warehouse,
// Created Date, Branding, SO from-to, Processing / Delivery Date, venue,
// balance"). ONE model for the URL, the phone sheet, the desktop bar and the
// server's parser. These pin the wire format and its validation, because the
// server rejects what this rejects and a shared link must round-trip.
import { describe, expect, it } from 'vitest';
import {
  SO_FILTER_FIELDS,
  SO_FILTER_MAX_ROWS,
  parseSoListFilter,
  parseSoListFilters,
  serializeSoListFilter,
  serializeSoListFilters,
  soAddDays,
  soDatePresetRange,
  soFilterDefaultRow,
  soFilterField,
  soFilterIsComplete,
  soFilterSummary,
  soMoneyToSen,
  soTodayYmd,
  soCategoryBucket,
  type SoListFilter,
} from './so-list-filter-model';

describe('field catalogue', () => {
  it('carries the owner-named fields under the four mockup groups', () => {
    const keys = SO_FILTER_FIELDS.map((f) => f.key);
    for (const k of ['createdBy', 'salesperson', 'venue', 'docNo', 'name', 'reference',
      'processingDate', 'deliveryDate', 'createdDate', 'orderDate', 'balance']) {
      expect(keys).toContain(k);
    }
    expect(new Set(SO_FILTER_FIELDS.map((f) => f.group))).toEqual(new Set(['who', 'where', 'when', 'order']));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every field offers at least one operator and its default row uses the first', () => {
    for (const f of SO_FILTER_FIELDS) {
      expect(f.ops.length).toBeGreaterThan(0);
      expect(soFilterDefaultRow(f.key).op).toBe(f.ops[0]);
    }
  });
});

describe('wire format', () => {
  const cases: SoListFilter[] = [
    { field: 'createdBy', op: 'me', value: '' },
    { field: 'salesperson', op: 'is', value: 'c115a11d-5a53-40c1-820a-c64cc4d9b4fb' },
    { field: 'name', op: 'contains', value: 'Tan: Ah Kow' },
    { field: 'docNo', op: 'between', value: 'HC-SO-013000~HC-SO-013100' },
    { field: 'deliveryDate', op: 'between', value: '2026-09-01~2026-09-30' },
    { field: 'processingDate', op: 'preset', value: 'this_week' },
    { field: 'createdDate', op: 'after', value: '2026-08-31' },
    { field: 'balance', op: 'positive', value: '' },
    { field: 'balance', op: 'between', value: '100~2500.50' },
    { field: 'total', op: 'gt', value: '-5' },
    { field: 'paymentStatus', op: 'is', value: 'deposit' },
  ];

  it('round-trips every operator shape, including a value that contains the separator', () => {
    for (const f of cases) {
      const s = serializeSoListFilter(f);
      expect(parseSoListFilter(s)).toEqual(f);
    }
    expect(serializeSoListFilter(cases[0])).toBe('createdBy:me');
    expect(serializeSoListFilter(cases[2])).toBe('name:contains:Tan: Ah Kow');
  });

  it('keeps the order of rows and reports each invalid entry verbatim', () => {
    const raw = [...serializeSoListFilters(cases.slice(0, 3)), 'bogus:is:x', 'balance:gt:abc'];
    const out = parseSoListFilters(raw);
    expect(out.filters).toEqual(cases.slice(0, 3));
    expect(out.invalid).toEqual(['bogus:is:x', 'balance:gt:abc']);
  });

  it('refuses more rows than the cap instead of silently dropping the tail', () => {
    const many = Array.from({ length: SO_FILTER_MAX_ROWS + 1 }, () => 'createdBy:me');
    const out = parseSoListFilters(many);
    expect(out.filters).toHaveLength(SO_FILTER_MAX_ROWS);
    expect(out.invalid).toEqual(['createdBy:me']);
  });
});

describe('validation — the server refuses exactly these', () => {
  const bad = [
    'createdBy:is:not-a-uuid',        // a person must be a staff uuid
    'createdBy:me:someone',           // "me" carries no value
    'salesperson:contains:x',         // operator not offered for the field
    'name:contains:',                 // empty text
    'name:contains:   ',
    `name:contains:${'x'.repeat(81)}`, // over the length cap
    'docNo:between:~',                // both ends empty
    'docNo:between:HC-SO-1;DROP~',    // outside the doc-number alphabet
    'deliveryDate:between:2026-02-30~', // not a calendar date
    'deliveryDate:between:2026-09-30~2026-09-01', // reversed
    'deliveryDate:on:30/09/2026',
    'deliveryDate:preset:fortnight',
    'balance:gt:1e5',
    'balance:gt:12.345',
    'balance:between:~',
    'balance:between:500~100',
    'paymentStatus:is:overpaid',
    'overdue:is:no',
    'name',
    '',
  ];
  it.each(bad)('rejects %s', (raw) => {
    expect(parseSoListFilter(raw)).toBeNull();
  });

  it('accepts an open-ended range on either side', () => {
    expect(parseSoListFilter('docNo:between:HC-SO-013000~')).not.toBeNull();
    expect(parseSoListFilter('deliveryDate:between:~2026-09-30')).not.toBeNull();
    expect(parseSoListFilter('balance:between:~100')).not.toBeNull();
  });

  it('a default row is incomplete until it has a value (except value-less operators)', () => {
    expect(soFilterIsComplete(soFilterDefaultRow('name'))).toBe(false);
    expect(soFilterIsComplete({ field: 'name', op: 'contains', value: 'tan' })).toBe(true);
    expect(soFilterIsComplete(soFilterDefaultRow('createdBy'))).toBe(true);
  });
});

describe('dates', () => {
  it("today is Kuala Lumpur's date, not UTC's", () => {
    // 2026-09-14 17:30 UTC is already 2026-09-15 01:30 in KL.
    expect(soTodayYmd(new Date('2026-09-14T17:30:00Z'))).toBe('2026-09-15');
    expect(soTodayYmd(new Date('2026-09-14T15:59:00Z'))).toBe('2026-09-14');
  });

  it('adds days across month and year ends', () => {
    expect(soAddDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(soAddDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(soAddDays('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('resolves every preset against a Monday-start week (Mon 2026-09-14)', () => {
    const t = '2026-09-14';
    expect(soDatePresetRange('today', t)).toEqual({ from: t, to: t });
    expect(soDatePresetRange('yesterday', t)).toEqual({ from: '2026-09-13', to: '2026-09-13' });
    expect(soDatePresetRange('tomorrow', t)).toEqual({ from: '2026-09-15', to: '2026-09-15' });
    expect(soDatePresetRange('this_week', t)).toEqual({ from: '2026-09-14', to: '2026-09-20' });
    expect(soDatePresetRange('last_week', t)).toEqual({ from: '2026-09-07', to: '2026-09-13' });
    expect(soDatePresetRange('next_week', t)).toEqual({ from: '2026-09-21', to: '2026-09-27' });
    expect(soDatePresetRange('this_month', t)).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(soDatePresetRange('last_month', t)).toEqual({ from: '2026-08-01', to: '2026-08-31' });
    expect(soDatePresetRange('next_month', t)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    // A Sunday still belongs to the week that began the Monday before.
    expect(soDatePresetRange('this_week', '2026-09-20')).toEqual({ from: '2026-09-14', to: '2026-09-20' });
    expect(soDatePresetRange('last_month', '2026-01-15')).toEqual({ from: '2025-12-01', to: '2025-12-31' });
  });
});

describe('money and summaries', () => {
  it('converts ringgit text to whole sen without float drift', () => {
    expect(soMoneyToSen('0.29')).toBe(29);
    expect(soMoneyToSen('2500.5')).toBe(250050);
    expect(soMoneyToSen('-12')).toBe(-1200);
    expect(soMoneyToSen('abc')).toBeNull();
  });

  it('summarises a row in the words the phone row shows', () => {
    const labels = {
      staff: (id: string) => (id === 'c115a11d-5a53-40c1-820a-c64cc4d9b4fb' ? 'Wei Siang' : ''),
      warehouse: (id: string) => (id === 'e309c399-697c-4174-967f-ae2c888ad999' ? 'KL WAREHOUSE' : ''),
    };
    expect(soFilterSummary({ field: 'createdBy', op: 'me', value: '' }, labels)).toBe('is me');
    expect(soFilterSummary({ field: 'salesperson', op: 'is', value: 'c115a11d-5a53-40c1-820a-c64cc4d9b4fb' }, labels)).toBe('is Wei Siang');
    expect(soFilterSummary({ field: 'deliveryDate', op: 'between', value: '2026-09-01~2026-09-30' }, labels)).toBe('01/09/2026 – 30/09/2026');
    expect(soFilterSummary({ field: 'deliveryDate', op: 'preset', value: 'this_week' }, labels)).toBe('This week');
    expect(soFilterSummary({ field: 'balance', op: 'gt', value: '100' }, labels)).toBe('> RM 100.00');
    expect(soFilterSummary({ field: 'balance', op: 'positive', value: '' }, labels)).toBe('has balance');
    expect(soFilterSummary({ field: 'docNo', op: 'between', value: 'HC-SO-013000~' }, labels)).toBe('from HC-SO-013000');
    expect(soFilterSummary(soFilterDefaultRow('name'), labels)).toBe('Choose…');
    expect(soFilterSummary({ field: 'warehouse', op: 'is', value: 'e309c399-697c-4174-967f-ae2c888ad999' }, labels)).toBe('is KL WAREHOUSE');
    expect(soFilterSummary({ field: 'itemCategory', op: 'is', value: 'sofa' }, labels)).toBe('Sofa');
    expect(soFilterSummary({ field: 'pendingAmendment', op: 'is', value: 'no' }, labels)).toBe('No pending amendment');
    expect(soFilterField('balance')?.label).toBe('Balance');
  });
});

describe('line-level and branding fields (owner 2026-09-14 follow-up)', () => {
  it('Warehouse and Branding lead the WHERE group; Item category and Pending amendment sit in ORDER AND MONEY', () => {
    const where = SO_FILTER_FIELDS.filter((f) => f.group === 'where').map((f) => f.key);
    expect(where.slice(0, 3)).toEqual(['warehouse', 'branding', 'venue']);
    const order = SO_FILTER_FIELDS.filter((f) => f.group === 'order').map((f) => f.key);
    expect(order).toContain('itemCategory');
    expect(order).toContain('pendingAmendment');
  });

  it('round-trips and validates the four new fields', () => {
    const ok = [
      'warehouse:is:e309c399-697c-4174-967f-ae2c888ad999',
      'branding:contains:akemi',
      'branding:is:ZANOTTI',
      'itemCategory:is:sofa',
      'itemCategory:is:accessory',
      'pendingAmendment:is:yes',
      'pendingAmendment:is:no',
    ];
    for (const raw of ok) expect(serializeSoListFilter(parseSoListFilter(raw)!)).toBe(raw);
    for (const raw of ['warehouse:is:KL', 'warehouse:contains:e309c399-697c-4174-967f-ae2c888ad999', 'itemCategory:is:dining',
      'itemCategory:is:SOFA', 'pendingAmendment:is:maybe', 'branding:contains:']) {
      expect(parseSoListFilter(raw)).toBeNull();
    }
  });

  it('maps an item category choice to the bucket the list itself uses', () => {
    expect(soCategoryBucket('sofa')).toBe('SOFA');
    expect(soCategoryBucket('bedframe')).toBe('BEDFRAME');
    expect(soCategoryBucket('mattress')).toBe('MATTRESS');
    expect(soCategoryBucket('accessory')).toBe('ACCESSORY');
    expect(soCategoryBucket('dining')).toBeNull();
  });
});
