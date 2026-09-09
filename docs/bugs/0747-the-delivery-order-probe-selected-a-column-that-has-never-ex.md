## The delivery-order probe selected a column that has never existed, so a whole document type could not be read [medium]

**Symptom.** `probe-book-line-gaps.mjs` — the read that prints the ERP's side of
a named document beside the account book's — cannot answer for `DO` at all.
Measured on production,
[run 34315008484](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34315008484),
`TYPE=DO DOCS=HC-DO-000542`:

```
════════ HC-DO-000542   (account book DO-000542) ════════
PostgresError: column "so_number" does not exist
  code: '42703'
  hint: 'Perhaps you meant to reference the column "delivery_orders.do_number"'
  at Object.header (backend/scripts/probe-book-line-gaps.mjs:81:23)
```

**It is not a typo that degrades gracefully.** The header SELECT is the first
statement the reader runs for a document, so the error aborts before a single
line is printed. What the operator sees is a document type that produces
nothing — indistinguishable from a delivery order the ERP does not hold, which
is the worst way for a probe to be wrong: the tool built to stop people
guessing about our own side was itself guessing, and silently.

**Root cause.** The column is `so_doc_no`, and there has never been a
`so_number` on `scm.delivery_orders`. `0111_scm_hot_indexes.sql:24` indexes
`scm.delivery_orders (so_doc_no)`, `0239_search_trgm_scm_documents.sql:51`
documents it by that name, and `0084_multicompany_views.sql:136` selects it.
Every other reader in the repository uses `so_doc_no`; only this one invented a
name. The five sibling readers in the same file — SO, PO, GR, IV, PI — all
answer, which is why the defect survived: a run that names one type looks
completely healthy.

**Fix.** `so_doc_no`. One column name, no behaviour change anywhere else.

**Proved RED first, and on the real database rather than in the abstract.** The
run above is the RED: the DO section printed the header banner and then threw
42703, and not one ERP line. **The GREEN is UNTESTED at the time of writing** —
the fixed probe cannot be dispatched until it is on the default branch, so the
run id goes in the pull request that merges it and in this entry immediately
after, rather than being predicted here.

**What it cost.** The chain repair that found it needed the delivery order's own
rows before it could plan anything, and got a stack trace. Nothing was written
against the wrong facts, because the failure was loud; the cost was one
production dispatch and the reason this entry exists is that the NEXT reader of
a `DO` refusal should not have to rediscover that the tool, and not the
document, was the problem.

**Ref.** `fix/sofa-4doc-elt-2026-09-09`, 2026-09-09.
