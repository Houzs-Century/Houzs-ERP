/* The rule is "which company's masters does a posting read", and it was written
 * THREE times as three hand-copied ternaries. Two things are pinned here: the
 * decision itself, and that there is still only one copy of it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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

  /* THE SUBSTITUTION MUST NEVER BE SILENT AGAIN. It was silent for the whole of
     its life, which is why an entry validated against another company's chart
     was indistinguishable from one validated against its own. */
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

/* A unit test cannot stop a fourth copy being typed into a fourth file. This
   can. The pattern is the exact expression that was live in engine.ts:94,
   rules.ts:93 and payments.ts:51 — a company fallback written inline instead of
   asked for. It also fails when its own matcher finds no files to read, so a
   verdict computed over an empty population cannot read as a pass (CLAUDE.md:
   "a checker that cannot match reports a clean run"). */
describe('the decision has exactly one home', () => {
  const dir = join(__dirname);
  const INLINE_FALLBACK = /companyId\s*(==|===)\s*null\s*\?\s*1\b|companyId\s*(\?\?|\|\|)\s*1\b/;

  it('no acc/ module re-implements the company fallback inline', () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(files.length).toBeGreaterThan(5); // the matcher ran over a real population

    const offenders = files.filter((f) => {
      if (f === 'masters-company.ts') return false; // the one home
      return INLINE_FALLBACK.test(readFileSync(join(dir, f), 'utf8'));
    });
    expect(offenders, `these files re-implement the fallback instead of calling accMastersCompanyId: ${offenders.join(', ')}`)
      .toEqual([]);
  });

  it('the matcher is not dead — it still recognises the expression it was written for', () => {
    expect(INLINE_FALLBACK.test('const co = companyId == null ? 1 : Number(companyId);')).toBe(true);
    expect(INLINE_FALLBACK.test(".eq('company_id', companyId == null ? 1 : Number(companyId))")).toBe(true);
    expect(INLINE_FALLBACK.test('const co = companyId ?? 1;')).toBe(true);
    expect(INLINE_FALLBACK.test('const co = accMastersCompanyId(companyId, "x");')).toBe(false);
  });
});
