## One bad area tag on `main` turned `audit:bug-index` into a repo-wide CI blackout [high]

<!-- area: Repo tooling: tests, ratchets, generators -->

**Symptom.** 2026-08-17, 04:00–05:00Z: five of five PR-branch CI runs red, on
four unrelated branches, with the identical message —
`BUG-INDEX: "Cancelled and unconfirmed events…" carries <!-- area: PMS My
Pending lanes -->, which is not an area.` Three of the four branches
(`fix/pair-stockin-tile`, `fix/floorplan-card`,
`refactor/planning-state-narrow-readiness-0815`) had no connection to the entry
at all. The only green run in the window was the repair branch itself.

**Root cause (traced, not guessed).** `gen-bug-index.mjs` validated the
`<!-- area: -->` tag with an unconditional `process.exit(1)` the moment it saw
one that named no area. Three facts turn that into a blackout:

1. `audit:bug-index` runs inside `backend-typecheck`, which IS a required status
   check, so the failure blocks the merge;
2. the tag lives in `BUG-HISTORY.md` — the ONE file the working agreement makes
   every code PR append to — so once a bad tag merges it is in everybody's tree;
3. the exit happened before the generator wrote anything, so nobody could
   regenerate their way out either.

Commit `6c9f8cbd` landed the bad tag at 04:00:21Z. Repair PR #2351 (merged
04:59:53Z) touches only `BUG-HISTORY.md`. Fifty-nine minutes of blocked merges
for a typo three of the four blocked authors never wrote.

The assumption is recorded, in writing, in the test that guarded this file:
*"a malformed tag is in the diff of whoever wrote it"*
(`derivedDocsDoNotDeadlock.test.mjs`). It is false for exactly the reason the
same file already gives for content DRIFT, four lines above it — the ledger is
shared, and merges are serial. The drift half had learned the lesson; the tag
half predated it.

**Fix.** A bad tag is now REPORTED in full on every run and CHARGED only to the
change that introduced it — matched by ENTRY (title + tag) against
`BUG-HISTORY.md` at the merge base, not by counting tag strings, so the entry
NAMED is the one actually added. Inherited tags fall back to the keyword guess,
so the index still builds and the author can still regenerate. An unresolvable
merge base charges everything, because a gate that cannot tell whose fault it is
must not let anything through. Same rule, same wording, as
`check-file-size.mjs`'s inherited-ceiling handling.

**Proof.** Four behavioural tests in `derivedDocsDoNotDeadlock.test.mjs`, each
building a throwaway git repo: inherited tag exits 0 and still writes the index;
an introduced tag exits 1; with the tag broken on the base AND a second added
here, exit 1 names only the new one; no merge base charges everything.

**Ref.** PR (this one), 2026-08-17.
