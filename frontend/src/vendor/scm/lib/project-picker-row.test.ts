import { describe, it, expect } from 'vitest';
import { eventDateRange, projectRowParts } from './project-picker-row';

describe('eventDateRange', () => {
  it('same month: start in full, end as the day', () => {
    expect(eventDateRange('2026-08-28', '2026-08-31')).toBe('2026-08-28 → 31');
  });
  it('across months in one year: end as MM-DD', () => {
    expect(eventDateRange('2026-07-31', '2026-08-02')).toBe('2026-07-31 → 08-02');
  });
  it('across years: end in full', () => {
    expect(eventDateRange('2026-12-30', '2027-01-02')).toBe('2026-12-30 → 2027-01-02');
  });
  it('single day (end equals start) is just the start', () => {
    expect(eventDateRange('2026-08-21', '2026-08-21')).toBe('2026-08-21');
  });
  it('no end is just the start', () => {
    expect(eventDateRange('2026-08-21', null)).toBe('2026-08-21');
  });
  it('ignores a time component', () => {
    expect(eventDateRange('2026-08-28T00:00:00Z', '2026-08-31T00:00:00Z')).toBe('2026-08-28 → 31');
  });
  it('no start is empty', () => {
    expect(eventDateRange(null, '2026-08-31')).toBe('');
  });
});

describe('projectRowParts', () => {
  const base = {
    code: '2026-08-BIGHOME-JOHOR-MVEC-SOUTHKEY-AKEMI',
    name: 'JOHOR [AKEMI] BIGHOME @ Mid Valley Exhibition Centre Southkey',
    venue: 'Mid Valley Exhibition Centre Southkey',
    state: 'Johor',
    brand: 'AKEMI',
    start_date: '2026-08-28',
    end_date: '2026-08-31',
  };

  it('splits brand, title (after the bracket) and state', () => {
    const r = projectRowParts(base);
    expect(r.brand).toBe('AKEMI');
    expect(r.title).toBe('BIGHOME @ Mid Valley Exhibition Centre Southkey');
    expect(r.state).toBe('Johor');
    expect(r.date).toBe('2026-08-28 → 31');
  });

  it('strips the state prefix whatever its case', () => {
    expect(projectRowParts({ ...base, name: 'Kuala Lumpur [ERGOTEX] MEGAHOME @ KLCC' }).title)
      .toBe('MEGAHOME @ KLCC');
  });

  it('builds a plain one-line label and a lowercase search haystack', () => {
    const r = projectRowParts(base);
    expect(r.plain).toBe('2026-08-28 → 31 [AKEMI] BIGHOME @ Mid Valley Exhibition Centre Southkey · Johor');
    expect(r.search).toContain('akemi');
    expect(r.search).toContain('bighome');
    expect(r.search).toContain('johor');
    expect(r.search).toContain('2026-08-bighome-johor-mvec-southkey-akemi');
    expect(r.search).toBe(r.search.toLowerCase());
  });

  it('sortKey is the start date', () => {
    expect(projectRowParts(base).sortKey).toBe('2026-08-28');
  });

  it('a name with no bracket is taken whole', () => {
    expect(projectRowParts({ ...base, name: 'Ad-hoc setup job', brand: null }).title).toBe('Ad-hoc setup job');
  });
});
