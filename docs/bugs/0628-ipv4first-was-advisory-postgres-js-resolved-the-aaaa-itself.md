## ipv4first was advisory — postgres.js resolved the AAAA itself and burned every retry [low]

**Symptom.** The chart-seed workflow's THIRD dispatch (run 33707525935) —
already carrying the 0617 remedy, three connect attempts ten seconds apart
under `NODE_OPTIONS=--dns-result-order=ipv4first` — spent every attempt on
the SAME address:

```
connect attempt 1/3 failed: connect ENETUNREACH 2406:da18:… :5432
connect attempt 2/3 failed: connect ENETUNREACH 2406:da18:… :5432
connect attempt 3/3 failed: connect ENETUNREACH 2406:da18:… :5432
```

Not a sleeping database waking up slowly — the same IPv6 record every
swing, from a runner with no IPv6 route.

**Root cause (traced).** The control experiment: staging-migrate dispatched
in the SAME minute, same secret, same runner pool (run 33707616420) —
connected on its first attempt, exit 0, "343 migration(s), 361 applied".
The environment was fine; the difference was the client. postgres.js
performs its own hostname resolution and `--dns-result-order=ipv4first`
never reached it — the knob orders `dns.lookup` defaults for code that
uses the defaults, and this code path didn't. Retrying a deterministic
resolution just re-picks the same unroutable AAAA.

**Fix.** `seed-chart-of-accounts.mjs#connectWithRetry` now pins the family
itself: `dns.lookup(hostname, { family: 4 })` up front, and the client is
handed the IPv4 literal as `host` (`ssl: 'require'` performs no
certificate-chain verification, so an IP host connects fine). The hostname
stays as a same-attempt fallback and the 0617 three-attempt loop is kept
for the genuine nap case. Proof is operational, not a unit test: the red
runs above are the RED state, and the next dispatch's `connected via
<ipv4> (A record of …)` line is the fix witnessed.

**The rule to keep.** A direct-DB script pins the address family itself —
environment-level DNS knobs are advisory to whichever resolver a library
happens to use. Sibling of [0617](0617-first-strike-scripts-die-on-the-sleeping-staging-database.md):
the retry cures the nap, the pinned family cures the route, and a script
first striking a Supabase database wants both.

**Correction (same day).** The mechanism above is wrong. The very next run
(33708950277) — first with the in-script resolver — printed `getaddrinfo
ENOTFOUND` for the A record: the host had NO IPv4 address for any knob or
resolver to prefer, because the DSN pointed at the wrong database's
direct host entirely. The knob was never the story; the secret was. The
pinned-family lookup stays (it is how the truth surfaced, and it serves
the dual-stack staging host), but the actual bug is
[0629](0629-the-seed-job-read-shadow-secrets-environment-was-the-load-be.md).

**Ref.** fix/seed-chart-params, 2026-09-03.
