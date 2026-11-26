import { describe, expect, test } from 'vitest';
import { companyDocPrefix, docPrefixForCode, detailMissResponse } from './companyScope';

const ctx = (companyCode: unknown) => ({ get: (k: string) => (k === 'companyCode' ? companyCode : undefined) });

describe('companyDocPrefix', () => {
  test('an OBJECT company code degrades to the base prefix, never "[object Object]-"', () => {
    const p = companyDocPrefix(ctx({ id: 42 }) as never);
    expect(p).toBe('HC-');
    expect(p).not.toContain('[object Object]');
  });

  test('undefined (headless / single-company) mints under the base company', () => {
    expect(companyDocPrefix(ctx(undefined) as never)).toBe('HC-');
  });

  test('a broken context NEVER mints an unprefixed number', () => {
    for (const bad of [{ id: 42 }, undefined, '', null, 0]) {
      expect(companyDocPrefix(ctx(bad) as never)).not.toBe('');
    }
  });

  test('HOUZS mints "HC-", not its bare code', () => {
    expect(companyDocPrefix(ctx('HOUZS') as never)).toBe('HC-');
    expect(companyDocPrefix(ctx('houzs') as never)).toBe('HC-');
    expect(companyDocPrefix(ctx('HOUZS') as never)).not.toBe('HOUZS-');
  });

  test('a real non-base code prefixes with "<code>-"', () => {
    expect(companyDocPrefix(ctx('2990') as never)).toBe('2990-');
  });

  test('docPrefixForCode agrees with companyDocPrefix for every code', () => {
    for (const code of ['HOUZS', '2990', 'ACME']) {
      expect(docPrefixForCode(code)).toBe(companyDocPrefix(ctx(code) as never));
    }
  });
});

describe('detailMissResponse', () => {
  const COMPANIES = [
    { id: 1, code: 'HOUZS', name: 'Houzs' },
    { id: 2, code: '2990', name: '2990' },
  ];
  const ctxMc = (active: number | undefined, allowed: number[] | undefined) => ({
    get: (k: string) =>
      k === 'companyId' ? active
      : k === 'allowedCompanyIds' ? allowed
      : k === 'companies' ? COMPANIES
      : undefined,
  });
  const probe = (rowCompany: number | null) => {
    let applied: number[] | null = null;
    const b = {
      in(_col: string, vals: number[]) { applied = vals; return b; },
      async maybeSingle() {
        const visible = rowCompany != null && (applied === null || applied.includes(rowCompany));
        return { data: visible ? { company_id: rowCompany } : null };
      },
    };
    return b;
  };

  test('row in ANOTHER allowed company → in_other_company, names that company', async () => {
    const r = await detailMissResponse(ctxMc(1, [1, 2]) as never, probe(2), 'supplier');
    expect(r.error).toBe('in_other_company');
    if (r.error === 'in_other_company') {
      expect(r.companyId).toBe(2);
      expect(r.companyCode).toBe('2990');
      expect(r.message).toContain('2990');
      expect(r.message).toContain('supplier');
    }
  });

  test('LEAK BOUNDARY: a company-1-only caller gets plain not_found for a company-2 row', async () => {
    const r = await detailMissResponse(ctxMc(1, [1]) as never, probe(2), 'supplier');
    expect(r.error).toBe('not_found');
  });

  test('genuinely absent id → not_found', async () => {
    const r = await detailMissResponse(ctxMc(1, [1, 2]) as never, probe(null), 'supplier');
    expect(r.error).toBe('not_found');
  });

  test('row resolves in the ACTIVE company → not_found (never falsely "other")', async () => {
    const r = await detailMissResponse(ctxMc(2, [1, 2]) as never, probe(2), 'supplier');
    expect(r.error).toBe('not_found');
  });
});
