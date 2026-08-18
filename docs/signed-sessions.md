# Signed session passes — the durable fix for the random logouts and the slowness

**Plain-language summary first.** Staff were getting randomly logged out
mid-action and the whole app was slow in bursts. The root cause was one thing:
**every single request re-checked the user's full permissions against the
database**, over one shared connection, and when the database hiccuped it threw
the user out. Measured 2026-08-18: the same tiny request came back in 0.36s, then
7s, then 13.6s, then 2s — wild swings, nothing to do with how much data there is.

The fix is what large ERPs do: **check the permissions ONCE at login, put them
in a signed "staff pass", and let each request check the pass locally without
touching the database.** A "cancelled-passes board" makes stopping someone's
access instant, so we don't lose the ability to revoke.

---

## How it is built, in five stages

Authentication is the one place a big-bang change can lock the whole company out,
so this shipped in stages, each one independently reversible:

1. **The pass machine** — sign and verify a pass. Wired into nothing.
2. **Issue at login** — every login mints a pass beside the existing token.
3. **Verify on each request** — a valid pass authorizes with no database read;
   any doubt falls back to the old database check.
4. **The cancelled-passes board** — logout voids that one device's pass; a role
   change or a disable voids all of that person's passes. Instant.
5. **Everything sends the pass** — desktop and the SCM screens (the slow ones).

All five are on `main` behind ONE switch, and **none of it does anything until
the switch is turned on.** With the switch off, every request runs exactly as it
did before — proven: the full backend test suite passes with the switch off.

---

## Turning it on — the one action, and it is the owner's

The switch is a Worker secret named `SESSION_SIGNING_KEY`. It is the private key
that signs the passes; it never appears in a pass, never leaves the Worker, and
must not be pasted into chat. Set it directly:

```bash
cd backend
npx wrangler secret put SESSION_SIGNING_KEY
# paste a long random value (32+ chars) when prompted
```

or in the Cloudflare dashboard: the Worker → Settings → Variables and Secrets →
add a secret named `SESSION_SIGNING_KEY`.

A key shorter than 16 characters is treated as unset (a placeholder can never
sign a real pass by accident), so use a long random string.

**What happens the moment it is set:**
- New logins mint a pass; those sessions stop hitting the database for auth and
  the logouts stop for them.
- People already logged in keep working on the old database path until they next
  log in and get a pass — a smooth, no-flag-day transition.

## Turning it off — the rollback

Delete the secret (`npx wrangler secret delete SESSION_SIGNING_KEY`, or remove it
in the dashboard). The next request from every device immediately takes the
database path again — the pass is simply ignored. Outstanding passes also expire
on their own after 8 hours. There is no data migration to undo.

---

## The trade, stated plainly

- A pass lasts **8 hours** (one working day). Within that window a request does
  not re-check the database, which is the whole speed win.
- **Stopping someone is still instant**, not delayed 8 hours: disabling a user or
  changing their role writes to the cancelled-passes board, and their next
  request is refused the fast path and re-checked. Logout voids just that device.
- If the cache that holds the board has a blip, passes are honoured (the database
  check is still the safety net) rather than locking everyone out — the same
  fail-open posture the session fallback uses.

## How to confirm it is working

After setting the secret and logging in fresh, the per-request database reads for
auth should drop to near zero (visible in `wrangler tail` or System Health as
fewer `getUserBySession` reads), and the 7–13s latency spikes on list pages
should disappear. The random logouts stop because a database blip no longer
fails an authenticated request — the pass carries it.

---

## For engineers — where the pieces are

| Piece | File |
|---|---|
| sign / verify primitive | `backend/src/services/session-token.ts` |
| envelope ↔ AuthUser, `mintSessionPass`, `tryPassAuth` | `backend/src/services/session-pass.ts` |
| cancelled-passes board (KV) | `backend/src/services/session-revocation.ts` |
| request gate (verify before DB) | `backend/src/middleware/auth.ts` |
| revoke on logout / role change | `deleteSession` (auth.ts), `bustUserSessions` (sessionCache.ts) |
| store + send the pass | `frontend/src/lib/authToken.ts`, `api/client.ts`, `vendor/scm/lib/authed-fetch.ts` |

The pass is **bound to the opaque token** (its `sid` is a hash of the token), so
a lifted pass presented with a different token is refused and falls back to the
database path. `exp` is mandatory; verification is constant-time; the secret is
never in a pass. The feature is a no-op while `SESSION_SIGNING_KEY` is unset.
