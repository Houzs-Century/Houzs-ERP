## The chart relay renames a natural key three foreign keys point at, so the parent UPDATE is refused [high]

**Symptom.** The second production deploy of the AutoCount chart relay failed
too (run 33642779924, 2026-09-02 14:41Z) — run `failure`, `backend` job
`failure`. Two deploys in a row shipped nothing, and because a failed migration
blocks every later one, nobody could deploy anything until the feature was
reverted. Production account codes were never changed.

**Root cause (traced).** `pg-migrate`:

```
  FAILED  0344_acc_autocount_code_migration.sql: update or delete on table "accounts"
          violates foreign key constraint "payment_vouchers_company_credit_account_fk"
          on table "payment_vouchers"
```

The relay renames a NATURAL KEY. `0188_percompany_natural_key_masters.sql` adds
three composite foreign keys onto `scm.accounts (company_id, account_code)`, and
none of them is declared `DEFERRABLE`:

- `journal_entry_lines_company_account_fk`
- `payment_vouchers_company_credit_account_fk`
- `payment_voucher_lines_company_debit_account_fk`

A non-deferrable FK is checked per statement, not at COMMIT. The relay updates
the parent row first — `scm.accounts.account_code` — so the parent `UPDATE` is
refused before any child `UPDATE` can follow it. Reordering does not rescue it:
a child pointed at a code the parent does not carry yet is refused the same way.
This is a design fault in the relay, not a typo, which is why the first
correction (the wrong table name, entry 0614) only moved the failure one
statement further down.

**Why no gate caught it.** Nothing in CI executes a NEW migration's SQL.
`backend-postgres` runs `vitest --config vitest.pg.config.ts`; that config
declares no global setup, and each `tests-pg/*.pg.test.ts` reads ONE named
migration by filename suffix and replays that one file. A migration's first
execution is the production deploy. A whole-chain cold apply is not a drop-in
fix either: `scm.accounts` and `scm.journal_entry_lines` are created by no file
in `migrations-pg/` — they were ported by hand — so a from-empty replay of the
tree fails today for reasons unrelated to any new migration.

**Fix.** #2881 and #2887 REVERTED, which takes the pending migration out of the
tree and lets the deploy go green. That is a rollback, NOT the fix — the
accountant's chart still has to move, and the work is intact on the branch
`feat/acc-autocount-codes` plus both reverted commits.

**What the redo needs**, chosen by the author and PROVED against a real Postgres
before it merges:

1. make the three FKs `DEFERRABLE`, `SET CONSTRAINTS ALL DEFERRED` for the
   transaction, relay, then restore them; or
2. `INSERT` the new account rows, repoint the children, then `DELETE` the old
   rows — the standard natural-key rename, and the only option needing no
   constraint surgery; or
3. redeclare the FKs `ON UPDATE CASCADE`, which is what an ERP that expects
   account codes to move would carry in the first place.

The evidence bar is a `tests-pg/` case that builds the parent/child fixture,
replays the relay, and asserts the codes moved in `accounts` AND in all three
children. Without it the next attempt is a third guess dispatched at production.

**Ref.** revert/acc-autocount-codes, 2026-09-02. Reverts #2881 and #2887.
