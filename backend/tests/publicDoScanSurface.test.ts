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
const TRIP_MINT = read('src/scm/routes/trip-scan-token.ts');
const MIG_TRIP = read('src/db/migrations-pg/0329_scm_trip_public_scan_token.sql');
const SCM_INDEX = read('src/scm/index.ts');
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

  test('FOUR public endpoints and no more — and every one of them is named here', () => {
    /* Was two until 2026-08-26, when the owner asked to scan a pile of papers
       and press once: 「我不能 scan 好几个 DO，然后一起点 load 吗？」. The count is
       pinned rather than bounded because this is the repo's ONLY no-login write
       surface — a fifth endpoint appearing without a line in this test is
       exactly the review this file exists to force. */
    const code = codeOf(ROUTE);
    const verbs = code.match(/publicDoScan\.(get|post|put|patch|delete)\(/g) ?? [];
    expect(verbs.sort()).toEqual([
      'publicDoScan.get(', 'publicDoScan.post(', 'publicDoScan.post(', 'publicDoScan.post(',
    ]);
    const paths = [...code.matchAll(/publicDoScan\.(?:get|post)\('([^']+)'/g)].map((m) => m[1]);
    expect(paths.sort()).toEqual(['/:token', '/:token/advance', '/batch/advance', '/batch/lookup']);

    /* THE BATCH ROUTES ARE REGISTERED FIRST. Hono matches in registration
       order, so '/batch/advance' declared after '/:token/advance' would be
       captured with token = "batch". */
    expect(code.indexOf("publicDoScan.post('/batch/lookup'")).toBeLessThan(
      code.indexOf("publicDoScan.get('/:token'"),
    );
    expect(code.indexOf("publicDoScan.post('/batch/advance'")).toBeLessThan(
      code.indexOf("publicDoScan.post('/:token/advance'"),
    );

    /* EVERY ONE of them tells a blip apart from an unknown code — the property,
       not the count, is what matters, so it is asserted per resolve rather than
       against a number that drifts with the file. */
    const resolves = (code.match(/await resolveScanToken\(/g) ?? []).length;
    expect(resolves).toBeGreaterThanOrEqual(4);
    expect((code.match(/found\.status === 'read_failed'/g) ?? []).length).toBe(resolves);
    expect((code.match(/found\.status === 'unknown'/g) ?? []).length).toBe(resolves);
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
    /* One `.from(` in this file: the line count. Every other query — the token
       resolve, the run's stops and its member delivery orders — lives in the
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
    /* resolve + the run's member read. The mint's two statements moved to
       `.from(table)` when the trip learned the same mechanism. */
    expect(froms.length).toBe(2);
    // The two mint statements both carry the company; the resolve is the one
    // that cannot, and mig 0328's UNIQUE index is what makes that safe.
    expect((code.match(/\.eq\('company_id', companyId\)/g) ?? []).length).toBe(2);
    expect((code.match(/\.from\(table\)/g) ?? []).length, 'the mint must serve both tables through one path').toBe(2);
    /* And every one of the three binds its `error`. supabase-js does not throw,
       so an unbound read cannot tell "the query failed" from "there is nothing
       here" — which on THIS route would answer 404 to a blip and tell whoever
       holds the paper their code is dead. */
    expect((code.match(/\berror(?::\s*\w+)?\s*[,}]/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(code).toContain(".eq('qr_token', token)");
    /* REVOCATION AND A FAILED READ ARE DIFFERENT ANSWERS, and only one of them
       is folded into "unknown". A revoked token must be indistinguishable from
       one that never existed; a blip must not be, because it says nothing about
       the token in hand and answering 404 would tell a driver his paper is dead. */
    expect(code).toContain("if (row.qr_revoked_at) return { status: 'unknown' }");
    expect(code).toContain("if (error) return { status: 'read_failed' }");
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
  test('every endpoint is limited, and the WRITE limits never loosen', () => {
    const code = codeOf(ROUTE);
    /* One per endpoint, plus the per-document cap on each of the two writes. */
    expect((code.match(/checkRateLimit\(/g) ?? []).length).toBe(6);

    /* THE READ LIMIT LEFT survey_read's NUMBER ON 2026-08-26, deliberately, and
       this test says so rather than being deleted. `clientIp` is the PUBLIC
       address and a warehouse is ONE public address for every phone in it, so
       30 reads per quarter-hour was 30 for the whole floor — the second person
       to pick up a phone found the code dead. What makes that safe is not the
       number: DO_SCAN_TOKEN_RE admits only 64 hex, so enumeration is hopeless
       at any rate.

       The WRITES are what move a document, and they are pinned to the tighter
       of the existing public surfaces (survey_submit / track are 20/900) with
       no room to drift. */
    expect(code).toContain('const READ_MAX = 300;');
    const survey = read('src/routes/survey.ts');
    const surveySubmit = Number(
      /checkRateLimit\(c, "survey_submit", clientIp\(c\), (\d+), (\d+)\)/.exec(survey)?.[1],
    );
    expect(Number.isFinite(surveySubmit)).toBe(true);
    expect(code).toContain(`const WRITE_MAX = ${surveySubmit};`);
    expect(code).toContain('const PER_TOKEN_MAX = 10;');

    // The cap nothing else has: per-DOCUMENT, keyed by the token — and the
    // BASKET does not escape it. It is charged per token inside the loop.
    expect(code).toContain("checkRateLimit(c, 'do_scan_doc', token, PER_TOKEN_MAX, WINDOW_SEC)");
    expect((code.match(/'do_scan_doc'/g) ?? []).length).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// THE PACKING-LIST HALF — same mechanism, and the properties that prove it is
// the same one rather than a second.
// ────────────────────────────────────────────────────────────────────────────
describe('the trip token is the SAME mechanism, not a second one', () => {
  test('mig 0329 gives scm.trips the same column pair and a UNIQUE partial index', () => {
    expect(MIG_TRIP).toContain('ALTER TABLE scm.trips ADD COLUMN IF NOT EXISTS qr_token text');
    expect(MIG_TRIP).toContain('ALTER TABLE scm.trips ADD COLUMN IF NOT EXISTS qr_revoked_at timestamptz');
    expect(MIG_TRIP).toContain('CREATE UNIQUE INDEX IF NOT EXISTS ux_trips_qr_token');
    expect(MIG_TRIP).toContain('WHERE qr_token IS NOT NULL');
    expect(MIG_TRIP).toContain('-- REVERSAL:');
    /* revoked_at gets NO index, for mig 0126's reason — a flag read only after
       the row has been found. */
    expect(MIG_TRIP).not.toMatch(/INDEX[^\n]*qr_revoked_at/);
  });

  test('the trip mint reuses the shared claim, scoped to the session company', () => {
    expect(TRIP_MINT).toContain("getOrCreateScanToken(sb, 'trips', id, co.companyId)");
    expect(TRIP_MINT).toContain('requireActiveCompanyId(c)');
    expect(TRIP_MINT).toContain("tripScanToken.use('*', supabaseAuth)");
    /* The public route must never reach a minter, for either kind. */
    expect(codeOf(ROUTE)).not.toContain('getOrCreateScanToken');
  });

  test('the trip mint is mounted BEFORE the main trips router', () => {
    const first = SCM_INDEX.indexOf('scm.route("/trips", tripScanToken)');
    const main = SCM_INDEX.indexOf('scm.route("/trips", trips)');
    expect(first).toBeGreaterThan(-1);
    expect(first).toBeLessThan(main);
  });
});

describe('a run cannot move another company\'s goods', () => {
  test('the member comparison is against the RUN\'s company, per member', () => {
    const code = codeOf(TOKEN_LIB);
    expect(code).toContain('const foreign = Number(row.company_id) !== trip.companyId;');
    /* A foreign member is withheld, not merely flagged: no document number, no
       status. Printing the other company's document number on a public page is
       the leak rather than the fix. */
    expect(code).toContain('doNumber: foreign ? null :');
    expect(code).toContain('status: foreign ? null :');
  });

  test('the run write takes the TRIP\'s company, never the member\'s', () => {
    const code = codeOf(ROUTE);
    expect(code).toContain('{ ...memberAsDo(m), companyId: trip.companyId }');
    /* memberAsDo must not smuggle a company through — it hands over a zero that
       the caller replaces, so a forgotten override cannot silently widen. */
    expect(code).toContain('companyId: 0,');
  });

  test('the members are read in stop order', () => {
    expect(codeOf(TOKEN_LIB)).toContain(".order('stop_no', { ascending: true })");
  });
});

describe('the run is applied sequentially', () => {
  test('a for-await loop, and no Promise.all over the members', () => {
    const run = codeOf(ROUTE).slice(codeOf(ROUTE).indexOf('async function advanceWholeRun'));
    expect(run).toMatch(/for \(const m of members\) \{/);
    expect(run, 'the run must not be fired in parallel').not.toContain('Promise.all');
    expect(run).not.toContain('members.map(async');
  });
});
