## Trial Balance said the books balance, and COGS said RM 0.00, off reads that failed [high]

**Symptom.** An accountant opens Accounting > Trial Balance while
`GET /accounting/balances` is failing. The difference tile renders in its GREEN
frame reading **"RM 0.00 — books balance"**, with Σ Debit and Σ Credit both
RM 0.00. Nothing says the report never loaded. They sign off on a general ledger
that was never read.

Same shape on Inventory > COGS: the card reads **"Total COGS RM 0.00"**, the
eyebrow reads "0 consumption entries", and the table reads "No COGS entries yet".
Someone checking whether a SKU has ever been consumed is told it has not.

**Root cause (traced).** Both fold a total over a list that is empty *because
the read failed*:

- `frontend/src/pages/scm-v2/Accounting.tsx`, `TrialBalanceTab` —
  `q.data?.balances ?? []`, then `dr - cr`. With `[]` that is `0`, and `0` is
  the value the tile treats as the good news. The whole file consulted only
  `q.isLoading`; `isError` appeared nowhere in it.
- `frontend/src/pages/scm-v2/Inventory.tsx`, `CogsTab` — `data ?? []`, then
  `reduce`. It already passed `pending={isLoading}` to `StatCard`, and the
  comment above that line names this exact hazard — but `isLoading` is **false**
  after a failed fetch, which is the other way the list is empty for a reason
  that has nothing to do with cost of goods.

`StatCard`'s own doc comment states the rule both broke: *"A figure the app
cannot vouch for must never be rendered as a figure — least of all a money one."*

**Why no gate saw it.** `check-silent-mutations.mjs` only looks at write
mutations. `swallowed-read-scan.mjs` matches a `.catch` that returns nothing —
neither of these has a `.catch` at all; the failure is a normal TanStack error
state that the component simply never asks about.

**Fix.** Both now distinguish "nothing" from "not known".

- Trial Balance: an error banner naming the failure, the two Σ tiles render `—`,
  and the difference tile reads `— — not checked` in a neutral frame instead of
  the green "books balance". The table's empty label becomes "The account
  balances could not be loaded."
- COGS: `pending={isLoading || isError}` so the card renders the unknown marker,
  an inline line saying the entries could not be loaded ("this is not the same
  as there being none"), the eyebrow reads "Not loaded", and the table's empty
  label says the read failed.

`TrialBalanceTab` and `CogsTab` were exported so the test can render them
directly; nothing else about them changed.

Pinned by `frontend/src/pages/scm-v2/moneyFigureHonesty.test.tsx`, four tests
(two defects, two success controls that must keep printing the real figure).
**Proved RED on the unfixed tree first** — both defect tests failed with
`AssertionError: expected <div …(1)></div> to be null` (the "books balance" text
and the `RM 0.00` text were both on screen), then all four passed.

**Ref.** fix/money-figures-from-failed-reads, 2026-08-21.
