## The cannot-be-compared cause table described a different population from the column it was titled after [high]

**Symptom.** The tally report prints a block headed *"WHAT 'CANNOT BE COMPARED'
MEANS, BY CAUSE — and whose it is"*. On run 34257873206 (`main`, 2026-09-08) its
document counts were not the column's, on four of the six document types:

| type | cause table | CANNOT BE COMPARED |
| --- | --- | --- |
| GR | 4 + 2 = 6 | 3 |
| DO | 3 + 2 + 2 = 7 | 5 |
| PI | 2 + 3 = 5 | 2 |
| PO | 13 | 13 — and the MEMBERSHIP still wrong, see below |

The purchase-order row is the one that shows it is not an arithmetic slip. The
two totals match while the two SETS do not: `HC-PO-000254` is counted in the
cause table and is NOT in the column (it differs on `transfer to`, so precedence
puts it in WORK), and `HC-PO-009828` is in the column and in no cause row at
all. So the sentence *"=> 13 of these can be made comparable WITHOUT you (stamp
the line key)"* was a promise about a set that was not the 13 documents the
owner was being handed.

**Root cause (traced).** Two independent defects, both in
`backend/scripts/lib/so-tally-verdict.mjs`'s `tallyVerdict`, and both observed
by reading the verdict rows of that run's own output rather than inferred:

1. The cause cross-tab was accumulated from the `unanswerable-cause` note of
   EVERY row, with no reference to which bucket `bucketOf` had put that row in.
   A document with a real difference on another axis is WORK — the work is owed
   whatever its unreadable sofa turns out to be — yet its sofa cause still fed a
   table explaining a column it is not in.
2. `sofa build not verifiable` was the only unanswerable axis anything emitted a
   cause for. `transfer chain not verifiable` is the other member of
   `UNANSWERABLE_AXES` (`lib/so-verdict-derive.mjs`) and emitted none, so a
   document unanswerable ONLY for that reason — `HC-PO-009828` — sat in the
   column named by nothing.

Defect 2 is worse than a missing row, because that axis is itself two
populations owed opposite things. `lib/transfer-chain-verdict.mjs` already
separates them: `line_not_stamped` is a line key we never stamped and closes
with `backfill-ac-downstream-line-keys.mjs` and nobody's ruling, while
`erp_parent_unstamped` is an ERP-native parent the account book has nothing to
compare against — unanswerable by anyone, the owner included, and never a
backlog.

This is the repo's own named class — ONE COLUMN CARRYING SEVERAL POPULATIONS —
wearing the costume of the fix for it. `lib/sofa-unread-split.mjs` was written
to end exactly this, and the report then gave its cross-tab a heading one size
larger than the table could keep.

**Fix.** `backend/scripts/lib/unanswerable-causes.mjs` — new, pure — is the
registry of every cause the column can carry, its sentence, and WHOSE it is
(MECHANICAL / ABSENT SOURCE / YOURS). It IMPORTS `UNREAD_LABEL` from
`lib/sofa-unread-split.mjs` rather than copying it, and asserts at load that no
cause has a label without an owner or an owner without a label.

`tallyVerdict` now feeds the cross-tab from the `unanswerable` bucket only,
counts the excluded ones on their own line (`unreadOnWorkDocs`) so the two
numbers are visible instead of merged, and guarantees the invariant that makes
the heading honest: `uncausedUnanswerable`, the number of documents in the
column carrying no named cause, is computed and PRINTED whether it is zero or
not. The chain causes are emitted upstream in `lib/ac-transfer-chain-run.mjs`
beside the refusal, from the verdict it already holds — the same shape
`lib/variant-report.mjs` uses for a sofa, so the cause and the refusal cannot
disagree.

Proved RED on the unfixed tree: `tests/soTallyVerdict.test.mjs` gained four
cases and 4 of them failed against `main` (`v.unreadOnWorkDocs`,
`v.uncausedUnanswerable` and `v.mechanicalDocs` were all `undefined`, and the
cause table counted a WORK document). One of them then caught a SECOND defect in
the first attempt at the fix — a document unanswerable for BOTH a sofa and the
chain had only its sofa cause named, which is the same bug one level down — so
the fallback is per-REASON and not per-row. `tests/unanswerableCauses.test.mjs`
is new and was proved red by tagging `erp_parent_unstamped` as MECHANICAL
(1 failed, 8 passed) before being restored.

**Ref.** `fix/do-and-cannot-compare-2026-09-09`, 2026-09-09.
