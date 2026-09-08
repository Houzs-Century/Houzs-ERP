## A test fixture looser than production let a delete script ship SQL Postgres rejects [high]

**Symptom.** `docs/bugs/0715-*` shipped a reference sweep and a control for
`backend/scripts/delete-test-so.mjs`, with 17 tests executing the real SQL
against CI's `postgres:16` service. Every gate was green. Its first dispatch on
merged `main` — run `34223295235`, `MODE=plan` against production — died:

```
DELETE_FAIL: invalid input value for enum scm.mfg_so_status: ""
```

**Nothing was written.** It is the plan path and it failed before any write.

**Root cause (traced).** The control fingerprints every OTHER sales order so a
delete can be proved not to have touched one:

```sql
md5(string_agg(doc_no || '|' || coalesce(status, ''), ',' ORDER BY doc_no))
```

`scm.mfg_sales_orders.status` is not text. It is `scm.mfg_so_status`, an enum of
nine values (`backend/scripts/scm-schema/2990s-full-schema.sql` line 16), so
`coalesce(status, '')` asks Postgres to read `''` as a member of it.

**Why a real-Postgres suite did not catch SQL that Postgres rejects.** The
fixture declared the column as `text`:

```sql
CREATE TABLE scm.mfg_sales_orders (
  doc_no text PRIMARY KEY, status text, company_id int, total_sen bigint, ...
```

`text` accepts `coalesce(x, '')` happily. So the suite ran the statement, and the
statement passed, and it proved nothing about the database it was written for.
**A fixture LOOSER than production is not a weaker test — it is a test of a
different schema**, and it converts a green run into evidence for a claim nobody
checked. That is the same shape as this repo's "checker that cannot match
reports a clean run", one layer down: here the checker matched fine, against the
wrong thing.

**A second defect, found by reading rather than by a crash.** The same control
picked its money column with

```js
resolveCol(db, "scm.mfg_sales_orders",
  ["total_sen", "grand_total_sen", "net_total_sen", "total_amount_sen"])
```

and **`scm.mfg_sales_orders` carries none of those.** Its document total is
`local_total_sen` (measured off the captured header, run `34220446297`). So
`moneyCol` resolved to `null`, `money_sum` came back `NULL` before AND after, the
two compared equal, and the money arm of the control would have reported
agreement having measured nothing. Textbook *"ask what the successful result
would ALSO be true of"*.

**Fix.**

| defect | fix |
|---|---|
| enum concatenated as text | `coalesce(status::text, '')` in `backend/scripts/lib/delete-test-so-refs.mjs` |
| fixture looser than production | `tests-pg/deleteTestSoRefs.pg.test.ts` creates the real `scm.mfg_so_status` enum, and a NULL-status case — the only way to reach the coalesce — fails without the cast |
| money column resolved to nothing | the candidate list leads with `local_total_sen`, and the script prints a NOTE when nothing resolves instead of going quiet |

`paid_sen`, `deposit_sen` and `balance_sen` are deliberately absent from that
list. Nothing here reads or writes a payment column.

**Proved RED.** With the fixture's enum in place, the pre-fix
`coalesce(status, '')` raises the production error inside CI instead of inside
production.

**Two lessons, and the second is the one worth keeping.**

1. A pg fixture's column TYPES are part of the assertion. Copy them from the
   schema, not from what makes the test pass.
2. **`tsc` never saw this file.** `backend/tsconfig.json` does not include
   `tests-pg/`, so a local `npm run typecheck` is silent about everything in it —
   which is also how a stray backtick inside a SQL template literal in the same
   file reached CI as a `vite:oxc` PARSE_ERROR on the next push. The only local
   check that covers `tests-pg/` is running the suite.

**Ref.** `chore/remove-test-so`, 2026-09-08. Follows
`docs/bugs/0715-deleting-a-sales-order-trusted-a-hand-written-child-list-nob.md`,
and is the rule from `docs/bugs/0711-*` collecting again: a `workflow_dispatch`
workflow is not shipped until it has been dispatched once and reported success.
