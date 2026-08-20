## A generated file in git made every pair of concurrent PRs conflict, by construction [medium]

**Symptom.** Merge conflicts on nearly every PR, always in
`docs/generated/bug-index.md` and usually in nothing else. On 2026-08-18 one
small PR (#2405) hit it **four times in one afternoon**, and #2352, #2394 and
#2397 each hit it too. It reads as other people merging carelessly. It is not.

**Root cause (measured, not inferred).**

```
$ git log origin/main --oneline -50 --name-only -- docs/generated/ \
    | grep -c "bug-index"
50
```

(The command filters on the DIRECTORY, not the file, because
`docs/generated/bug-index.md` [gone] no longer resolves in the tree — which is
exactly what this entry records. The marker has to sit on the SAME line as the
path: check-docs-drift reads them as a pair, so a line-wrap between them reads as
an unmarked missing file.)

**All 50 of the last 50 commits touch that file.** It is GENERATED from
`BUG-HISTORY.md`, the working agreement requires every code PR to append an
entry to `BUG-HISTORY.md`, and the generated output was committed. So both sides
of every concurrent pair rewrote the same file, and git conflicted — every time,
by construction. Four careful authors would produce this as reliably as four
careless ones.

**Nothing read the committed copy.** The only references to it anywhere in the
tree were its own generator and its own CI gate:

```
.github/workflows/ci.yml:100   npm run audit:bug-index
backend/package.json:48-49     gen:bug-index / audit:bug-index
backend/scripts/gen-bug-index.mjs
```

No document links to it. No script consumes it. It existed to be checked against
itself, at the price of a guaranteed conflict per PR.

**The repo had already half-conceded this.** `--check` warned on content drift
rather than failing, because — in the job's own words — *"with serial merges,
gating it deadlocks every open PR on the previous author's entry"* (five PRs
tripped it simultaneously on 2026-08-14). Softening it removed the deadlock and
kept the conflicts.

**Fix.** The index is gitignored and removed from tracking. `--check` no longer
compares against a committed copy, because there is not one; content drift stops
existing as a concept. `gen:bug-index` still writes the file for anyone who wants
to read it locally.

**What is KEPT — the failure this gate was actually built for.** The generator
dying, the shape `docs/staging-bench-rot-coe.md` records going unnoticed for
three weeks. Proven still armed rather than assumed: with the ledger replaced by
a stub carrying no entries, `audit:bug-index` prints
`parsed ZERO entries from BUG-HISTORY.md — that is a broken generator, not an
empty history` and **exits 2**. A parse failure or missing `BUG-HISTORY.md`
throws earlier, and `chargeBadAreaTags()` still exits 1 on an unresolvable area
tag introduced by the change under test. None of those ever needed a copy in git.

**What is GIVEN UP, stated rather than hidden.** The index is no longer browsable
on GitHub. That is a real loss and a small one: drift was tolerated by design, so
the committed copy was routinely wrong anyway — a stale file nobody links to is
worth less than no file.

**Ref.** 2026-08-18.
