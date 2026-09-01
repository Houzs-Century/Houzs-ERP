## The signed session pass was never renewed, so it was inert for 95 percent of every session [high]

**Symptom.** The owner sent a console capture from a Sales Order page showing
repeated one-second `GET /api/presence` and `GET /api/branding` calls. Production's
client-error log says it is neither one page nor one person — over two days, 50
distinct signatures and 444 occurrences, of which **45 signatures are `[slow …]`**,
clustered on the endpoints that are already edge-cached:

```
     20 [slow 800ms+] GET /api/announcements/banner
     14 [slow 800ms+] GET /api/presence
      3 [slow 800ms+] GET /api/branding
      2 [slow 800ms+] GET /api/auth/me
      1 [slow 5s+]    GET /api/presence
```

`GET /api/auth/me` is the row that settles where the time goes: it returns the
authenticated user and does nothing else, so 800ms there cannot belong to a route
body, and no route-level cache can help — the cache lives INSIDE the handler.

**Root cause (traced).** Two constants, and nothing between them:

| | value | where |
| --- | --- | --- |
| signed pass | **8 hours** | `SESSION_PASS_TTL_MS`, `services/session-pass.ts` |
| session token | **7 days** | `SESSION_TTL_SECONDS`, `services/auth.ts` |

A pass is minted at exactly four places — `/bootstrap`, `/login`, `/totp/login`,
`/accept-invite` (`routes/auth.ts`) — and **nowhere else**. There is no renewal.
So a pass covers the first 8 hours of a 7-day session and then expires, and from
hour 9 to day 7 — about **95% of a session's life** — `tryPassAuth` returns null
and every single request falls through to `getUserBySession`: a six-table join
over `sessions/users/roles/positions/departments` plus a four-branch `UNION ALL`
collecting page access and brand scope, on the shared pool, before any route body
runs.

The feature shipped, was activated, and then quietly stopped applying to almost
everybody — while its own symptom kept getting re-diagnosed as something else.

**A CORRECTION, because the previous entry got this wrong.**
`docs/bugs/0592-*` and `docs/modules/system-health.md` (PR #2836) attribute this
slowness to `SESSION_SIGNING_KEY` being unset, and say so as fact. **That was a
claim with no observation behind it.** Whether the secret is set was, and at the
time of writing still is, UNKNOWN from inside this repository — that is exactly
why #2836 added the panel. The right reading of both documents is: the panel
answers whether the key is on; it does not say that it is off. The renewal gap
above is present and costly EITHER WAY, which is what makes it the root cause
rather than a second theory.

**Fix.** Re-issue on the authoritative path. Reaching `getUserBySession` means
the caller has no usable pass, so the middleware now mints a fresh one there and
returns it on an `X-Session-Pass` response header; the SPA absorbs it in
`correlatedFetch`, the single funnel every authenticated transport goes through.
Cost becomes one authoritative read per 8 hours per session instead of one per
request.

Three properties that make it safe, none of them new inventions:

* **Revocation still bites.** The board compares a pass's `iat` against the
  revoke timestamp and its own header already anticipated this — *"a pass minted
  AFTER the event (a fresh login, or a re-issue) has a newer iat and is
  honoured"* (`services/session-revocation.ts`). A logout destroys the session
  row, so `getUserBySession` fails and nothing is minted; a role change re-reads
  the envelope at this very line and the new pass carries the new one.
* **Still inert unkeyed.** `mintSessionPass` returns null without the secret, so
  with no key nothing is issued and nothing changes.
* **The renewal follows the store the user chose.** A "don't remember me" login
  keeps its token in `sessionStorage`; `absorbSessionPass` writes the renewed
  pass to whichever store holds the token, so it never outlives the session the
  user asked to be temporary.

`X-Session-Pass` is added to `Access-Control-Expose-Headers` in both places that
set them — a header the browser hides is a renewal that silently never happens.

**Test.** `src/middleware/sessionPassRenewal.test.ts` (behaviour: issues when
keyed, issues nothing unkeyed or under-length, and the re-issued pass carries a
NEWER `iat`), `tests/sessionPassRenewalWiring.test.ts` (source-anchored, because
a fixture cannot notice the real file losing the call) and
`frontend/src/lib/absorbSessionPass.test.ts` (the five client cases, including
tab-only storage). Both server tests proved RED on the unfixed tree:

```
AssertionError: expected 'import type { MiddlewareHandler } fro…' to contain
  'if (reissued) c.header("X-Session-Pas…'
Tests  1 failed (1)
```

**UNTESTED against production.** Nothing here has been measured on the live
system. What would settle it: after deploy, the System Health "Signed sessions"
card, and a re-run of the client-errors check — the `[slow …]` signature count on
`/api/auth/me`, `/api/presence` and `/api/announcements/banner` is the number to
compare.

**Ref.** fix/session-pass-renewal, 2026-08-31.
