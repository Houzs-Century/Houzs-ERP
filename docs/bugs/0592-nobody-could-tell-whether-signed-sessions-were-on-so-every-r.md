## Nobody could tell whether signed sessions were on, so every request kept paying for two authorization reads [medium]

**Symptom.** The owner sent a console capture from a Sales Order page: repeated
one-second `GET /api/presence` and `GET /api/branding` calls. Those two are among
the CHEAPEST endpoints in the system and both are already edge-cached, so a
second each is not their own work.

Production's own client-error log agrees, and shows it is not one page or one
person. Two days, 50 distinct signatures, 444 occurrences — **45 of the 50 are
`[slow …]`**, and they cluster on the cached endpoints:

```
     20 [slow 800ms+] GET /api/announcements/banner
     14 [slow 800ms+] GET /api/presence
      3 [slow 800ms+] GET /api/branding
      2 [slow 800ms+] GET /api/auth/me
      2 [slow 2s+]    GET /api/announcements/banner
      1 [slow 5s+]    GET /api/presence
      1 [slow 2s+]    GET /api/presence
```

`GET /api/auth/me` is the decisive row. It returns the authenticated user and
does nothing else, so when it crosses 800ms the cost cannot belong to any route
body.

**Root cause (traced).** Not new, and not this panel's fault — the panel is what
was missing. `middleware/auth.ts` runs `getUserBySession` on every request that
is not a public prefix, and that function issues two queries against the shared
pool before the route body starts: a six-table join over
`sessions/users/roles/positions/departments` (`services/auth.ts:609`) and a
four-branch `UNION ALL` collecting page access and brand scope (`:631`). An edge
cache in front of a route cannot save any of it — the cache is inside the
handler, and the handler runs after this.

The fix for it already exists and is already on `main`: the signed session pass.
`middleware/auth.ts:154` calls `tryPassAuth` first, and a valid pass authorizes
with no database read at all. It is INERT until `SESSION_SIGNING_KEY` is set —
`sessionSigningSecret` returns null without it, and the whole path becomes a
no-op (`services/session-pass.ts:45`, deliberate, so the code could ship before
the secret existed).

So the defect being fixed here is narrower and it is real: **the state of that
secret was not observable from anywhere.** Not from the app, not from a check,
and `wrangler secret list` needs an account this repo's sessions do not hold. The
answer to "is the speed fix on?" was UNKNOWN, which is how a merged fix sits
switched off for a fortnight while its symptom keeps getting re-diagnosed.

**Fix.** `/api/admin/health/live` now reports `sessionSigning: { configured }`
and System Health renders it beside the Anthropic-key card, with the consequence
spelled out rather than implied ("Every request re-reads authorization from the
database").

Presence only. The flag is computed by calling `sessionSigningSecret(c.env)`, NOT
by a truthiness test on the raw secret — that helper also rejects a key under 16
characters, so a placeholder reads OFF here exactly as it behaves at runtime. A
panel that says "On" for a system still paying the full cost is worse than no
panel, and that is the whole content of the test.

**Test.** `src/routes/systemHealthSessionSigning.test.ts` — four cases: absent,
15 characters, 16 characters, and the secret never appearing in the response
body. Proved RED by swapping the call for
`!!(c.env as {…}).SESSION_SIGNING_KEY`:

```
AssertionError: expected { configured: true } to deeply equal { configured: false }
Tests  1 failed | 3 passed (4)
```

**What this does NOT do.** It does not make anything faster. Setting the secret
is the owner's action and the panel is how it gets confirmed afterwards.
**UNTESTED against production** — the flag has not been read off the live
deployment yet, so what it will say there is unknown; the reading is the point.

**Also ruled out, from the same data.** No `server-error` signature appeared in
two days, and `api/client.ts:420` reports every API 5xx including 504. The 504 in
the owner's capture was therefore NOT an API call made through the app — it was
the page document itself, which Cloudflare serves before any of this code runs.
Recorded because it is the theory not to re-chase.

**Ref.** perf/session-pass-visibility, 2026-08-31.
