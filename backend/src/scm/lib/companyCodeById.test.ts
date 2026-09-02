/* A DOCUMENT NUMBER CANNOT BE RENAMED, SO THE MINTER MUST NOT GUESS.
 *
 * `companyDocPrefix` (companyScope.ts:548) degrades to the BASE company when the
 * request context carries no `companyCode`. That branch was written when HOUZS
 * minted BARE numbers, so degrading was invisible. Since 2026-08-07 HOUZS mints
 * `HC-`, and the branch became a claim: this document belongs to Houzs Century.
 *
 * The headless scan job hits that branch on EVERY run. It reconstructs its
 * context from the scan_jobs row, which captured the company ID and not the
 * code, and returned `undefined` for the code deliberately — with a comment
 * promising "bare HOUZS numbering", which stopped being true on 2026-08-07.
 * A 2990 slip scanned by phone therefore minted `HC-SO-YYMM-NNN` against
 * company_id 2, permanently.
 *
 * `companyCodeById` is the resolver that removes the guess: the id was known
 * all along. Pinned here because the failure is silent by construction — a
 * wrong prefix is a valid document number and nothing downstream refuses it.
 */
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

  /* Fail CLOSED. Minting under a guessed prefix is permanent; a refused scan
     job is retried. Same direction jePrefixForCompany takes, for the same
     reason. */
  it('throws on an unreadable master instead of falling back to a prefix', async () => {
    const sb = fakeSb({ companies: COMPANIES }, { companies: ['code'] });
    await expect(companyCodeById(sb, 2)).rejects.toThrow(/could not read company 2/);
  });
});

describe('what the resolved code buys the scan job', () => {
  /* The point of the resolver, stated as the outcome rather than the mechanism:
     the same company id that used to mint HC- now mints its own prefix. */
  it('a resolved 2990 code mints 2990-, where the missing-code branch minted HC-', async () => {
    const code = await companyCodeById(fakeSb({ companies: COMPANIES }), 2);
    expect(code).not.toBeNull();
    expect(docPrefixForCode(code as string)).toBe('2990-');
    // The branch that used to run: no code at all, degrade to the base company.
    expect(docPrefixForCode('HOUZS')).toBe('HC-');
  });
});
