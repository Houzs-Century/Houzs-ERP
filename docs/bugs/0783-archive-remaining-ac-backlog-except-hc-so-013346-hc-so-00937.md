## Archive remaining AC backlog (except HC-SO-013346, HC-SO-009373) [low]

**Symptom.** After the fixable documents were re-queued, the AutoCount Sync
Not Accepted tab still listed ~11 documents that cannot sync without composer
work (keyless DO/GR, rebuild-refused SO/PO, a desc2 DO) or that are already in
the account book (two so_to_do rows). Owner ruling 2026-09-10: 「全部clear掉」
except the two he is aligning in AC by hand.

**Root cause (traced).** Three classes, all confirmed on the live queue via
`autocount-outbox-health` and `probe-doc-writeback`:
- rebuild-refused — the host refuses a rebuild that would clear a
  downstream-transferred line; the composer's re-queue only offers rebuild.
- keyless — DO/GR lines carry no `linked_ac_dtlkey`; `relink-lines` supports
  only SO/PO (`autocount-relink.ts`).
- already-in-book — HC-DO-2609-004/-009 carry their own `linked_ac_docno`;
  the `failed` rows are history.

**Fix.** `backend/scripts/repair-archive-remaining-ac-backlog.mjs` sets
`archived_at = now()` on the named docs' outbox rows (never DELETE, per 0277's
audit-trail rule). Hard-coded doc list with an explicit FORBIDDEN guard that
refuses if HC-SO-013346 or HC-SO-009373 ever appear in it. DRY-RUN default,
`CONFIRM=ARCHIVE-REMAINING-AC-BACKLOG`, fresh-connection SHAPE check that every
named doc has zero live rows after. This is a STOPGAP that clears the page; the
durable fixes (extend `relink-lines` to DO/GR, teach re-queue to pick a keyed
edit over rebuild) are separate PRs.

Also in this PR: **fixes `repair-so-000814-sofa-order.mjs`** (shipped in the
prior PR), whose first apply refused with "no sofa 5526 lines found" — it
matched `item_code LIKE 'SOFA 5526%'` and split compartments on a space. Sofa
codes are `{model}-{compartment}` split on the FIRST hyphen (`splitSofaCode`,
`autocount-sofa-collapse.ts`), e.g. `5526-1NA`. The script now scans all lines
and matches the compartment after the first hyphen, printing every line in the
dry-run so the real codes are visible before an apply.

**Ref.** `fix/archive-remaining-ac-backlog`, 2026-09-10.
