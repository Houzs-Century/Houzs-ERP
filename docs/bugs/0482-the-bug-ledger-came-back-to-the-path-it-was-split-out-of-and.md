## The bug ledger came back to the path it was split out of, and no gate was looking at that path [high]

<!-- area: Repo tooling: tests, ratchets, generators -->

**Symptom.** On 2026-08-21 `BUG-HISTORY.md` on `main` was **24,129 lines** again.
#2567 had split it into 477 files under `docs/bugs/` the day before and left a
39-line signpost there. The signpost was still in the file — at the BOTTOM, under
23,000 resurrected lines. Nothing was red: not CI, not the merge queue, not
review. #2568's own entry ("AutoCount's own refusals reached the owner as raw
machine text") existed ONLY in the resurrected file — `git grep -l` over
`docs/bugs/` on `origin/main` returned nothing for it.

**Root cause (reproduced, not guessed).** A branch that forked before #2567
carries `BUG-HISTORY.md merge=union` in **its own** `.gitattributes`, and a merge
applies the attributes of the tree the merge is running IN. The working agreement
made every code PR prepend to that file, so such a branch has its own edit to the
same first line that `main` replaced. `git merge origin/main` therefore hits one
conflicting hunk, the union driver resolves it by KEEPING BOTH SIDES, prints
`Auto-merging BUG-HISTORY.md`, and **exits 0**. The result is the branch's entry,
then every line #2567 deleted, then the signpost.

Reproduced end to end on a throwaway fork of `6c81565dd`: 24,737 lines in,
24,777 lines out, `exit 0`.

Two things that were true and did not help. #2567 removed the attribute from
`main` — measured `git check-attr merge -- BUG-HISTORY.md` → `unspecified` — and
that cannot reach a branch that forked the day before. Adding `BUG-HISTORY.md
-merge` on `main` was tried against the same fork and made **no difference**:
`exit 0`, 24,777 lines. Nothing on `main` can change how another tree merges.

**The real defect is the missing gate, not the merge driver.** #2567 changed the
layout and left the OLD path guarded by nothing, so the one thing that could undo
it in a single command was the one thing nobody was watching. `audit:bug-history`
gates `docs/bugs/`; no check read `BUG-HISTORY.md` at all.

**Fix.** `backend/scripts/check-bug-ledger-signpost.mjs`, run as
`audit:bug-signpost` inside `backend-typecheck` — a REQUIRED status check, which
is the only place a check blocks anything. Three exact rules, no thresholds: no
line opening `## ` (what every reader here treats as an entry); no line that IS
one of the ledger's own titles at any heading level (catches a resurrection whose
heading got mangled); and the file must still name `docs/bugs` (so it cannot be
emptied to pass). It self-tests the matcher against synthetic samples before
reading the tree and **exits 2 rather than reporting a pass** if the matcher is
dead — proved by sabotaging the `## ` rule and watching it exit 2.

Charged UNCONDITIONALLY, deliberately unlike every sibling gate over this
directory: their merge-base excuse would exempt exactly the branch that needs
catching, because a pre-#2567 fork's merge base holds the full 24,733-line
ledger. The repair is two commands in the author's own tree and both are printed
on failure.

Proved RED before GREEN, five ways: the real resurrected blob (exit 1, 466 entry
headings named); a heading mangled to `#`; a gutted signpost; a deleted signpost;
and a sabotaged matcher (exit 2). Then GREEN on the restored tree, and GREEN
end-to-end after the reproduced union merge was fixed.

**Nothing was lost.** Every one of the 466 `## ` blocks in the resurrected blob
was matched to an entry file, and the combined view rebuilt from those files is
identical to the blob on two independent SHA-256s — `d63e1fe4…` after the single
blank-line normalisation #2567 defined, and `f83a01cf…` over every
non-whitespace byte with no normalisation at all, 1,486,344 bytes. One orphan:
#2568's entry, which is now `docs/bugs/0481-autocount-s-own-refusals-…`.

**A second thing the unguarded path hid, found while moving the orphan back.**
#2568's entry carried `<!-- area: SCM -->`, and `SCM` is not one of the areas
`gen-bug-index.mjs` accepts. It never had to be: `audit:bug-index` reads
`docs/bugs/` and nothing read `BUG-HISTORY.md`, so an entry written at the old
path skipped the area check as well as everything else. Moving it back is what
made the required check refuse it. The tag is now `AutoCount sync + write-back`,
which is what its three sibling entries use and what its own **Ref** points at
(`docs/modules/autocount-writeback.md` §7g). **The valid-area list was NOT
widened to accept `SCM`** — that would have been loosening a guard to make a
check pass. This one line is the ONLY byte of any recovered entry that changed,
and the loss proof prints it rather than normalising it away.

**What this does NOT cover, stated rather than hidden.** The gate fires at CI
time, not at merge time — the bad merge still exits 0 on the author's machine and
they see it as a red PR. The only thing measured to stop the merge ITSELF is
deleting the old path: `main` deleting `BUG-HISTORY.md` turns the same merge into
`CONFLICT (modify/delete)`, exit 1, because a union driver resolves content
hunks and cannot resolve a tree-level modify/delete. That is left as an owner
decision, not taken here — it costs the signpost that ~60 comments in `backend/`,
`frontend/` and `docs/` cite by name, which is why #2567 kept it. A branch that
never touched `BUG-HISTORY.md` was verified safe either way.

**Ref.** `fix/restore-bug-ledger-split`, 2026-08-21. Repo tooling; no migration.
Follows #2567 (the split) and #2568 (the merge that undid it).
