## Migration 0344 blocked the production deploy twice, and #2881 was reverted [high]

**Symptom.** The Deploy run for #2881 concluded `failure` with the `backend` job
`failure` (run 33640908643, 2026-09-02 14:19Z). Nothing shipped. A failed
migration blocks every later one, so the deploy stayed broken for everybody
until the feature was reverted — the second attempt (run 33642779924) failed
too, on a different constraint.

**Root cause (traced). Two faults in the same file, one behind the other.**

1. `pg-migrate` on the first deploy:

   ```
     FAILED  0344_acc_autocount_code_migration.sql: relation "scm.acc_bank_configs" does not exist
   ```

   `0344` relays each account code through every table that stores one, and one
   of its ten `UPDATE`s named `scm.acc_bank_configs`. That table has never
   existed in any tree or any environment — `0336_acc_bank_reconciliation.sql`
   creates `scm.acc_bank_statement_config`.
   `grep -rln acc_bank_configs backend/src/db/migrations-pg/` matched 0344 and
   nothing else.

2. With the name corrected (#2887), the next deploy reached further and failed
   on the real design fault:

   ```
     FAILED  0344_acc_autocount_code_migration.sql: update or delete on table "accounts"
             violates foreign key constraint "payment_vouchers_company_credit_account_fk"
             on table "payment_vouchers"
   ```

   The relay updates the PARENT row first — `scm.accounts.account_code` — and
   the child rows after it, inside one transaction. Three composite foreign keys
   point at `scm.accounts (company_id, account_code)`, all added by
   `0188_percompany_natural_key_masters.sql` and none of them deferrable:
   `journal_entry_lines_company_account_fk`,
   `payment_vouchers_company_credit_account_fk`,
   `payment_voucher_lines_company_debit_account_fk`. A non-deferrable FK is
   checked per statement, so the parent `UPDATE` is refused before any child
   `UPDATE` can follow it. Reordering does not help: a child pointed at a code
   the parent does not carry yet is refused for the same reason.

**Why no gate caught either.** Nothing in CI executes a NEW migration's SQL.
`backend-postgres` runs `vitest --config vitest.pg.config.ts`; that config
declares no global setup, and each `tests-pg/*.pg.test.ts` reads ONE named
migration by filename suffix and replays that one file. A migration's first
execution is the production deploy. A whole-chain cold apply is not a drop-in
fix either: `scm.accounts` and `scm.journal_entry_lines` are created by no file
in `migrations-pg/` — they were ported by hand — so a from-empty replay of the
tree fails today for reasons unrelated to any new migration.

**Fix.** #2881 and #2887 REVERTED, which removes 0344 from the tree and lets the
deploy go green. The work is not lost: both commits stay in history and the
branch `feat/acc-autocount-codes` is untouched.

**What the redo needs, so the next attempt is not a third guess.** Renaming a
natural key that FK children point at needs one of these, decided by the author
and PROVED against a real Postgres before it merges:

- make the three FKs `DEFERRABLE`, `SET CONSTRAINTS ALL DEFERRED` for the
  transaction, relay, then restore them; or
- `INSERT` the new account rows, repoint the children, then `DELETE` the old
  rows — the standard natural-key rename, and the only one that needs no
  constraint surgery; or
- redeclare the FKs `ON UPDATE CASCADE`, which is what an ERP that expects
  account codes to move would carry in the first place.

Whichever is chosen, the evidence bar is a real Postgres: a `tests-pg/` case
that builds the parent/child fixture, replays 0344, and asserts the codes moved
in `accounts` AND in the three children.

**Ref.** revert/acc-autocount-codes, 2026-09-02. Reverts #2881 and #2887.
