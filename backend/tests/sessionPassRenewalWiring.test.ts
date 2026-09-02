/* THE MODEL CANNOT NOTICE THE REAL FILE LOSING THE CALL.
 *
 * `src/middleware/sessionPassRenewal.test.ts` proves the BEHAVIOUR against a
 * fixture of the middleware's DB-path branch. A fixture keeps passing after
 * somebody deletes the two lines it models, so the fixture alone would let the
 * renewal disappear silently — and the only symptom of that is slowness nobody
 * attributes to it (docs/bugs/0593-*).
 *
 * This file reads the real source. It lives in `backend/tests/` rather than
 * beside the middleware because `node:fs` is not typed inside the Workers
 * tsconfig, which is the same reason every other source-anchored test here does.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(
  fileURLToPath(new URL('../src/middleware/auth.ts', import.meta.url)), 'utf8');

describe('the real middleware still does this', () => {
  it('mints on the authoritative path and sets the header', async () => {
    /* SOURCE-ANCHORED, because the fixture above is a model and a model cannot
       notice the real file losing the call. Anchored on the two statements, not
       on surrounding prose. */
    const src = SRC;
    const at = src.indexOf('const user = await getUserBySession(');
    expect(at, 'the authoritative read moved — re-anchor this test').toBeGreaterThan(-1);
    /* The re-issue sits just BEFORE the read's result is consumed; search the
       whole handler rather than a slice so a reorder does not fail spuriously. */
    expect(src).toContain('const reissued = await mintSessionPass(c.env, token, Date.now());');
    expect(src).toContain('if (reissued) c.header("X-Session-Pass", reissued);');
  });
});
