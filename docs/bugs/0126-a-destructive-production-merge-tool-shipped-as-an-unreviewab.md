## A destructive production merge tool shipped as an unreviewable binary blob [medium]

**Symptom** — `gh pr diff 2082` renders the whole 280-line script as
`Binary files /dev/null and b/backend/scripts/merge-duplicate-fabric-colours.mjs
differ`, and the PR's file list reports **0 additions and 0 deletions** for it
against 86 for the workflow. `git grep` cannot read it either:
`git grep -n isCanonicalShape origin/main -- backend/scripts/` prints only
`Binary file … matches` — no line number, no content. A tool that repoints fabric
colours across 15 line tables, 8 `variant_key` stock tables, the stored
`description2` every PDF prints, the model colour whitelist and the cost row, on
production, went through review with no reviewable diff.

**Root cause (traced, not guessed)** — a raw NUL byte (`0x00`) sits inside a
template literal in the source, at byte offset 7202 of 15230:

```js
const k = `${r.fabric_id}\x00${canonId(p)}`;
```

— an actual NUL character in the file, not the two-character escape `\0` and not
`\\u0000`. Git classifies a blob as binary on finding a NUL in its scan window, so
every diff, grep and review surface downstream declines to show the file. No
`.gitattributes` entry is involved: `git show origin/main:.gitattributes` carries
one rule, `BUG-HISTORY.md merge=union`. At runtime the NUL is a legal string
character and the Map key works, so nothing failed, nothing warned, and the file
is invisible to every future `git grep` audit that sweeps for writers of
`scm.fabric_colours`.

**Fix** — none shipped, and recording that is the point of this entry. The
one-character remedy is to write the separator as the escape `\\u0000` (byte-identical
key, plain-ASCII source) or as any non-NUL separator.

**A second defect, still on `main` today: the number.** The script's header says
*"THE CASES, from a prod run on 2026-08-13 — 68 of them"*, and
`.github/workflows/merge-duplicate-fabric-colours.yml:3` repeats *"68 of them on
prod"*. PR #2084, merged 68 minutes later, states that the detector producing
that figure did not exclude already-retired rows and that the live pair count is
**3**. Both 68s are still there. CLAUDE.md is explicit — *a number in a comment is
a fact with an expiry date, and you own keeping it true* — and this one expired
inside the hour, in a header a future operator reads to decide whether to run a
destructive job.

**The class, for next time** — the stale-number rule has no automated check, and
`docs/bug-classes.md` does not exist in this repository, so the only enforcement
is reading. The binary half has no class entry at all: nothing in CI asserts that
a file under `backend/scripts/` is diffable text, which is exactly why a 280-line
production-mutating script could be merged unread. A one-line guard over
`git diff --numstat` (a source file reporting `-` for both counts is not text)
would have caught it at the PR.

**Ref** — 2026-08-13, PR #2082 (`feat/fabric-colour-dedupe-tool`). Entry written
2026-08-14 by reading the file's bytes on origin/main `de99056d5`, since the diff
does not show them. No module guide covers `backend/scripts/`.

---
