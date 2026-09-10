## The orphan-deposit audit queried the public schema not scm, so it errored on a renamed money column [low]

**Symptom.** The first prod run of the orphan-deposit audit
(`check-orphan-scan-deposits.mjs`, shipped in #3550 for docs/bugs/0785) exited
non-zero with `PostgresError: column "amount_sen" does not exist`, hint
`Perhaps you meant to reference the column
"mfg_sales_order_payments.amount_centi"`. No list was produced.

**Root cause (traced).** The app reaches the SCM tables through a Supabase client
pinned to `db: { schema: "scm" }` (`backend/src/db/supabase.ts`), but the audit's
raw `postgres` connection does NOT inherit that — it defaults to the `public`
search_path. An unqualified `mfg_sales_order_payments` therefore resolved to a
LEGACY `public.mfg_sales_order_payments`, which still carries the pre-0305
`amount_centi`. The live table (renamed centi->sen by migration 0305) is
`scm.mfg_sales_order_payments.amount_sen`. The script was written against the
column names in the app CODE (`amount_sen`) without confirming which SCHEMA a raw
connection would hit — the schema-vs-code gap the system-foundation COE warns of.

**Fix.** Schema-qualify both tables as `scm.mfg_sales_orders` /
`scm.mfg_sales_order_payments` in the audit, and in the new repair script
(`repair-orphan-scan-deposits.mjs`) built the same way. Re-run was clean and
listed 9 affected orders (8 realized, 1 at risk). Verified against the live DB via
the workflow, not against the migration file. No behaviour change beyond the
schema qualification; still one read-only SELECT. (No unit test — the failure was
schema-shaped, caught and re-proved by the workflow's own live run.)

**Lesson.** A raw `postgres`/`pg` connection ignores the app's `db: { schema }`
scoping and lands on `public`. Any standalone script hitting SCM tables must
schema-qualify `scm.*` (or set `search_path`), and its column names must be
checked against the LIVE schema — a legacy `public` twin of a renamed table
resolves silently and fails on the column (or, worse, reads stale data) rather
than erroring on the table name.

**Ref.** fix/orphan-audit-scm-schema, 2026-09-10.
