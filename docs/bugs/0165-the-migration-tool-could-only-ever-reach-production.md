## The migration tool could only ever reach production [medium]

**Symptom.** None visible, and that is the point. `pg-migrate.mjs` appeared to
work, because the only database anyone ever pointed it at was the one it could
reach.

**Root cause.** `pg-migrate.mjs:48` opened its connection with `ssl: "require"`
hardcoded. Correct for production — Supabase through Hyperdrive — and fatal
against any local PostgreSQL, which serves no TLS: the script dies in **0.059s**
with `Client network socket disconnected before secure TLS connection was
established`, inside `loadAppliedMigrationRows`, before reading a single
migration file.

**Why it matters more than a developer-convenience bug.** It means a migration
could not be applied anywhere except production, so the first real database any
migration ever met was the production one, during a deploy. That is exactly how
mig 0290 stopped the backend release on 2026-08-14
(`docs/migration-gate-coe.md`).

**Fix.** `backend/scripts/lib/pg-ssl-mode.mjs` — TLS required for everything
except the two loopback names spelled exactly, failing CLOSED on an unparseable
URL, an empty string, `undefined`, or a number. Keyed on the hostname rather than
an env var on purpose: a hostname comes from the target itself, so it cannot be
switched on by ambient configuration, whereas a stray `PGSSL=disable` in the
wrong environment file would silently downgrade a production connection. Against
the real DSN the value is `'require'` — byte-identical to the old behaviour.

**Test.** `backend/tests/pgSslMode.test.mjs`, wired into `test:scale-contract`.
The cases that carry the weight are the near-misses, all of which must still
require TLS: `localhost.evil.com`, `notlocalhost`, `127.0.0.1.evil.com`,
`127.0.0.2`, and a production host carrying `?host=localhost`. A hostname is
compared whole, never by prefix or suffix.

**Ref.** 2026-08-14. Found by building a CI gate that turned out not to work; the
gate is ruled out in the COE, this fix outlived it.
