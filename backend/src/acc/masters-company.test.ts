import { describe, expect, it, vi } from 'vitest';
import { accMastersCompanyId, ACC_MASTERS_FALLBACK_COMPANY_ID } from './masters-company';

describe('accMastersCompanyId', () => {
  it('returns the entry\'s own company when it has one', () => {
    expect(accMastersCompanyId(2, 'test')).toBe(2);
    expect(accMastersCompanyId(1, 'test')).toBe(1);
  });

  it('coerces a numeric-looking id rather than passing it through', () => {
    expect(accMastersCompanyId(2 as unknown as number, 'test')).toBe(2);
  });

  it('falls back to the base company when the entry carries none', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(accMastersCompanyId(null, 'test')).toBe(ACC_MASTERS_FALLBACK_COMPANY_ID);
    expect(accMastersCompanyId(undefined, 'test')).toBe(ACC_MASTERS_FALLBACK_COMPANY_ID);
    spy.mockRestore();
  });

  it('logs at error level, naming the call site, on every substitution', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    accMastersCompanyId(null, 'checkAccounts');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]?.[0])).toContain('checkAccounts');
    expect(String(spy.mock.calls[0]?.[0])).toContain('NO company_id');
    spy.mockRestore();
  });

  it('says nothing when the company IS known — a log per posting would be noise', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    accMastersCompanyId(2, 'checkAccounts');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
