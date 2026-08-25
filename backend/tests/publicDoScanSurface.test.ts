// ----------------------------------------------------------------------------
// Structural pins on the PUBLIC delivery-order scan surface.
//
// publicDoScanRoute.test.ts drives the behaviour. This file pins the properties
// that behaviour cannot see — where the file is mounted, what it is allowed to
// import, and whether the company predicate sits on EVERY statement rather than
// somewhere in the handler.
//
// The style is Hookka's tests/do-qr-public.test.mjs [external]: assert over the
// source text, so loosening one of these trips CI and forces a human to justify
// the change in review instead of it landing quietly.
//
// ── WHY THE SCOPE PIN IS PER STATEMENT ──────────────────────────────────────
// `check-company-scope.mjs` acquits a WHOLE HANDLER as soon as one scoped call
// appears in it (recorded in docs/bugs/0542). Bug 0497 is what that costs: the
// delivery-order PATCH handler was scoped, and a rack helper it called five
// statements later resolved a caller-supplied rack id with no company predicate,
// so a 2990 delivery could empty a Houzs bay. The SCM client is service-role and
// mig 0061 enabled RLS with no policies — the predicate IS the boundary. So this
// counts `.from(` sites and requires each one to be scoped, with exactly one
// named exemption: the token resolve itself, which cannot carry a predicate
// because there is no session to take a company from, and does not need one
// because mig 0328's UNIQUE index makes it resolve to a single row.
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');
const ROUTE = read('src/routes/publicDoScan.ts');
const TOKEN_LIB = read('src/scm/lib/do-scan-token.ts');
const MINT_ROUTE = read('src/scm/routes/delivery-order-scan-token.ts');
const INDEX = read('src/index.ts');
const MIG = read('src/db/migrations-pg/0328_scm_do_public_scan_token.sql');

/** Source with comments removed — an assertion about CODE must not be satisfied
 *  (or broken) by prose, which is how one earlier pin in this repo came to pass
 *  only for as long as nobody wrote an honest comment. */
const codeOf = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

describe('the public surface is mounted where it has to be', () => {
  test('mounted BEFORE the /api/* auth gate, or the driver gets a login screen', () => {
    const mount = INDEX.indexOf('app.route("/api/public/do-scan", publicDoScan)');
    const gate = INDEX.indexOf('app.use("/api/*", auth)');
    expect(mount, 'the public scan router is not mounted').toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(-1);
    expect(mount, 'the public scan router must be mounted before the auth gate').toBeLessThan(gate);
  });

  test('exactly two public endpoints — a read and a one-rung advance', () => {
    const routes = codeOf(ROUTE).match(/publicDoScan\.(get|post|put|patch|delete)\(/g) ?? [];
    expect(routes.sort()).toEqual(['publicDoScan.get(', 'publicDoScan.post(']);
  });
});

describe('minting stays behind the session', () => {
  test('the public route never mints a token', () => {
    expect(codeOf(ROUTE)).not.toContain('getOrCreateDoScanToken');
    expect(codeOf(ROUTE)).not.toContain('newDoScanToken');
  });

  test('the authed route is the only minter, and it scopes to the session company', () => {
    expect(MINT_ROUTE).toContain('getOrCreateDoScanToken(sb, id, co.companyId)');
    /* A FAILED READ IS NOT A MISSING DOCUMENT — the two are told apart, and a
       blip answers 503 rather than sending the operator hunting for a delivery
       order that is right in front of them. */
    expect(MINT_ROUTE).toContain("minted.status === 'read_failed'");
    expect(MINT_ROUTE).toContain("minted.status === 'not_found'");
    expect(MINT_ROUTE).toContain('requireActiveCompanyId(c)');
    expect(MINT_ROUTE).toContain("deliveryOrderScanToken.use('*', supabaseAuth)");
  });

  test('the token is unguessable — two UUIDs, 64 hex chars', () => {
    expect(TOKEN_LIB).toMatch(/crypto\.randomUUID\(\)\s*\+\s*crypto\.randomUUID\(\)/);
    expect(TOKEN_LIB).toMatch(/\.replace\(\/-\/g,\s*''\)/);
    expect(TOKEN_LIB).toMatch(/DO_SCAN_TOKEN_RE\s*=\s*\/\^\[0-9a-f\]\{64\}\$\/i/);
  });

  test('the mint is claimed ATOMICALLY, and the claim carries the company too', () => {
    const claim = TOKEN_LIB.slice(TOKEN_LIB.indexOf('const { data: claimed, error: claimErr }'));
    expect(claim).toContain(".update({ qr_token: fresh })");
    expect(claim).toContain(".is('qr_token', null)");
    expect(claim, 'the write itself must carry the company predicate, not just the read')
      .toContain(".eq('company_id', companyId)");
    /* A FAILED CLAIM IS NOT A LOST RACE. Both come back with no row; only the
       bound error tells them apart, and reading them alike would report a
       printable delivery order as somebody else's. */
    expect(claim).toContain("if (claimErr) return { status: 'read_failed' }");
  });
});

describe('the tenant boundary, statement by statement', () => {
  test('every query in the public route is scoped, bar the named token resolve', () => {
    const code = codeOf(ROUTE);
    const froms = code.match(/\bsb\s*\n?\s*\.from\(|\bsb\.from\(/g) ?? [];
    /* One `.from(` in this file: the line count. The token resolve lives in the
       token library, which this test checks separately below. */
    expect(froms.length, 'a new query appeared in the public route — scope it').toBe(1);
    expect(code).toContain('scopeToCompanyId(');
    expect(code).toContain("sb.from('delivery_order_items')");
    /* And it is INSIDE the scoping wrapper, not merely near it — the exact
       distinction check-company-scope.mjs cannot make (bug 0542). */
    const scoped = code.slice(code.indexOf('scopeToCompanyId('), code.indexOf('companyId,\n  );'));
    expect(scoped).toContain("sb.from('delivery_order_items')");
  });

  test('the token library has exactly one unscoped query, and it is the resolve', () => {
    const code = codeOf(TOKEN_LIB);
    const froms = code.match(/\.from\('delivery_orders'\)/g) ?? [];
    expect(froms.length).toBe(3); // resolve + read + claim
    // The two mint statements both carry the company; the resolve is the one
    // that cannot, and mig 0328's UNIQUE index is what makes that safe.
    expect((code.match(/\.eq\('company_id', companyId\)/g) ?? []).length).toBe(2);
    /* And every one of the three binds its `error`. supabase-js does not throw,
       so an unbound read cannot tell "the query failed" from "there is nothing
       here" — which on THIS route would answer 404 to a blip and tell whoever
       holds the paper their code is dead. */
    expect((code.match(/\berror(?::\s*\w+)?\s*[,}]/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(code).toContain(".eq('qr_token', token)");
    expect(MIG).toContain('CREATE UNIQUE INDEX IF NOT EXISTS ux_delivery_orders_qr_token');
  });

  test('the company is never read off the request', () => {
    const code = codeOf(ROUTE);
    for (const shape of ['body.company', 'companyId: body', 'X-Company-Id', 'req.header']) {
      expect(code, `the request must never name a company (${shape})`).not.toContain(shape);
    }
    expect(code).toContain("['companyId', resolved.companyId]");
  });
});

describe('data minimisation', () => {
  /* Hookka's identical test, with Houzs column names. The point is that the
     route file may not so much as MENTION one of these — a payload cannot leak
     a field the source never names, and a reviewer adding one has to delete an
     assertion to do it. Comments are stripped first so the ban is on code. */
  test('the public route never reads or exposes a price, an address or a contact', () => {
    const code = codeOf(ROUTE) + codeOf(TOKEN_LIB);
    for (const banned of [
      'total_sen', 'subtotal_sen', 'grand_total', 'unit_price', 'price_sen', 'amount_sen',
      'delivery_address', 'address_line', 'ship_address', 'postcode', 'postal_code',
      'contact_phone', 'debtor_phone', 'phone', 'contact_person', 'email',
    ]) {
      expect(code, `must not read/expose ${banned}`).not.toContain(banned);
    }
  });

  test('the resolve reads a named column list, never a wildcard', () => {
    expect(TOKEN_LIB).not.toMatch(/\.select\(\s*['"`]\*/);
    expect(TOKEN_LIB).toContain(
      "'id, company_id, do_number, debtor_name, city, state, status, on_hold, qr_revoked_at'",
    );
  });
});

describe('rate limiting', () => {
  test('both endpoints are limited, no looser than the existing public surfaces', () => {
    const code = codeOf(ROUTE);
    expect((code.match(/checkRateLimit\(/g) ?? []).length).toBe(3);
    /* survey_read is 30/900 and survey_submit / track are 20/900
       (routes/survey.ts, routes/track.ts). Nothing here may be looser. */
    const survey = read('src/routes/survey.ts');
    const surveyRead = Number(/checkRateLimit\(c, "survey_read", clientIp\(c\), (\d+), (\d+)\)/.exec(survey)?.[1]);
    expect(code).toContain(`const READ_MAX = ${surveyRead};`);
    expect(code).toContain('const WRITE_MAX = 20;');
    // The extra one nothing else has: a per-DOCUMENT cap, keyed by the token.
    expect(code).toContain("checkRateLimit(c, 'do_scan_doc', token, PER_TOKEN_MAX, WINDOW_SEC)");
  });
});
