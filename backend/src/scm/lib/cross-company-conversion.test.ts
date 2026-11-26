import { describe, expect, test } from 'vitest';
import {
  isCrossCompanySource,
  crossCompanyConversionBlocked,
} from './companyScope';

const HOUZS = 1;
const C2990 = 2;

function ctx(opts: {
  companyId?: number;
  companyCode?: string;
  companies?: Array<{ id: number; code: string; name: string }>;
}) {
  const companies = opts.companies ?? [
    { id: HOUZS, code: 'HOUZS', name: 'Houzs Century' },
    { id: C2990, code: '2990', name: '2990' },
  ];
  const bag: Record<string, unknown> = {
    companyId: opts.companyId,
    companyCode: opts.companyCode,
    companies,
  };
  return { get: (k: string) => bag[k] };
}

const houzsCtx = ctx({ companyId: HOUZS, companyCode: 'HOUZS' });

describe('isCrossCompanySource', () => {
  test('BLOCKS a 2990 source while the active company is Houzs', () => {
    expect(isCrossCompanySource(C2990, houzsCtx)).toBe(true);
  });

  test('ALLOWS a same-company source', () => {
    expect(isCrossCompanySource(HOUZS, houzsCtx)).toBe(false);
  });

  test('BLOCKS symmetrically — a Houzs source while active is 2990', () => {
    const c = ctx({ companyId: C2990, companyCode: '2990' });
    expect(isCrossCompanySource(HOUZS, c)).toBe(true);
  });

  test('accepts a numeric string company id (PostgREST bigint may arrive as text)', () => {
    expect(isCrossCompanySource('2', houzsCtx)).toBe(true);
    expect(isCrossCompanySource('1', houzsCtx)).toBe(false);
  });


  test('DEGRADES when the active company is unresolved', () => {
    const unresolved = ctx({ companyId: undefined, companyCode: undefined });
    expect(isCrossCompanySource(C2990, unresolved)).toBe(false);
  });

  test('DEGRADES when the source row carries no company_id', () => {
    expect(isCrossCompanySource(null, houzsCtx)).toBe(false);
    expect(isCrossCompanySource(undefined, houzsCtx)).toBe(false);
  });

  test('DEGRADES on a malformed source company id rather than blocking', () => {
    expect(isCrossCompanySource(0, houzsCtx)).toBe(false);
    expect(isCrossCompanySource(-1, houzsCtx)).toBe(false);
    expect(isCrossCompanySource('not-a-number', houzsCtx)).toBe(false);
  });
});

describe('crossCompanyConversionBlocked', () => {
  const payload = crossCompanyConversionBlocked('2990-SO-2606-002', C2990, houzsCtx);

  test('carries the stable error code', () => {
    expect(payload.error).toBe('cross_company_conversion_blocked');
  });

  test('names the document and BOTH companies', () => {
    expect(payload.message).toContain('2990-SO-2606-002');
    expect(payload.message).toContain('2990');
    expect(payload.message).toContain('HOUZS');
    expect(payload.sourceDocNo).toBe('2990-SO-2606-002');
    expect(payload.sourceCompany).toBe('2990');
    expect(payload.activeCompany).toBe('HOUZS');
  });

  test('tells the operator what to DO, not just that it failed', () => {
    expect(payload.message.toLowerCase()).toContain('switch company');
  });

  test('is under the 200-character client cap', () => {
    expect(payload.message.length).toBeLessThan(200);
  });

  test('trips none of the client internals filters', () => {
    expect(payload.message.trim().startsWith('{')).toBe(false);
    expect(
      /violates|constraint|null value|column|relation|syntax|PGRST|error_code|\b\d{5}\b/i
        .test(payload.message),
    ).toBe(false);
  });

  test('English only — no Chinese characters in operator-facing copy', () => {
    expect(/[一-鿿]/.test(payload.message)).toBe(false);
  });

  test('stays within the cap and readable when the companies master is unresolved', () => {
    const bare = ctx({ companyId: HOUZS, companyCode: undefined, companies: [] });
    const p = crossCompanyConversionBlocked(null, C2990, bare);
    expect(p.message).not.toContain('undefined');
    expect(p.message).not.toContain('null');
    expect(p.message.length).toBeLessThan(200);
    expect(p.sourceCompany).toBeNull();
    expect(p.activeCompany).toBeNull();
  });
});
