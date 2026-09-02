## Migration 0344 named a bank table that has never existed and blocked the production deploy [high]

**Symptom.** The Deploy run for #2881 (run 33640908643, 2026-09-02 14:19Z)
concluded `failure` with the `backend` job `failure`. Nothing shipped, and
because a failed migration blocks every later one, the next merge's deploy would
have failed the same way. The accountant's chart relay never ran, so the ERP's
account codes were unchanged in production.

**Root cause (traced).** `pg-migrate` printed the whole answer:

```
343 migration(s), 360 applied, 1 pending, ...
  FAILED  0344_acc_autocount_code_migration.sql: relation "scm.acc_bank_configs" does not exist
```

`0344` relays each account code through every table that stores one, and one of
its ten `UPDATE`s named `scm.acc_bank_configs`. That table does not exist and
never has, in any tree or any environment — `0336_acc_bank_reconciliation.sql`
creates `scm.acc_bank_statement_config`. Confirmed by
`grep -rln acc_bank_configs backend/src/db/migrations-pg/`, which matches 0344
and nothing else. Every statement before it in the loop resolved, which is why
the error names that one table and not an earlier one.

**Why no gate caught it.** Nothing in CI executes a NEW migration's SQL. The
`backend-postgres` job runs `vitest --config vitest.pg.config.ts`, and that
config has no global setup; each `tests-pg/*.pg.test.ts` reads ONE named
migration file by filename suffix and replays that one inside a transaction. So
a migration is first executed by the production deploy. A whole-chain cold apply
is not a drop-in fix either: `scm.accounts` and `scm.journal_entry_lines` are
created by no file in `migrations-pg/`, so a from-empty replay of the tree fails
today for reasons that have nothing to do with any new migration.

**Fix.** `scm.acc_bank_configs` -> `scm.acc_bank_statement_config` in 0344, plus
a header note recording that the file was edited BEFORE it had ever been applied
anywhere. That matters: CLAUDE.md forbids editing an APPLIED migration's body,
and this one is not applied — a migration runs in one transaction, so the failure
rolled the tracker insert back with it and no row carries the old checksum.

**Ref.** fix/mig-0344-bank-config-table-name, 2026-09-02.
