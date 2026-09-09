## The goods-receipt money apply died on a column `scm.grn_items` does not have, and its own plan could not have caught it [medium]

**Symptom.** `repair-gr-money-from-book.mjs` planned cleanly against production
and then failed on the very first write. Run
[34305708536](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34305708536),
`MODE=apply`:

```
agree already 291 · would change 77 · refused for real stock movement 0 · refused for a missing line key 29
money: RM 25369.43 -> RM 84865.93  (RM 59496.50)
...
at .../backend/scripts/repair-gr-money-from-book.mjs:219:15 {
  code: '42703',
  position: '127',
  routine: 'transformUpdateTargetList'
}
```

**Root cause.** The `UPDATE` set `updated_at = NOW()` and `scm.grn_items` carries
no such column. `42703` is `undefined_column`, and `position 127` lands on that
assignment. The header table `scm.grns` DOES have one — `reshape-migrated-grns
.mjs:904` writes it — and the column was copied across from the header statement
to the line statement without checking. Every other repair of this table sets no
such column: `repair-migrated-grn-item-codes.mjs:285` and
`repair-grn-variant-snapshot.mjs:140`.

**Nothing was written.** The statement is the first inside `sql.begin`, so the
throw rolled its transaction back, and the throw then left the loop before any
later receipt was reached. The run reports `failure` with zero rows changed.

**Why the plan could not have caught it, which is the part worth keeping.** The
plan and the apply are not the same code path by design — a plan that wrote
would not be a plan. So a plan proves the DECISION (which receipts, which
figures, which refusals) and proves nothing at all about the STATEMENT. Every
gate this repo runs was equally blind: the module's thirteen tests exercise
`planReceiptMoney`, which is pure and touches no SQL; `check-release-discipline`
checks that a plan default, a CONFIRM phrase, a fresh-connection verify and a
`RE-RUN:` line exist, not that the SQL parses; and there is no schema fixture for
`scm.grn_items` to typecheck a raw template literal against.

**What would have caught it, cheaply:** writing the statement the way a sibling
repair of the same table already writes it. Two existed and neither was read
before this one was written. **When adding a write to a table this repo already
repairs, open the existing repair of that table first and copy its column list.**

**Fix.** `updated_at` removed from the line statement (the header statement keeps
its own, correctly), and `id` cast `::uuid` to match the siblings. The comment at
the site names the run and the two precedents so the column cannot come back.

**Ref.** fix/ac-align-so-po-gr, 2026-09-09. The repair itself is
`docs/bugs/0737`; the defect its plan DID catch is `docs/bugs/0738`.
