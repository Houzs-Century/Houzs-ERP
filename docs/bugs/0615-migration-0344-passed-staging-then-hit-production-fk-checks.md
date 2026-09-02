## Migration 0344 passed staging then died on production's FK checks — an empty table proves nothing about a full one [high]

**Symptom.** After #2887 fixed 0344's table name, staging applied it cleanly
(run 33642779806: `APPLIED 0344_acc_autocount_code_migration.sql`) — but every
production Deploy kept failing (33642555724, 33643498372):

```
FAILED  0344_acc_autocount_code_migration.sql: update or delete on table
"accounts" violates foreign key constraint
"payment_vouchers_company_credit_account_fk" on table "payment_vouchers"
```

Production deploys stayed red; nothing shipped behind them.

**Root cause (traced).** 0344's relay renames account codes with, per hop, an
`UPDATE scm.accounts` first and the referencing tables after. The FKs from
0188 (`... REFERENCES scm.accounts (company_id, account_code) ON DELETE
RESTRICT`) check PER STATEMENT: the moment the accounts row's code changes,
any voucher row still holding the old code is dangling, and the constraint
fires — one statement before the voucher `UPDATE` that would have mended it.

**Why staging passed and production did not: DATA, not schema.** Staging's
`payment_vouchers` holds no rows referencing the renamed codes; the owner's
two real draft vouchers (credit 330-0000 / 331-0000) live only in production.
The same file, the same schema, opposite outcomes. A green staging migration
proves the SQL parses and the empty-table path works — only the data-bearing
environment exercises the constraint path. (Second production-only lesson from
this same migration in one day; the first is 0614.)

**Why the file could not simply be fixed.** 0344_acc's checksum was already in
staging's tracker (`_pg_migrations` keys filename + checksum), so editing its
body would orphan the staging row and re-run risk on the next apply. And no
later-numbered migration can help: pg-migrate applies in filename order and
stops at the first failure, so anything after 0344_acc never runs on
production while 0344_acc keeps failing.

**Fix.** `0344_aaa_defer_account_fks.sql` — the one filename position that
runs BEFORE a pending 0344_acc is a name that sorts before it (pg-migrate
orders by full filename; the number is a label, migrationNumbers.test's own
words — 0344 is now recorded in KNOWN_DUPLICATES as the one deliberate
duplicate). It marks the five accounts-pointing FKs `DEFERRABLE INITIALLY
DEFERRED`, each behind a `pg_constraint` existence check. Every migration runs
in one transaction, so 0344_acc's constraint checks move to COMMIT — after the
relay has moved both the accounts rows and their references — and the rule
itself never weakens: a genuinely dangling reference still refuses, at commit.

**The rule to keep.** A relay that renames a PRIMARY-KEY-like value must
either (a) run with the referencing FKs deferred, or (b) walk
insert-new → repoint-references → delete-old per hop. Assume every
environment differs in DATA even when schema is identical; staging green is
necessary, never sufficient, for a migration that rewrites referenced values.
