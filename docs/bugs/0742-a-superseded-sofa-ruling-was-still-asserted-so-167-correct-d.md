## A superseded sofa ruling was still asserted, so 167 correct documents reported a failed run [high]

**Symptom.** `apply-sofa-compartment-corrections.mjs`, run
[34301924900](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34301924900),
`APPLY=1` over every corrections file. It wrote 168 builds — 458 lines updated,
10 added, 1 removed, 0 refused — and then exited 1:

```
FAIL HC-SO-012929: pieces are [9028-1A(LHF) | 9028-2A(RHF)],
                expected [9028-1A(LHF) | 9028-1S | 9028-2A(RHF)]
VERIFY FAILED on 1 document(s)
```

The whole run reads as failed. It was not: the data is right, and three log
lines below the FAIL the same document passes.

**Root cause (traced, not guessed).** Two files rule on that build, and
`CORRECTION_FILES` is ordered oldest first on purpose:

| file | its target |
|---|---|
| `sofa-compartment-corrections-2026-08.json` | `1S + 1A(LHF) + 2A(RHF)` |
| `sofa-compartment-corrections-2026-09.json` | `1A(LHF) + 2A(RHF)` |

The 2026-09 entry carries the owner's own words: *「owner 2026-09-04 and again
2026-09-05: the 26" build is 1A(LHF)+2A(RHF)」*, and it is the newer of the two.
The applier ran both in file order — the 08 entry INSERTED the `1S`, the 09
entry DELETED it again (that is the run's `removed 1`) — and the end state is
the owner's answer.

`verifyOnFreshConnection` then asserted **one expectation per ENTRY**, so the
overruled 08 target was still checked against the document the 09 entry had just
rewritten. Both outcomes are in the log, in order:

```
FAIL HC-SO-012929: ... expected [9028-1A(LHF) | 9028-1S | 9028-2A(RHF)]
OK   HC-SO-012929  1A(LHF)+2A(RHF)  money 668000/668000
```

`scripts/lib/sofa-rulings.mjs` already states "the newest ruling wins" for the
LOOKUP path — `findLast`,
`docs/bugs/0722-the-sofa-ruling-lookup-prefers-the-oldest-ruling-so-a-build.md`.
The applier's own verification never learned it. One rule, two homes, and only
one of them knew it.

**Why a key built from the selector would have changed nothing.** The two
entries carry DIFFERENT `desc2Match` strings — `"Size:26”/Col:Modenza 02
Barley/Bottom wr"` and `"Size:26”/Col:Modenza 02 Barley"` — so grouping by
document + model + selector text calls them two builds and asserts both, exactly
as before. What makes them one build is that they **select the same rows**,
which is a fact of the document rather than of the file.

**Fix.** `supersededBy(docKeys, idSets)` in `scripts/lib/sofa-build-plan.mjs`:
within one document, an entry is overruled by any LATER entry that selects any
of the same row ids. The verify reads each document's rows ONCE, resolves every
entry's row set against that read, and asserts only the survivors — printing
`SUPERSEDED <doc> [<file>] — the same rows are ruled again by [<file>]` for the
rest, because an expectation that stops being asserted must stay visible or a
build could quietly go unverified. An entry selecting NO rows is never
superseded: a build whose rows vanished is a finding that must still fail.

Six cases pinned in `scripts/lib/sofa-build-plan.test.mjs`, including the two
real builds on `HC-PO-009024` that share no row and must BOTH still be asserted.

**STILL OPEN, and it is the more dangerous half — not fixed here.** The APPLY
itself still runs both entries. Today the end state is correct only because
`CORRECTION_FILES` happens to list 2026-08 before 2026-09; if that order were
ever changed or a round were inserted out of sequence, the OLD ruling would be
written last and the DATA would be wrong, with a verify that now agrees with it.
It also writes and deletes a live row for nothing. The same `supersededBy` rule
belongs at PLAN time, which needs the plan loop to resolve each entry's rows
before choosing what to write — a larger change to a script that moves money on
live documents, so it is named here rather than attempted in the same PR.

**Ref.** PR for `fix/sofa-superseded-entry-still-applied`, 2026-09-09.
