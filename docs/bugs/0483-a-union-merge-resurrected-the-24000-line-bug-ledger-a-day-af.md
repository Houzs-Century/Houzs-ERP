## A union merge resurrected the 24,000-line bug ledger a day after it was split, and buried the signpost under it [medium]

<!-- area: Repo tooling: tests, ratchets, generators -->

**Symptom.** `BUG-HISTORY.md` on `main` was **24,129 lines with 466 `## ` entry
headings** — one day after `#2567` reduced it to a 39-line signpost and moved
every entry into `docs/bugs/`. The signpost was still there, at **line 24,093**,
under the whole resurrected ledger. Anyone opening the file, or grepping it, met
the old ledger and no hint that it had moved.

**Root cause (traced, not guessed).** `#2568` branched before the split. Its
merge re-added the content the split had deleted, and its own new entry went
**only** into `BUG-HISTORY.md` — never into `docs/bugs/`. The shape is the same
one `.gitattributes` documents at length: `BUG-HISTORY.md merge=union` was the
old resolution for this file, and a union-style resolution of *delete-all* versus
*keep-and-prepend* keeps everything. The attribute itself was removed by `#2567`,
so this was not the driver firing — it is the same collision resolved the same
way by hand or by GitHub's git, which is exactly why the split (not a driver) was
the fix.

Verified before touching anything, rather than assumed: of the 466 headings in
the resurrected file, **465 already existed byte-for-byte as `docs/bugs/` entry
files**, and the single orphan was `#2568`'s own new entry.

**Fix.** `BUG-HISTORY.md` restored to the signpost blob from `9e74aba84`, and the
one orphan rescued into `docs/bugs/` under the next ordinal with its text
unchanged. `npm --prefix backend run audit:bug-history` then reports 479 entries
generating cleanly, and the round-trip test still holds.

Nothing was deleted that is not still in the tree: the containment check above is
the proof, and it is one command to repeat —

```sh
node -e "…compare every '## ' heading in BUG-HISTORY.md against the first line of every docs/bugs/*.md…"
```

**Why it was noticed at all**, which is the part worth keeping: it was not
noticed by a person reading the file. `check-docs-drift` — repaired in the same
PR — reported 14 CERTAIN findings inside `BUG-HISTORY.md` that were duplicates of
findings in `docs/bugs/`, and duplicated findings are what a resurrected file
looks like from a checker's side. **A gate that can see is also an inventory.**

**Ref.** `fix/checkers-that-cannot-match`, 2026-08-21. Regression introduced by
`80f4f9756` (`#2568`); split it undid was `9e74aba84` (`#2567`).
