// Cross-company conversion guard — the owner-reported hole.
//
// The trigger: logged in with the switcher on Houzs Century, the owner opened a
// Delivery Order conversion whose source Sales Order was `2990-SO-2606-002`.
// The mirrored 2990 SO row legitimately lives in the Houzs database (the
// one-way SO mirror puts it there, by design). What must NOT happen is Houzs
// claiming it: the converters load their source document by primary key with no
// company predicate, then INSERT the new document stamped
// `company_id: activeCompanyId(c)`. That silently re-companies the order — a
// 2990 SO shipped out as a HOUZS DO, moving 2990's stock and revenue onto
// Houzs' books.
//
// These pin the CONTRACT of the guard itself (isCrossCompanySource +
// crossCompanyConversionBlocked), including the two degrade cases that must
// stay permissive so single-company Houzs keeps converting, and the message
// constraints that decide whether the operator sees the real reason or a
// generic 409.
import { describe, expect, test } from 'vitest';
import {
  isCrossCompanySource,
  crossCompanyConversionBlocked,
} from './companyScope';

const HOUZS = 1;
const C2990 = 2;

/** Minimal CompanyScopeCtx — the helpers only ever call `get`. */
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
    // The exact shape of the owner's report.
    expect(isCrossCompanySource(C2990, houzsCtx)).toBe(true);
  });

  test('ALLOWS a same-company source', () => {
    expect(isCrossCompanySource(HOUZS, houzsCtx)).toBe(false);
  });

  test('BLOCKS symmetrically — a Houzs source while active is 2990', () => {
    // The leak is not one-directional. 2990 receiving Houzs stock is the same
    // bug wearing the other hat.
    const c = ctx({ companyId: C2990, companyCode: '2990' });
    expect(isCrossCompanySource(HOUZS, c)).toBe(true);
  });

  test('accepts a numeric string company id (PostgREST bigint may arrive as text)', () => {
    expect(isCrossCompanySource('2', houzsCtx)).toBe(true);
    expect(isCrossCompanySource('1', houzsCtx)).toBe(false);
  });

  // ── The two DEGRADE cases. Both must stay permissive. ────────────────────
  // These are the same three-state sentinel the rest of companyScope.ts obeys.
  // Getting either wrong turns a scoping fix into an outage: every conversion
  // in the app would start refusing on a DB cold-start.

  test('DEGRADES when the active company is unresolved', () => {
    // companies master unreadable (pre-migration / Hyperdrive cold-start).
    // Single-company Houzs must keep converting exactly as before.
    const unresolved = ctx({ companyId: undefined, companyCode: undefined });
    expect(isCrossCompanySource(C2990, unresolved)).toBe(false);
  });

  test('DEGRADES when the source row carries no company_id', () => {
    // Pre-migration rows predate the company_id column backfill.
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
    // "which one am I in?" is the operator's next question; a bare refusal
    // sends them to IT.
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

  // ── Message must survive the SCM client's plain-sentence filter ──────────
  // authed-fetch.ts drops a server message that is >=200 chars, starts with
  // `{`, or matches its internals regex — and then renders the generic
  // "That clashes with something already in the system" 409 instead. That
  // generic wall is exactly the blank-failure this refusal exists to replace,
  // so the constraint is part of the contract, not an implementation detail.
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
    // Cold-start: no companies rows, so neither code resolves. The message must
    // still be a sentence rather than "undefined belongs to undefined".
    const bare = ctx({ companyId: HOUZS, companyCode: undefined, companies: [] });
    const p = crossCompanyConversionBlocked(null, C2990, bare);
    expect(p.message).not.toContain('undefined');
    expect(p.message).not.toContain('null');
    expect(p.message.length).toBeLessThan(200);
    expect(p.sourceCompany).toBeNull();
    expect(p.activeCompany).toBeNull();
  });
});
