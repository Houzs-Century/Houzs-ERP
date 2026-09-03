## First-strike scripts die on the sleeping staging database — every direct-DB script needs pg-migrate's three-attempt patience [low]

**Symptom.** The chart-seed workflow's first two dispatches failed before
doing anything (runs 33705859454, 33706489206):

```
Error: connect ENETUNREACH 2406:da18:… :5432
```

The second run already carried `NODE_OPTIONS=--dns-result-order=ipv4first`
(the staging-migrate remedy) and still died — on the FIRST connection
attempt, with no second swing.

**Root cause (traced).** Staging's Supabase sleeps between uses. A waking
instance answers DNS before it answers connections (and in that window the
reachable answer may be the IPv6 record GitHub runners cannot route to).
staging-migrate.yml has known this since 2026-08: its migrate step retries
three times, ten seconds apart, and the warning text says "the staging
database may be paused or waking". The new seed script connected once and
gave up — the remedy existed in the sibling and simply was not copied.

**Fix.** `seed-chart-of-accounts.mjs` connects with the same patience:
three attempts, ten seconds apart, a fresh client each try,
`connect_timeout` 20s. `NODE_OPTIONS=--dns-result-order=ipv4first` stays on
the workflow.

**The rule to keep.** Any script that opens its own connection to a
Supabase database (seed, probe, repair) carries the three-attempt connect
from day one — the first strike against staging lands on a sleeping
instance more often than not, and a one-shot connect turns a nap into a red
workflow.

**Second act (same day): the retry was not enough either.** Run
33707525935 spent all three attempts on the SAME AAAA address —
`NODE_OPTIONS=--dns-result-order=ipv4first` never reached postgres.js's own
name resolution, while pg-migrate (same secret, same runner pool, same
minute, run 33707616420) connected on its first try. The sleeping-database
theory was wrong for THIS failure; the address family was the whole story.
The durable fix: the script resolves the A record itself
(`dns.lookup(hostname, { family: 4 })`) and hands the client the IPv4
literal — `ssl: 'require'` performs no certificate-chain verification, so
an IP host connects fine — with the hostname kept as a fallback and the
retry loop retained for the genuine nap case. **The amended rule: a
direct-DB script pins the address family itself; environment-level DNS
knobs are advisory to whichever resolver a library happens to use.**
