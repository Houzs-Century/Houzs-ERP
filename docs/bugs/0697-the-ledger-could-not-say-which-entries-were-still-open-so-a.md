## The ledger could not say which entries were still open, so a fixed one was re-diagnosed and a TDD phrase was counted as backlog [high]

<!-- area: Repo tooling: tests, ratchets, generators -->
<!-- status: fixed -->

**Symptom.** The owner, 2026-09-08: 「彻底检查之前和这次做的东西 然后 fix 所有的
问题 要不然 fix 了很久了 还是一样的问题 我相信之前也是遇到这些问题地」— the same
problems keep coming back after being fixed for a long time. The ledger is the
memory that is supposed to stop exactly that. It could not answer the one
question that would: **which entries are still outstanding?**

A whole-ledger sweep run to answer it reported **217 of 905 entries** as unfixed,
and that number was used to scope a day of work.

**Root cause (traced, and it is the instrument, not the ledger).** An entry's
state lived only in its prose, so it had to be inferred by grepping — and the
grep was wrong in **both** directions.

*Direction 1 — phantom backlog.* The dominant marker in that sweep was the word
`unfixed`, in 138 files. Measured on `main` at `b50a41238`:

```enumeration
$ grep -rhoiE 'unfixed\s+\w+' docs/bugs/ | tr 'A-Z' 'a-z' | sort | uniq -c | sort -rn | head -4
    113 unfixed tree
      3 unfixed source
      3 unfixed behaviour
      2 unfixed code

$ tdd=0; other=0; for f in $(grep -rliE 'unfixed' docs/bugs/); do \
    tot=$(grep -oiE 'unfixed' "$f" | wc -l); \
    t=$(grep -oiE 'unfixed (source|code|tree|build|checkout)|on the unfixed' "$f" | wc -l); \
    if [ "$tot" -eq "$t" ]; then tdd=$((tdd+1)); else other=$((other+1)); fi; done; \
  echo "all-hits-are-the-TDD-phrase: $tdd   some-other-use: $other"
all-hits-are-the-TDD-phrase: 126   some-other-use: 12
```

**126 of the 138 files use the word ONLY in "fails on the unfixed tree"** — this
repo's own convention for proving a test RED before the fix. Every one of those
occurrences is a fix being *demonstrated*, and the sweep counted each as an open
defect. Of the remaining 12, most are the same phrase inflected (`unfixed
behaviour`, `unfixed shape`, `unfixed site`); roughly **four** use it as a state.

> Both commands above were run on `main` at `b50a41238`, **before** this PR's own
> edits. Re-run them on this branch and the second prints `126 / 14`, not
> `126 / 12`: this entry and `README.md` each add a prose use of the word. The
> baseline is quoted rather than the post-change figure because the 217 that
> triggered the work was measured against the baseline.

*Direction 2 — stale "open".* The opposite failure, same missing field. The PO
line-discount chain was checked run by run against the Actions history:

| entry | says | actually |
| --- | --- | --- |
| `0664` | "planned but not applied" (in the TITLE) | APPLIED, run `34116301278`, 2026-09-07 19:23 local — 89 lines, 10 headers |
| `0662` | "not yet fixed", owner decision | decision made (修 —— 跟 AutoCount 一模一样) and applied |
| `0665` | the CNY false discount | REVERTED, run `34120085455`, 2026-09-07 20:07 local, RM 13,068.55 restored |

All three still read as open money defects on 2026-09-08 and were queued for
re-diagnosis. **That is the owner's 「还是一样的问题」, mechanically.** Nothing
brings a writer back to the entry after the run that resolves it, so the entry
freezes at the moment it was written and every later reader re-derives a state
that has moved on.

**Neither direction is a lying author.** `0664`'s title was true for the four
hours between being written and the apply being dispatched. The defect is that an
entry has no way to say *when* it is describing.

**Fix.** Give the ledger the field it was missing, and a command that reads it.

- `<!-- status: fixed | open | owner-decision | superseded -->`, parsed in
  `backend/scripts/lib/bug-ledger.mjs` (`readStatus`, `STATUS_VALUES`) beside the
  `<!-- area: -->` tag it deliberately mirrors. An **absent** tag reads as `null`,
  never as a default and never as `fixed` — "I was not told" has to stay
  distinguishable from "I was told it is done", because collapsing those two is
  the whole failure. An undefined value is **reported**, not swallowed.
- `npm --prefix backend run gen:bug-status` — counts by state and lists every
  `open` and `owner-decision` entry with its path. `--open`, `--match <regex>`,
  and `--check` (fails on an undefined status).
- `docs/bugs/README.md` documents the field, the four values, and the measurement
  above, so the next person does not re-run the sweep that produced 217.

**What this does NOT do, said plainly.** The tag is an ASSERTION, not a proof —
`status: fixed` records that a person claims the remedy ran, and the evidence is
still the run id in the body. It cannot verify itself, and working-agreement
rule 3 is unchanged. It also does not backfill 905 entries: **905 of 905 carry no
tag** as of this PR except the five touched here, and `gen-bug-status` reports
that untagged population out loud rather than implying the ledger is clean. Tag
one when you touch it.

**Proved RED first.** `backend/tests/bugStatus.test.mjs`, 8 cases, run against
the tree before `readStatus` existed: **7 failed, 1 passed**; after the change,
**8 passed**. The cases pin the four values, case- and space-insensitivity, that
an absent tag is `null`, that an undefined value is surfaced rather than dropped,
that `readEntries` carries the status through — and, explicitly, that the string
"proved RED against the unfixed tree" yields **no** status, which is the exact
misreading that produced the 217.

**Ref.** `fix/cutover-ledger-backlog`, 2026-09-08.
