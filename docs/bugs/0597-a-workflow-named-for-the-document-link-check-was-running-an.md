## A workflow named for the document-link check was running an unrelated MRP diagnostic and reporting success [high]

<!-- area: Deploy, CI, migrations -->

**Symptom.** The owner asked whether the relationships between SO / DO / GR / PO /
SI / PI had actually been checked. The workflow that answers that —
**AC vs ERP document-link graph (read-only)** — was dispatched and returned
`success`. Its output was a bedframe shortage diagnostic. It had run
`scripts/diag-mrp-false-shortage.mjs`, not `scripts/check-ac-erp-doc-links.mjs`.

Anyone pressing it and seeing green would conclude the document links had been
verified. **They had never been checked at all.**

**Root cause (traced).** Both steps in `.github/workflows/check-ac-erp-doc-links.yml`
on `main` pointed at the wrong script:

```
name: AC vs ERP document-link graph (read-only)
  - run: node scripts/diag-mrp-false-shortage.mjs
  - run: node scripts/diag-mrp-false-shortage.mjs
```

Almost certainly a PIGGYBACK left in place. A new `workflow_dispatch` file is not
dispatchable until it is on the default branch, so the working practice here is
to point an existing dispatchable workflow at a new script to run it once. This
one was borrowed and never given back — and committed to `main`.

**Fix.** Point both steps back at `check-ac-erp-doc-links.mjs`.

**The correct answer showed up the moment it was re-wired** — the script REFUSED
to run, and was right to:

```
snapshots exported_at=2026-08-30 02:32:01 (2.5 days old)
REFUSED: snapshots are 2.5 days old (>2). Re-run Phase 0 of docs/ac-resync-runbook.md
  first — a verdict against a stale book would read as coverage we do not have.
```

A checker that refuses beats one that answers from a stale book. That refusal is
the shipped behaviour; it is not a failure of this fix.

**The practice that caused it, stated as a rule.** A piggyback belongs on a
THROWAWAY branch, dispatched with `--ref <branch>`, and deleted — never committed
to `main`. Three piggybacks were used while investigating this same day and each
one was a `tmp/…` branch deleted immediately after.

**What it covers, for the next reader:** `SO docs`, `PO docs`, `SO→PO lines`,
`SO→DO docs`, `PO→GR docs`, `GR→PI docs`, `SO→IV docs`. The owner pointed out on
2026-09-01 that six document types make **36** ordered pairs, not seven edges;
widening it is separate work and this PR does not attempt it.

**UNTESTED end to end.** Re-wired, dispatched, and it refused on snapshot age —
so it has still never produced a verdict. That needs a fresh export from the
AutoCount host (`docs/ac-resync-runbook.md` Phase 0).

**Ref.** fix/doc-links-workflow-miswired, 2026-09-02.
