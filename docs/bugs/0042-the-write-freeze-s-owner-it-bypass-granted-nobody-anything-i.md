## The write freeze's owner/IT bypass granted nobody anything - it read an identity that does not exist yet at that point in the chain [high]

**Symptom** - the go-live write freeze is documented, and was believed, to
exempt the owner and anyone holding `scm.admin` so IT can still correct data
while staff are paused ("owner / scm.admin always bypass" - the middleware
header, `set-write-freeze.mjs`, and the workflow description all say so). It
never did. With the freeze on, EVERY caller was refused, including `*`. Nobody
reported it because the same accounts do their cutover repairs over
`DATABASE_URL` rather than through `/api/scm`, so the hole nobody could use was
also the hole nobody noticed.

**Root cause (traced, not guessed)** - `scm/lib/write-freeze.ts` read the caller
from `c.get('houzsUser')`. That variable is set in exactly one place,
`scm/middleware/auth.ts` (`supabaseAuth`), which every SCM sub-router mounts
ITSELF via `router.use('*', supabaseAuth)`. The freeze is mounted a level above,
at `scm.use('/*', scmWriteFreeze())` in `scm/index.ts`, so it runs a full routing
step BEFORE any sub-router middleware. `houzsUser` is therefore `undefined`
there, `perms` was always `[]`, and `BYPASS_PERMS.some(...)` was always false.

Proven by dispatching a Hono app assembled in the production shape (global auth
-> `scm.use('/*')` -> `scm.route(prefix, sub)` -> `sub.use('*', ...)`) and
recording what the freeze could see: `houzsUser` undefined, `user` populated.
That harness is now `backend/tests/writeFreezeMiddleware.test.ts`, whose "the
bypass" block fails with 503 against the old code.

The same line carried `hu?.is_owner`, a second dead branch: no identity in this
codebase has an `is_owner` field. The `houzsUser` type (`scm/env.ts`) does not
declare one and `scm/middleware/auth.ts` never sets one. It read as a
deliberate owner escape hatch and was nothing.

**What made it invisible** - the intact Houzs `AuthUser` IS in scope at that
point, in `c.get('user')`; `scmAreaGuard` reads exactly that, and says so in a
comment. The freeze was written against the other variable and no test covered
a bypassing caller, so two adjacent middlewares disagreed about where the caller
lives and nothing forced the question. `parseFreezeValue` had unit tests; the
middleware had none.

**Fix** - `callerBypasses(c)` checks BOTH `user` and `houzsUser` and grants on
either. Not defensive padding: the two identities swap over during the chain -
before `supabaseAuth`, `user` is the real caller; after it, `user` has been
replaced by the pinned permission-less scm.staff row and `houzsUser` is the real
caller. Reading both is correct wherever the middleware is mounted, so a future
reorder cannot silently revoke the bypass again. Both orderings are pinned by
test. `is_owner` is deleted; the god-position accounts (Lim, Nico) need no
special case because `hydrateAuthUser` PUSHES `'*'` into `permissions` for a
Super Admin / Owner position, so they arrive holding the wildcard.

**Ref** - 2026-08-11, feat/write-freeze-area-scope. Found while building the
per-module staged lift (`docs/write-freeze-staged-lift.md`).
