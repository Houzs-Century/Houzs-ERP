# Houzs ERP — D1 to Postgres Dropped DEFAULTs COE (Correction of Error)

**Date:** 2026-06-13 (first sighting) through 2026-07-13 (last repair) — a slow-burn incident with four distinct episodes.
**Trigger:** Staff hit `500 Something went wrong` on pages that had worked the day before. The clearest single report: **Sales Team and the org chart returned 500 for everyone** once Sales-department users needed backfilling. Later the same defect showed up as **data that looked wrong rather than broken** — form-intake service cases displayed `-` where the ASSR Timeline should have shown a submission time.
**Status:** All four known episodes repaired and tracked in `migrations-pg`. The loader defect that caused them was fixed on 2026-07-21 (`fix/d1-pg-loader-carry-defaults`); the sibling defects in the same three-field reconstruction — dropped FK `ON DELETE` actions, `CHECK`, `UNIQUE` — are not. See §5.

---

## 1. Incident — what happened and why

The D1 to Supabase Postgres cutover moved **110 tables / 51,413 rows** (`4d869d7c`, 2026-06-12) and flipped production the next day (Hyperdrive bound `0de30c27`; D1 binding removed `fd48ec8c`, both 2026-06-13). The data arrived intact. The **column defaults did not**, and neither did foreign-key `ON DELETE` actions.

Every insert path in this codebase that omits a column and lets the database fill it therefore started failing — on a `NOT NULL` column with a 23502 error surfacing as a 500, and on a nullable column by silently writing `NULL`.

### Root cause — read off the loader, not inferred from the symptom

**This describes the loader AS IT WAS. It was repaired on 2026-07-21 and the
repair is in the tree** — `load-d1-dump-to-pg.mjs` now reads `dflt_value` and
emits a Postgres `DEFAULT` for it (via `scripts/lib/sqlite-default-to-pg.mjs`,
which routes date/time defaults through the app's own `rewriteDialect()`), and
carries a comment at `:165-167` narrating the very defect below. §5 row 1 has
the closure and the two gaps that remain. Read on for the mechanism, not for the
current file.

`backend/scripts/load-d1-dump-to-pg.mjs` does not translate the D1 `CREATE TABLE` text. It replays the SQLite schema into an in-memory `better-sqlite3` database, reads each table back through `PRAGMA table_info`, and re-emits a Postgres `CREATE TABLE` from that metadata (`:138-146`).

The pragma row is destructured in the comment on `:138` as `{cid,name,type,notnull,dflt_value,pk}` — **`dflt_value` is named there and then never used**. The column definition it builds (`:141-143`) is:

```js
return `"${c.name}" ${mapType(c.type)}${c.notnull && c.pk === 0 ? " not null" : ""}`;
```

Name, mapped type, and `NOT NULL`. Nothing else. So the loader carried forward exactly the half of each column definition that makes an insert **fail**, and dropped the half that makes it **succeed**. `git show 4d869d7c:backend/scripts/load-d1-dump-to-pg.mjs` confirms those lines (then `:131-136`) were byte-identical on the day the production load ran — this is the code that built the live schema, not a later edit.

The same three-field reconstruction explains the sibling failure the audit found the following day: **FK `ON DELETE CASCADE` / `SET NULL` all became `NO ACTION`**, because the pragma walk never read `foreign_key_list` either (`61fb5064`, 2026-06-14 — deleting a role or a position 500'd because its matrix rows were still there; "nearly every real position has these, so this 500'd almost always").

### Why the drizzle baseline did not save it

`migrations-pg/0000_baseline.sql` (`75bc865a`, 2026-06-12) is a drizzle-generated baseline for 57 tables and it **does** carry defaults — 101 `DEFAULT` clauses. It made no difference: the loader's step 3 issues `DROP TABLE IF EXISTS … CASCADE` against **every** table in `public` and then recreates all 110 from the pragma metadata (`load-d1-dump-to-pg.mjs:128-133`). The good baseline was dropped by the lossy loader that ran after it. A reviewer reading `0000_baseline.sql` would have concluded the defaults were fine.

---

## 2. Fixes shipped — four episodes, one class

| Ref | Date | What | Effect |
|----|------|------|--------|
| `a370a614` | 2026-06-13 | **First sighting, misdiagnosed as a seed problem.** `seed-user-management.mjs` given explicit values for `departments.color/sort_order`, `roles.scope_to_pic`, `users.points_balance/gifting_balance/current_streak`. Commit message reasons it away: *"The app inserts via Drizzle (which fills them) so this only bit the raw seed."* | Unblocked the prod seed (3 departments, 17 positions, 17 test accounts). **Did not fix the database.** The premise was wrong within 18 hours. |
| `8f0b8bac` + **mig `0011_sales_reps_defaults.sql`** | 2026-06-14 | `sales_reps.is_admin` and `commission_min_rate` are `NOT NULL` with no default. `autoBackfillSalesReps` inserts only `(code,name,email,user_id,status)` — the INSERT threw, so `GET /api/sales-team/reps` 500'd and **Sales Team plus the org chart were down**. | Restored both defaults. Auto-create INSERT verified working. |
| **mig `0012_restore_dropped_defaults.sql`** (applied to prod 2026-06-14, tracked by `134a8041`) | 2026-06-14 | **The systematic sweep** — stopped chasing instances and restored the D1 originals wholesale: 12 columns across 7 tables (`users` ×3, `sales_positions` ×3, `suppliers`, `warehouses`, `trips`, `trip_proposal_trips`, `user_streak_weeks` ×2). Values taken from the D1 `schema.sql` / migrations, not guessed. | Closed the `NOT NULL`-insert-throws variant for the core ERP tables. Idempotent, additive, existing rows untouched. |
| **mig `0054_restore_is_active_defaults.sql`** (applied to prod manually 2026-06-26; filed by **PR #120**, `7eddca7f`, 2026-06-27) | 2026-06-26/27 | `is_active DEFAULT 1` restored on `assr_lead_time_profiles`, `creditors`, `lorries`, `stock_items`. All four bigint, 0 existing NULL rows. | Closed the `is_active` variant. **Also unblocked prod:** see §3. |
| **PR #373** → **mig `0098_restore_timestamp_defaults.sql`** (`c72a7e76`, renumbered `407edd0a`) | 2026-07-13 | **The silent variant, found a month later.** The cutover dropped `DEFAULT (datetime('now'))` on **every** row-creation stamp column. These are nullable, so nothing 500'd — inserts just wrote `NULL` for a month. Part 1 restores the default on **77 `created_at` / `uploaded_at` / `entered_at` columns across 77 tables**, generated from the live `information_schema`, not from the migration tree. Part 2 backfills only what is honestly derivable: ASSR cases and intake notes from the `[gform:]` note's submission timestamp (MYT to UTC), photo rows from the epoch-ms embedded in the R2 key, remaining Farra-import rows from `complained_date`, `sessions` from `expires_at` minus the 7-day TTL. | 23 tables had accumulated NULLs; the ASSR family drops to zero. Dry-run in a rollback transaction against prod: 85 statements pass, 15 cases / 865 activity / 323 attachments / 16 tokens / 58 sessions backfilled, sample `ASSR/2607-021` lands on its exact form-submission second. **Everything not derivable was left NULL on purpose** (`email_log`, `project_*`) — the migration's own header says so. |

---

## 3. The secondary incident this caused — the fix blocked all prod deploys

The `is_active` repair was first written as `migrations/104_restore_is_active_defaults.sql` — the **D1/test** tree, not the live Postgres tree. `ALTER TABLE … ALTER COLUMN … SET DEFAULT` is Postgres-only; SQLite has no `ALTER COLUMN`. The D1 test-migration runner (`tests/setup.ts`) threw `D1_ERROR: near "ALTER": syntax error`, `npm test` went red, and `npm test` is the gate immediately before `wrangler deploy` in `deploy.yml`. **Every backend deploy on main was blocked** until PR #120 (`7eddca7f`) turned `migrations/104` into a deliberate SQLite-safe `SELECT 1;` no-op and moved the real DDL to `migrations-pg/0054`.

This is the two-tree hazard `CLAUDE.md` now warns about, discovered by walking into it: a Postgres repair filed in the tree production does not read, which then took the deploy pipeline down with it.

---

## 4. What the record does NOT show

- **No enumeration of the total blast radius was ever done.** Four repairs recovered `sales_reps` (2 cols), 7 core tables (12 cols), `is_active` (4 tables), and creation stamps (77 columns). Nobody has diffed the full D1 schema's `dflt_value` set against the live `information_schema` to prove the list is complete. Non-`NOT NULL`, non-timestamp defaults — status strings, sort orders, numeric zeros on nullable columns — would fail exactly as quietly as the timestamps did, and would still be failing.
- **The 2026-06-14 dashboard 500 repairs (`b0e00159`) are not attributable.** They land the same day and in the same class of symptom, but the commit does not name dropped defaults, so this COE does not claim them.
- **BUG-HISTORY.md:3421 says "~10 tables."** The evidence in the migration tree says at least 88 tables across the four episodes. The `~10` line is from the 2026-07-14 backfill-from-memory pass (PR #449) and predates PR #373; treat the migrations as authoritative.

---

## 5. Deferred

| Item | Owner | Note |
|------|-------|------|
| ~~**The loader still drops defaults.**~~ **CLOSED 2026-07-21** by `fix/d1-pg-loader-carry-defaults` — the loader now emits `dflt_value` as a Postgres `DEFAULT` (292 carried against the current schema, 1 refused with a named warning), translating date/time stamps through the app's own `rewriteDialect()` rather than a second copy of the rules. `NOT NULL`, types, PKs and the DROP/CREATE order are untouched, and the two remaining gaps in this row — `foreign_key_list`, `CHECK`, `UNIQUE` — are still NOT read. Original text: `load-d1-dump-to-pg.mjs:141-143` was unchanged at `9db13349`. It reads `dflt_value` in a comment and emits nothing for it, and never reads `foreign_key_list`, `CHECK`, or `UNIQUE` at all. | Owner / whoever runs the next cutover | It has one guard, and it is about a different hazard: `:16-22`, added after "the 2026-06-17 incident where this wiped prod", refuses to run against the prod project ref without `ACK_PROD_WIPE=yes`. Nothing warns that a run which *is* authorised will produce a schema missing every default. If this script is ever pointed at a fresh environment, all four episodes recur at once. Either carry `dflt_value` through, or delete the script now that the cutover is done. |
| **Completeness audit of surviving dropped defaults.** | Owner | The repo has `check-money-types.mjs` and `check-indexes.mjs` but no defaults checker. A one-shot `information_schema.columns.column_default IS NULL` comparison against the D1 schema would either close this out or produce the fifth episode's list before a user does. |
| **Restoring dropped FK `ON DELETE` actions in the schema.** | Owner | `61fb5064` fixed this in *application code* — five delete paths now clear children by hand. The constraints themselves are still `NO ACTION` in prod, so every future delete path inherits the same trap. `BUG-HISTORY.md:2096` records `positions.ts:299` clearing children "because the D1→PG load dropped the FK to NO ACTION" — the workaround is now load-bearing and undocumented at the schema level. |

---

## 6. Lessons

1. **A bulk loader must carry the whole column definition or refuse to run.** This one carried `name + type + NOT NULL` and dropped `DEFAULT`, FK actions, `CHECK`, and `UNIQUE`. That specific subset is the worst possible one: it preserves every constraint that makes an insert *fail* and discards every one that makes it *succeed*. A loader that had dropped `NOT NULL` too would have been noticed in a day.
2. **Verify schema claims against the live DB, not migration files.** `0000_baseline.sql` shows 101 correct `DEFAULT` clauses and was, for those tables, fiction — the loader `DROP TABLE … CASCADE`'d it minutes later. PR #373 got this right and it is why it worked: its 77 `ALTER`s were **generated from the live `information_schema`**, and it was dry-run inside a rollback transaction against prod before merge. (Same lesson, independently learned, as the money-column claim refuted in `system-foundation-coe.md` §3E.)
3. **A missing default has two symptoms, and the loud one arrives first.** On a `NOT NULL` column it is an instant 500 and gets fixed in a day. On a nullable column it is a `NULL` that nobody sees for a month, until a UI renders `-` where a timestamp should be — and by then the data is unrecoverable except by forensics on R2 keys and note strings. **After any bulk load, sweep the nullable columns too; do not stop when the 500s stop.**
4. **"The app inserts via Drizzle, so this only bit the raw seed" was wrong within 18 hours.** `a370a614`'s reasoning was plausible and cost a day. When a defect is found in a seed script, the question is not "does the app use this path" but "what else did the same upstream step drop" — the systematic sweep (`0012`) should have been episode one, not episode three.
5. **A Postgres-only repair filed in `migrations/` takes the deploy pipeline down.** `ALTER COLUMN` does not parse in SQLite, `npm test` runs the D1 tree, and `npm test` gates `wrangler deploy`. Check which tree you are in *before* writing the file; `CLAUDE.md`'s *Migrations — two trees, only one is real* section exists because of this episode.
6. **`NOT NULL` without a `DEFAULT` is a production incident waiting for a code path that omits the column — and this repo has now had it twice from unrelated causes.** Migration `0091_company_id_defaults.sql` is the second: *"PROD INCIDENT 2026-07-13: 0083/0086/0087/0089 added company_id NOT NULL to ~120 tables … no DB default, no trigger. Any path that was never taught to stamp now violates NOT NULL and 500s."* Different origin, identical failure. **When you add `NOT NULL` at scale, add a safety-net `DEFAULT` in the same migration.**

---

## See also

- `docs/system-foundation-coe.md` — §3B covers the sibling class from the same cutover (SQLite dialect surviving into Postgres), and §3E is the money-column claim refuted against the live DB.
- `docs/api-fetch-hardening-coe.md` — §D records the `is_active` episode (2026-06-26) as one line of a wider hardening campaign; this COE is its full write-up.
- `BUG-HISTORY.md:3421` — the one-line backfilled entry this document replaces.
