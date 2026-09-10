## The stale-spec census died on first dispatch reading so_doc_no on the line table [low]

**Symptom.** `backend/scripts/check-stale-line-desc2.mjs`, dispatched against
production for the first time (run 34483368519), printed its first four answers
and then died:

```
Approved amendments in the audit log: 30
Line spec changes carried by those approvals: 20, across 11 order(s)
check-stale-line-desc2 failed: column "so_doc_no" does not exist
```

**Root cause (traced).** The two tables spell the same reference differently.
`scm.mfg_so_audit_log` links to its order with `so_doc_no`; the line table
`scm.mfg_sales_order_items` uses `doc_no`. The script read the audit log first
and carried that spelling into the line query, which is the kind of mistake that
reads as correct in every review — the column name is right, on the wrong table.

Every gate passed: syntax, release discipline, docs drift, vocabulary, the bug
index, the file-size ratchet, and all nineteen CI checks. **None of them opens
the database.** That is the same shape as the SO-holders probe, which died on
its first dispatch coercing an enum through `COALESCE(col, '')`, and it is why
CLAUDE.md says a `workflow_dispatch` workflow is not shipped until it has been
dispatched once and reported success. The rule worked exactly as intended here:
the first dispatch was the test, it failed, and nothing was claimed from it.

**Fix.** `WHERE doc_no = ${docNo}` on the line query, with a comment at the site
naming both spellings and pointing at this entry — so the next reader sees a
recorded trap rather than an arbitrary-looking inconsistency. Verified by
re-dispatch; the run is pasted in the PR body.

**Ref.** fix/census-doc-no, 2026-09-10. Follows `docs/bugs/0789-*`.
