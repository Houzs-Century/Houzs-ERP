import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/* setUserCompanies DELETEs every grant and then INSERTs the validated set, so an
 * empty validated set left the user with ZERO rows in user_companies — and that
 * grant list is what the whole tenant boundary is derived from.
 *
 * Two ways in, and the second is the dangerous one:
 *   · PUT /:id/companies with `{"companies": []}` — the stated intent, "this
 *     person gets no company";
 *   · a RESTRICTED grantor: a caller holding only [2] who submits [1] (a stale
 *     form, an older client, or the Sales-Director invite path that forces [1])
 *     had `requested` filtered down to nothing, so their target's grants were
 *     erased by a request that asked for the opposite.
 *
 * Source-shape assertions rather than behaviour tests: the unit is a Hono route
 * over D1, and the property worth protecting is that the refusal exists at all.
 * A behaviour test that stubbed the DB would pass while the refusal was deleted.
 *
 * NOT PINNED HERE, on purpose: what an empty grant list should MEAN at read time.
 * The 2026-07-14 rule is "0 grants = every company"; isolation-by-default says
 * the opposite. That is a live owner decision and it is being answered against
 * production data, not guessed at in a test. */

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');

/** Only code — a comment quoting the old shape must not satisfy an assertion. */
const codeOf = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

describe('a user cannot be left with no company at all', () => {
  const code = codeOf(read('routes/users.ts'));

  it('refuses an empty request instead of deleting every grant', () => {
    expect(code, 'setUserCompanies accepts an empty array again')
      .toMatch(/requested\.length\s*===?\s*0[\s\S]{0,200}?UserCompaniesRefusal/);
  });

  it('refuses when validation leaves nothing, rather than erasing', () => {
    /* ANCHORED, because the loose version passed with this block deleted. Both
       refusals mention UserCompaniesRefusal, and `[\s\S]{0,200}` from the FIRST
       one reached the second one's throw — so the assertion was satisfied by the
       guard it was not testing. Proven by removing this block and watching the
       test stay green. Match the statement itself instead. */
    expect(code, 'a fully-filtered-out request silently erases grants again')
      .toMatch(/if\s*\(\s*valid\.length\s*===\s*0\s*\)\s*\{\s*throw new UserCompaniesRefusal/);
  });

  it('every caller answers 400 rather than a 500', () => {
    const catches = code.match(/UserCompaniesRefusal\)\s*return c\.json/g) ?? [];
    expect(catches.length, 'a setUserCompanies caller stopped handling the refusal')
      .toBe(3);
  });
});
