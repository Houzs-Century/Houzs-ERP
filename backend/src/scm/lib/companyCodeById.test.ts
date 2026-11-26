import { describe, expect, it } from 'vitest';

import { fakeSb } from './fake-postgrest';
import { companyCodeById } from './doc-no';
import { docPrefixForCode } from './companyScope';

const COMPANIES = [
  { id: 1, code: 'HOUZS', name: 'Houzs Century' },
  { id: 2, code: '2990', name: "2990's Home" },
];

describe('companyCodeById', () => {
  it('names the public schema — the SCM client is pinned to scm', async () => {
    const sb = fakeSb({ companies: COMPANIES });
    await companyCodeById(sb, 1);
    expect(sb.schemaCalls).toContain('public');
  });

  it('resolves each company to its own code', async () => {
    expect(await companyCodeById(fakeSb({ companies: COMPANIES }), 1)).toBe('HOUZS');
    expect(await companyCodeById(fakeSb({ companies: COMPANIES }), 2)).toBe('2990');
  });

  it('a null id short-circuits without a read — there is nothing to resolve', async () => {
    const sb = fakeSb({ companies: COMPANIES });
    expect(await companyCodeById(sb, null)).toBeNull();
    expect(sb.schemaCalls).toHaveLength(0);
  });

  it('an unknown id resolves to null rather than to the base company', async () => {
    expect(await companyCodeById(fakeSb({ companies: COMPANIES }), 99)).toBeNull();
  });

  it('throws on an unreadable master instead of falling back to a prefix', async () => {
    const sb = fakeSb({ companies: COMPANIES }, { companies: ['code'] });
    await expect(companyCodeById(sb, 2)).rejects.toThrow(/could not read company 2/);
  });
});

describe('what the resolved code buys the scan job', () => {
  it('a resolved 2990 code mints 2990-, where the missing-code branch minted HC-', async () => {
    const code = await companyCodeById(fakeSb({ companies: COMPANIES }), 2);
    expect(code).not.toBeNull();
    expect(docPrefixForCode(code as string)).toBe('2990-');
    expect(docPrefixForCode('HOUZS')).toBe('HC-');
  });
});
