## The seed job read shadow secrets — `environment:` was the load-bearing line [medium]

**Symptom.** Four chart-seed dispatches with `target=staging` all died with
`ENETUNREACH 2406:da18:…` (runs 33705859454, 33706489206, 33707525935,
33708950277) while staging-migrate connected first-try in the same minute.
The fourth run — first with the 0628 in-script A-record resolution — finally
printed the host it was actually dialling:

```
no A record for db.anogrigyjbduyzclzjgn.supabase.co (getaddrinfo ENOTFOUND …)
```

`anogrigyjbduyzclzjgn` is the PROD project (wrangler.toml:126 — "SG company
project"). A staging dispatch was aimed at prod's direct host from run one.

**Root cause (traced).** GitHub resolves `secrets.*` by scope, and the seed
job declared no `environment:`. At REPO scope a stale `STAGING_DATABASE_URL`
(set 2026-07-06, per `gh secret list`) holds the PROD **direct** connection
string — and Supabase direct hosts here are IPv6-only, which is the one
mercy: every repo-scope read ENETUNREACHed instead of writing. The DSN that
actually reaches staging lives in the Staging ENVIRONMENT
(`gh api …/environments/Staging/secrets` lists it), which is why
staging-migrate.yml — `environment: Staging` since birth — never felt any
of this. Prod's working DSN is the repo-scope `DATABASE_URL` (Production
declares no same-name shadow; deploy.yml's pg-migrate step proves it every
release).

**Fix.** The seed job now carries
`environment: ${{ inputs.target == 'prod' && 'Production' || 'Staging' }}`
and keeps the same secret expression — with the scope right, the names
resolve to exactly the DSNs the migration pipelines demonstrably connect
with. RED state is the four runs above; the fix's witness is the next
dispatch's `connected via` line naming a reachable host.

**The rule to keep.** A workflow that touches a database states its
`environment:` — same-name secrets at different scopes are shadows, and a
job without the line silently reads the repo-scope one. And the stale
repo-scope `STAGING_DATABASE_URL` should be deleted at the source: today it
is a prod pointer whose only guardrail is an unroutable address family.
Sibling of [0628](0628-ipv4first-was-advisory-postgres-js-resolved-the-aaaa-itself.md),
which read the same wreckage and blamed the resolver — the ENOTFOUND line
this entry opens with is what proved the host had no A record to prefer.

**Ref.** fix/seed-environment-scope, 2026-09-03.
