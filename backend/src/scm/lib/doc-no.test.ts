
import { describe, it, expect } from 'vitest';
import { fakeSb } from './fake-postgrest';
import { docMonthTag, jePrefixForCode, jePrefixForCompany } from './doc-no';
import { todayMyt } from './my-time';

describe('jePrefixForCode — resolves from the company CODE', () => {
  it('HOUZS mints BARE (historical convention, NOT its HC- doc prefix)', () => {
    expect(jePrefixForCode('HOUZS')).toBe('');
    expect(jePrefixForCode('houzs')).toBe('');
  });

  it('2990 keeps 2990-', () => {
    expect(jePrefixForCode('2990')).toBe('2990-');
  });

  it('a future third company gets its own <CODE>- prefix, never 2990-', () => {
    expect(jePrefixForCode('ACME')).toBe('ACME-');
    expect(jePrefixForCode('ACME')).not.toBe('2990-');
  });

  it('an unresolved/blank code degrades to the base company bare prefix', () => {
    expect(jePrefixForCode(null)).toBe('');
    expect(jePrefixForCode(undefined)).toBe('');
    expect(jePrefixForCode('')).toBe('');
  });
});

describe('jePrefixForCompany — resolves the CODE from the id, then the prefix', () => {
  const sb = () =>
    fakeSb({
      companies: [
        { id: 7, code: 'HOUZS' },
        { id: 3, code: '2990' },
        { id: 9, code: 'ACME' },
      ],
    });

  it('HOUZS stays BARE even when it is not id 1', async () => {
    expect(await jePrefixForCompany(sb(), 7)).toBe('');
  });

  it('2990 gets 2990- even when it is not id 2', async () => {
    expect(await jePrefixForCompany(sb(), 3)).toBe('2990-');
  });

  it('a third company gets its own prefix, not 2990-', async () => {
    expect(await jePrefixForCompany(sb(), 9)).toBe('ACME-');
  });

  it('a null company (unstamped source doc) is bare', async () => {
    expect(await jePrefixForCompany(sb(), null)).toBe('');
    expect(await jePrefixForCompany(sb(), undefined)).toBe('');
  });

  it('an unknown id degrades to bare rather than mis-prefixing', async () => {
    expect(await jePrefixForCompany(sb(), 999)).toBe('');
  });
});

describe('docMonthTag — a series takes its month from the DOCUMENT date (owner 2026-09-07)', () => {
  it('reads YYMM off a YYYY-MM-DD document date', () => {
    expect(docMonthTag('2026-03-31')).toBe('2603');
    expect(docMonthTag(' 2026-12-01 ')).toBe('2612');
  });

  it('falls back to today in Malaysia when the date is blank or not a date', () => {
    const today = todayMyt();
    const tag = `${today.slice(2, 4)}${today.slice(5, 7)}`;
    expect(docMonthTag('')).toBe(tag);
    expect(docMonthTag(null)).toBe(tag);
    expect(docMonthTag(undefined)).toBe(tag);
    expect(docMonthTag('31/03/2026')).toBe(tag);
  });
});
