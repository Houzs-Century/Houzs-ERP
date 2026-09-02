## "Remember me on this device" never reached the server, so everyone was signed out every 7 days [medium]

<!-- area: Auth, permissions, sessions -->

**Symptom.** Owner, 2026-09-02, on the installed PC app: "why all save email
password gone, fix it" — then, when told the app only ever remembers the email:
"cant keep permanently?" … "i didnt use chrome, i remember me on app on pc".

**Root cause (traced).** Two separate things, and only one of them was ours.

The password in that box was never the ERP's: the app stores the last email
(`houzs:login:lastEmail:v1`) and nothing else, and the live login form is
correctly marked up for a password manager — verified on production:
`<form>` with `type=email name=email autocomplete=username` and
`name=password autocomplete=current-password`. Nothing in the app can save,
read or delete a stored password.

What WAS ours: `createSession` issued a flat `SESSION_TTL_SECONDS` = 7 days for
every login, and the "Remember me on this device" checkbox never left the
browser. `AuthContext.login(email, password, remember)` posted only
`{ email, password }`; `remember` chose `localStorage` over `sessionStorage` for
the token and nothing else. So the tick changed whether the token survived
closing the app — never how long the SERVER would honour it. Seven days after
any login, every member of staff was signed out and had to type a password
again, which is the moment a missing browser-saved password is felt.

**Fix.** A ticked box now mints a ROLLING session. `sessions.renew_seconds`
(migrations-pg/0332 + D1 parity 153) carries the session's own renewal window:
NULL keeps today's fixed 7-day session, and `REMEMBER_TTL_SECONDS` (1 year) is
written for a remembered login. `renewRollingSession`, called from
`getUserBySession` AFTER the session is proven live and BEFORE the cached-envelope
return, pushes `expires_at` back to a full window once more than half of it is
spent. A device in weekly use therefore never signs out; one abandoned for a
year still expires. At most one UPDATE per half-window (about one write every
six months per session), and a failed renewal is swallowed — the session stays
valid to its stored expiry and the next request retries.

The 2FA path carries the choice through the KV challenge (`"<userId>"` legacy,
`"<userId>:1"` when remembered) rather than trusting the client to re-assert it.

Revocation is unchanged and still absolute: disabling a user or changing a
password deletes their session rows, so a lost device is cut off immediately.

`backend/tests/rememberMeRollingSession.test.ts`, four tests, PROVED RED on the
unfixed tree (the renewal case fails; the three non-renewal cases pass, which is
the point — they pin what must NOT change).

**Ref.** fix/remember-me-permanent, 2026-09-02.
