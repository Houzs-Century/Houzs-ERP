# scm schema — what is in this repo, what is not, and how to rebuild

The `scm` schema (~120 tables) is the vendored 1:1 clone of the 2990's furniture
supply chain. **The numbered migration tree never creates it** — `migrations-pg/`
only ever `ALTER`s tables that are already there. This directory is where the
CREATE side lives, and it is incomplete. This file records exactly how.

## The gap

A from-scratch rebuild of `scm` **cannot currently be done from this repository
alone.** Four separate reasons, all verified:

1. **The views are not here.** `apply-scm-views.mjs:19` reads
   `C:/Users/User/Desktop/2990s/packages/db/migrations` — a hardcoded absolute
   path — and pulls 15 named migration files out of it. Nothing in *this* repo
   can produce those views.

   **The severity here is CI/portability, not data loss.** That path is a working
   copy of `github.com/wenwei4046/2990s`, and all 233 files under
   `packages/db/migrations` are tracked on its `origin/main` — including all 15
   this script names (verified 2026-07-17). So the view sources survive this
   machine. What does not survive is the script: it runs nowhere but a box with
   that exact absolute path, which is why it can never run in CI. Fix by checking
   the 2990s repo out and passing its path in, or by vendoring the 15 files here.

   The sharper problem is that the 2990s copies may no longer be **right**: `0106`
   rebuilt 8 views from `pg_get_viewdef` against the live DB precisely because the
   repo's copies had drifted.

2. **The tree calls functions it does not own.** `migrations-pg/0088` runs
   `CREATE OR REPLACE FUNCTION scm.fn_inventory_movement_fifo()`, whose body
   calls `fn_consume_fifo` / `fn_consume_fifo_batch`. Those two are defined only
   in `inventory-fifo-trigger.sql` in this directory, which is applied by a
   one-off script, not by the migration runner. The in-tree migration depends on
   an out-of-tree artifact.

3. **DDL has been applied out-of-band.** Two proven instances:
   - `DRAFT` is a live value of the `mfg_so_status` enum — written at
     `mfg-sales-orders.ts:4534`, with `DRAFT -> CONFIRMED` a live path — and it
     exists in **neither** SQL tree. Migrations 0040-0044 added `DRAFT` to the
     DO/SI/PO/GRN/PI enums; the SO never got one. The scan flow demonstrably
     works in prod, so the value was added by hand.
   - `inventory_movements.reason_code` is inserted by `inventory.ts:828` and
     `stock-takes.ts:427,544` with no fallback, and has no DDL anywhere.

4. **The DB is treated as ground truth, in writing.** `migrations-pg/0106`'s
   view bodies are byte-faithful `pg_get_viewdef` dumps, and the migration says
   why: the repo's copies had already drifted, so the live database was dumped
   instead. That is an honest workaround, and also an admission.

Net effect, stated precisely: **the production database is the only place that
reflects the schema as it actually is.** Not because the sources are lost — the
tables are here, the functions are here, and the views are in the 2990s repo on
GitHub — but because no combination of those sources adds up to prod:

- reasons 3 and 4 are only in the DB, by construction;
- reason 1's sources are a *different* repo, reachable only from one path;
- and `0106` proves the repo copies had already drifted from the DB once.

So a rebuild from the repos would produce something close to prod and wrong in
ways nobody has enumerated. That is the gap this snapshot closes. It is a
portability and drift problem, not an imminent data-loss one — do not overstate
it in either direction.

## What IS here

| File | Covers | Applied by |
|---|---|---|
| `2990s-full-schema.sql` (97 KB) | tables + enums, one drizzle-kit export | `apply-scm-schema.mjs` |
| `port-missing-functions-triggers.sql` (25 KB) | 12 functions + 2 triggers | `apply-missing-functions-triggers.mjs` |
| `inventory-fifo-trigger.sql` (11 KB) | `fn_consume_fifo`, `fn_consume_fifo_batch`, `fn_inventory_movement_fifo`, `trg_inventory_movement_fifo` | `apply-inventory-fifo-trigger.mjs` |
| `seed-scm-reference-data.sql` (164 KB) | reference/seed rows | manual |
| *(views)* | **nothing — see gap #1** | `apply-scm-views.mjs`, reading a sibling repo |

### These files are a PRE-MIGRATION baseline, not the live schema

They are replayed to rebuild the shape the migration tree then evolves, so they
deliberately still carry retired names. The one that catches people: the Sales
Order's Processing Date is `scm.mfg_sales_orders.processing_date` on any live
database, but `2990s-full-schema.sql` (and `consignment/0153_consignment_module.sql`
for the consignment twin) still say `internal_expected_dd`, because that is the
name the column had when the snapshot was taken. `migrations-pg/0284` renames it,
and a fresh build runs the snapshot FIRST and 0284 after, so the end state is
correct. Do not "fix" the snapshot — that would make 0284 a no-op on a fresh
build while the consignment table kept its dead legacy `processing_date`, and the
two databases would diverge on the exact column this whole saga is about.

## Taking the snapshot

`.github/workflows/dump-scm-schema.yml` — manual, read-only, defaults to staging.

```
gh workflow run dump-scm-schema.yml -f target=prod -f schema=scm
gh run download <run-id> -n scm-prod-schema
```

It runs `pg_dump --schema-only --no-owner --no-privileges --schema=scm` with a
PGDG-pinned client (ubuntu-latest ships pg_dump 16; Supabase runs 15/17 and
pg_dump refuses to dump a server newer than itself). The artifact is the
authoritative snapshot: tables, columns, defaults, constraints, indexes, enums,
sequences, functions, triggers, views, comments — including anything applied
out-of-band, which is precisely what the hand-maintained files above miss.

Commit the result here as `scm-prod-schema.sql`. Re-take it whenever `scm` gains
objects outside the migration tree.

## What the snapshot does NOT replace

It is a **rebuild artifact, not a migration.** Do not put it in `migrations-pg/`.
That directory is replayed against prod on every push to `main`
(`.github/workflows/deploy.yml:59`), and a file that fails blocks **all** deploys
— a `CREATE TABLE` against 120 tables that already exist would do exactly that.
