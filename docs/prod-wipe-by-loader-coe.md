# Houzs ERP — Production Wiped by the D1→Postgres Loader COE (Correction of Error)

**Date:** 2026-06-17, some time before 17:38 MYT (09:38 UTC). Narrowed to a ~7-hour window in §2.
**Trigger:** **Unknown — and that is the first finding.** No staff report, no screenshot, no bug entry, no commit message describing it. What exists is one sentence someone left in the code afterwards:

> `// PROD GUARD (added after the 2026-06-17 incident where this wiped prod):`
> — `backend/scripts/load-d1-dump-to-pg.mjs:16`

**Status:** Recovered (§2 shows the database was whole again within hours). One guard shipped, the same day. **No BUG-HISTORY entry, no COE until now** — a production database was dropped and reloaded, and the entire institutional memory of it is a parenthetical in a code comment.

> **This COE is held to a lower evidentiary standard than `system-foundation-coe.md` or `deploy-collision-coe.md`, and says so on purpose** — the same declaration `docs/cloudflare-plan-cap-coe.md` makes, for the same reason. Those documents quote live `wrangler tail` captures and PR timestamps. Here the incident itself is attested by a single code comment. What *is* reconstructible with hard evidence is the **mechanism** (exactly what the script did, and how it came to be pointed at production) and the **aftermath** (a forensic signature showing the database was restored rather than rebuilt). What is not reconstructible is separated out in §5. **Do not cite §5 as established.**

---

## 1. Root cause — what the script did, and why production was its default target

`backend/scripts/load-d1-dump-to-pg.mjs` is the D1→Postgres cutover loader. Its own header states the contract: *"Idempotent: wipes public first."* Concretely, `:130-134`:

```js
const exist = await pg`select tablename from pg_tables where schemaname='public'`;
if (exist.length) {
  await pg.unsafe("DROP TABLE IF EXISTS " + exist.map((r) => `"${r.tablename}"`).join(",") + " CASCADE");
```

**It drops every table in `public` — enumerated from the live catalogue, not from a list — with `CASCADE`, and then recreates only the tables present in a local SQLite dump file.** Anything in `public` that is not in that dump is destroyed and not recreated. There is no `--dry-run`, no confirmation prompt, no row-count check, and no output beyond `dropped N existing tables`. Everything after the DROP is unreachable as a safety measure, because the DROP is the first thing it does.

### How it came to be aimed at production

Before the guard, the target was resolved by a single line — `git show 7fef9f65` records exactly what it replaced:

```js
-const url = readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)[1];
```

**There was no argument, no environment variable, and no target check. The script read one file, and ran.** `.dev.vars` is the Cloudflare Workers local-development secrets file; it is gitignored (`.gitignore:12-13`) and there is no `.dev.vars.example` in the tree, so nothing in the repository shows a newcomer what it is expected to contain.

What it *did* contain is corroborated by the sibling scripts written in the same days, which read the same file and describe its value in their own comments:

- `backend/scripts/test-pooler.mjs:1-12` (added 2026-06-13, `b6692450`) — *"connect DIRECTLY to **Houzs's Supabase poolers** … measure whether the 6543 transaction pooler is healthy for **THIS database**"*, reading `.dev.vars` `DATABASE_URL`.
- `backend/scripts/probe-poolers.mjs:1-8` — *"Incident diagnostic … Reads only this workspace's own `.dev.vars`"*, then probes the live 5432 and 6543 poolers.
- `docs/DB-REPOINT-RUNBOOK.md:20-24` instructs the operator, in the ordinary course of work, to put a **live** connection string into `.dev.vars` and then run this very loader against it.

So the working convention was that `.dev.vars` holds a real, live connection string — and the loader's only input was that file. **Running the cutover loader from a working checkout, with no arguments, aimed a `DROP TABLE … CASCADE` over every table in production.** No mistake beyond "ran the script in the wrong terminal" is required.

And production was, by then, live on that database: Hyperdrive config `f0f9bd0d` had pointed at the SG project `anogrigyjbduyzclzjgn` since 2026-06-13 (`b5e34986`, `backend/wrangler.toml:79-90`), and `deploy.yml` was applying migrations to it on every push. The dump the loader reloads from was the 2026-06-12 export — *"110 tables, 51,413 rows"* (`4d869d7c`). **Reloading it over a database that had been serving since 2026-06-13 replaces live data with a snapshot several days stale.**

---

## 2. Timeline, and the forensic signature of the recovery

Times UTC (MYT is +8). The `_pg_migrations` counts are printed by `pg-migrate.mjs` on every deploy and preserved in the GitHub Actions logs — which makes the deploy log an unintentional integrity probe, because that tracker table lives in `public` and would be dropped along with everything else.

| UTC | Evidence | What it establishes |
|-----|----------|---------------------|
| 2026-06-12T11:22Z | `4d869d7c` | The dump the loader reloads: 110 tables, 51,413 rows. |
| 2026-06-13T~04Z | `b5e34986`, `wrangler.toml:79-90` | Production points at `anogrigyjbduyzclzjgn`. |
| **2026-06-17T02:30:50Z** | Deploy job log, run `27661772803`: `18 migration(s), 18 applied, 0 pending` | Last pre-incident state: `public._pg_migrations` holds **18** rows. |
| **≤ 2026-06-17T09:38Z** | `7fef9f65` (author = committer date) | The incident happened before the guard was committed. Combined with the row above: **the incident falls inside 02:30Z–09:38Z.** |
| 2026-06-17T09:38:30Z | `7fef9f65` | The guard ships, in the same commit as the isolated staging environment. |
| **2026-06-17T11:55:10Z** | Deploy job log, run `27687022173`: `22 migration(s), **18 applied, 4 pending**` | **The decisive observation.** |
| 2026-06-17T12:03:06Z | Deploy job log, run `27687452575`: `22 migration(s), 22 applied, 0 pending` | Normal service; the 4 new migration files apply. |

**Why the 11:55Z line matters.** `pg-migrate.mjs` creates `_pg_migrations` if absent and reports what it finds. Had the loader run against production and left it in its own output state, that table would have been dropped and not recreated — the next deploy would have printed **`0 applied, 22 pending`** and re-run every migration. It printed **18 applied**: not zero, and not the 22 that a manual catch-up would have produced. That is the *exact* pre-incident count, four files behind the tree.

**The database was returned to a prior point in time, not rebuilt forward.** A restore-to-timestamp produces precisely this signature; re-running the migration tooling does not. That is as far as the evidence goes — see §5.

---

## 3. Fixes shipped

| Ref | Date | What | Effect |
|-----|------|------|--------|
| `7fef9f65` | 2026-06-17 | Two changes in one commit. (a) **The guard** — first cut: the target could come from `DATABASE_URL` *falling back to `.dev.vars`*, and the script refused when the URL contained the production project ref unless `ACK_PROD_WIPE=yes`. (b) **An isolated staging environment**: `wrangler.toml [env.staging]` on its own Hyperdrive → the staging Supabase project `minnapsemfzjmtvnnvdd`, plus a ref-locked `drizzle.config.staging.ts`. | The one-command path from a working checkout to a production wipe is closed. The staging environment is the more durable half: it gives destructive work somewhere legitimate to go, so the reason to point the loader at prod largely disappears. |
| — | since | **The guard was rewritten and this row described the OLD one until 2026-08-13.** Today `load-d1-dump-to-pg.mjs:26-50` has **no `.dev.vars` fallback at all** (it exits 1 demanding an explicit `DATABASE_URL`) and **no project-ref check**. It is an allow-list, FAIL CLOSED: any target whose hostname is not `localhost` / `127.0.0.1` / `::1` is treated as production and requires `ACK_PROD_WIPE=yes`. The code says why in its own comment — *"A hardcoded prod-ref substring check fails OPEN the moment prod moves projects (it has, twice)."* | Strictly stronger: a NEW production project is protected on day one, where the ref check would have waved it through. |

**Read the code, not this table.** Every line reference in this COE was stale by
2026-08-13 — the DROP it cites at `:130-134` is at `:160`, and the
`// PROD GUARD (added after the 2026-06-17 incident where this wiped prod):`
comment quoted as the Trigger's only evidence no longer exists anywhere in the
file; the incident is now recorded at `:26-28`. The test it names is
`backend/tests/scaleTargetGuard.node.mjs`, not `.test.mjs`.

That was the complete remediation at the time. Nothing else in the repository —
no test, no CI check, no documentation, no BUG-HISTORY entry — refers to this
incident.

---

## 4. What this COE rules OUT

- **Not the same event as the owner-data restore of 2026-06-15/16, though it looks adjacent.** `d12b7a03` / PR **#24** built `restore-owner-data.mjs` because *"the cutover rebuilt prod from `main` without"* the owner's May/June amendment data. That is a **different** loss (64 projects, 3 lorries, 14 staff), a different cause (the cutover simply did not carry the data), and it was dispatched on **2026-06-15** — three runs at 17:48Z, 17:52Z, 18:00Z, per the Actions history of `restore-owner-data.yml`. **It ran two days before this incident and was never run again**, so it is not the recovery mechanism here either.
- **Not the dropped-DEFAULTs incident, even though it is the same file.** `docs/pg-migration-dropped-defaults-coe.md` traces four repair episodes to this loader reading `dflt_value` from `PRAGMA table_info` and never emitting it. That is a **schema-fidelity** defect that ships bad columns; this is a **targeting** defect that destroys data. Same script, two independent production incidents, and neither would have been prevented by the other's fix. **That coincidence is itself the finding** — see §6.
- **Not prevented by anything that existed at the time.** There was no dry-run, no target allow-list, no environment separation (staging arrived in the same commit as the guard), and no backup step in the script. `restore-owner-data.yml` had shown the better pattern two days earlier — it `pg_dump`s the affected tables to a 90-day artifact **before any write, and aborts if the backup fails** (PR #24) — but the loader had nothing comparable, and still does not.
- **Not a `pg-migrate` failure.** The migration runner is transactional per file and never drops tables. The deploy failures on 2026-06-17 at 11:43Z and 11:54Z were a TypeScript error and a `wrangler` step failure respectively, unrelated to the data.

---

## 5. What the record does NOT show

- **How the data was restored.** This is the most important gap and it must not be papered over. The 11:55Z log proves the database was **back in a prior state**; it says nothing about how. A Supabase point-in-time restore fits the signature, and so would a restore from an operator's own dump. **The repository contains no evidence of a backup, no restore command, no artifact, and no workflow run.** Do not read this document as establishing that a backup existed.
- **What was lost, if anything, and for how long.** A restore-to-timestamp is not lossless: writes between the restore point and the incident are gone. Whether any real work fell in that gap — orders, projects, service cases entered on 2026-06-16/17 — is not recorded anywhere.
- **How long production was down or wrong.** The window is bounded at 02:30Z–09:38Z by the deploy logs, but nothing narrows it further, and nothing says whether staff were using the system at the time.
- **What staff saw.** Nothing. No report, no screenshot, no quote — unlike every other COE in this directory, this one cannot open with the user-visible symptom, because none was recorded.
- **Who ran the script, or why.** `7fef9f65` is authored by `unknown <weisiang329@gmail.com>`, the same identity as most commits that week, and its message describes the staging work rather than the incident.
- **Whether it had ever happened before.** The loader had existed since `4d869d7c` (2026-06-12) with the unguarded `.dev.vars` line. Five days, no guard, and no record either way.

---

## 6. Deferred

| Item | Owner | Note |
|------|-------|------|
| **All three targeting gaps are CLOSED — re-verify before trusting this line.** | — | Re-checked 2026-08-13 by reading the code. (1) The project-ref substring test is GONE: `load-d1-dump-to-pg.mjs:34-50` fail-closes on any non-loopback host, so a NEW production project is protected on day one — the string `anogrigyjbduyzclzjgn` appears nowhere in the file. (2) `copy-pg-to-pg.mjs:42-49` gained the same guard, plus a same-source-and-target refusal at `:50-53`; its `TRUNCATE` is at `:81`, not `:43`. (3) The `.dev.vars` fallback is removed — the script exits 1 demanding an explicit `DATABASE_URL`. **Still open below:** `ACK_PROD_WIPE` protects against an accident, not against a mistake, and there is still no backup step. |
| **`ACK_PROD_WIPE=yes` protects against an accident, not against a mistake.** | Owner | It stops the wrong-terminal case, which is the case that happened. It does not stop an operator who reads the refusal, sets the variable, and is wrong about which database they are re-cutting over. A dry-run that prints the target host, the table count and the row count it is about to destroy — and a `pg_dump` first, as `restore-owner-data.yml` already does — would. |
| **This incident is absent from `BUG-HISTORY.md`.** | whoever lands this COE | `CLAUDE.md:6-8` makes the ledger mandatory for **every** bug. A production wipe is the largest entry that has ever been missing from it. |
| **PR #975 (open) touches this same script.** | reviewer of #975 | It fixes the dropped-DEFAULT half. Worth stating in the review that the file has now caused **two** production incidents by two unrelated mechanisms, and that the targeting half above is still open. |

---

## 7. Lessons

1. **A script whose first act is `DROP TABLE … CASCADE` must take its target explicitly, and must refuse everything it does not recognise.** The pre-guard loader read one gitignored file and ran. The fixed loader refuses one hardcoded string and runs against everything else. Both are allow-by-default; only the size of the hole changed. **The correct shape is an allow-list — name the environments this may touch, refuse the rest, and fail closed on anything unparseable.** `scale-target-guard.mjs` is that shape and is already in this repo, written later, by someone who had presumably learned this.
2. **`.dev.vars` is a production credential store in this project, whatever its name suggests.** Three separate scripts read it and describe its contents as the live database, and the repoint runbook instructs an operator to put a live URL there. Any tool that defaults to it is defaulting to production. The name says "dev"; the contents do not.
3. **Separating environments is a better fix than guarding the destructive path — and both belong in the same commit.** `7fef9f65` shipped the guard *and* the isolated staging project together, and the staging project is the half that removes the reason to aim at prod at all. A guard on a tool that has nowhere else to point is a speed bump.
4. **The backup step belongs inside the destructive tool, not in the operator's habits.** `restore-owner-data.yml` — written two days earlier, by the same team, for a far less dangerous operation — `pg_dump`s the affected tables to a retained artifact **before any write and aborts if the backup fails**. The loader, which drops everything, has no such step and still does not. **The right test is "would this tool refuse to proceed without a recovery point?", not "did someone remember to take one?"**
5. **When the fix is a guard, the guard's comment is the only record the incident will ever get — so write the incident into it, or write a COE.** One parenthetical carried this for 34 days and it was nearly enough: it gave the date, the script and the outcome. It did not give the impact, the recovery, or the reason anyone should treat the remaining unguarded tools as urgent. **A comment can name an incident; it cannot document one.**
6. **One script, two production incidents, by two unrelated mechanisms.** This loader destroyed production data by being pointed at the wrong database, and separately shipped a schema missing every column DEFAULT — four repair episodes over a month (`docs/pg-migration-dropped-defaults-coe.md`). Neither fix would have caught the other. **A one-shot migration tool that survives past its migration becomes permanent infrastructure without ever being reviewed as such** — it is still in the tree, still executable, still the documented first step of the repoint runbook.

---

## See also

- `backend/scripts/load-d1-dump-to-pg.mjs:15-22` (the guard) and `:130-134` (the DROP it guards).
- `7fef9f65` — the guard plus the isolated staging environment; `git show 7fef9f65` for the one-line target resolution it replaced.
- `backend/scripts/scale-target-guard.mjs` + `backend/tests/scaleTargetGuard.test.mjs` — the allow-list guard pattern this file should adopt.
- `backend/scripts/copy-pg-to-pg.mjs:43` — the unguarded `TRUNCATE` on the next step of the same runbook.
- `.github/workflows/restore-owner-data.yml` and PR **#24** — the backup-before-write pattern that already existed here.
- `docs/DB-REPOINT-RUNBOOK.md:20-24, 28-31` — the procedure that puts a live URL in `.dev.vars` and then runs both scripts.
- `docs/pg-migration-dropped-defaults-coe.md` — the other production incident caused by this same file.
