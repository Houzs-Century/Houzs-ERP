## The docs-drift gate could not see the first 23 characters of any line, because its own self-test left a regex mid-string [high]

<!-- area: Repo tooling: tests, ratchets, generators -->

**Symptom.** `check-docs-drift --strict` had been green on every branch for as
long as anyone had run it, and the number it reported was 3,106 checkable claims
across 662 markdown files with **0 CERTAIN findings**. Both halves were wrong.
With the indices clean the same tree yields **6,322 claims and 50 CERTAIN
findings** — dangling paths, deleted npm scripts, a runbook telling the reader to
run a command that no longer exists. Every "docs-drift is green" ever written in
this repo was that much weaker than it read, including sentences written the same
day this was found.

**Root cause (traced, not guessed).** The self-test block at the top of
`backend/scripts/check-docs-drift.mjs` probed the module-level patterns IN PLACE:

```js
const one = (re, s) => { re.lastIndex = 0; return re.exec(s); };
```

`exec` on a `/g` regex advances `lastIndex` and leaves it advanced. The last
`FILE_REF` probe was `one(FILE_REF, "in backend/package.json today")`, whose match
ends at offset 23. `String.prototype.matchAll` does not ignore that: per spec it
clones the regex with the species constructor and **copies `lastIndex` into the
clone**. So every `matchAll` in the scan started at offset 23 of every line, and
the head of every line in every doc was unreadable. Observed directly:

```
lastIndex AFTER self-test      : 23
matchAll with dirty lastIndex  : []
matchAll with lastIndex = 0    : [ the path this line names ]
```

The path the clean run recovered was `docs/generated/bug-index.md` [generated].

Five patterns were left dirty, not one — `FILE_REF` 23, `PERM_REF` 35,
`NPM_REF` 35, `BARE_LINE_REF` 20, `MIG_REF` 18.

The bitter part: this file already carried a startup self-test, written and
extended precisely because *"a pattern that cannot match reports a clean run, and
this repo has produced that failure three times in one day."* **The self-test was
the thing that broke the patterns.** It asserted every alternation and every
extension, and the one property it never asserted was the state it was itself
mutating.

**Fix.** The probe helper builds a fresh `RegExp` per call, so the scan's objects
are never touched. That direction is the decision: `lastIndex = 0` before each
use is a discipline every future call site has to remember, and forgetting it is
*invisible* — it under-reports. Removing the shared mutable state leaves nothing
to forget. A second assertion then runs after the self-test and before the scan:
every `/g` pattern must be at `lastIndex === 0`, or the script prints which one
is not and exits 2. Proved by reverting the helper to the old in-place `exec` —
the run stops with all five offsets printed rather than reporting a clean scan.

Three further defects surfaced once the scan could see:

- **Two marker alternations had diverged.** `[renumbered]` was known only to the
  migration-filename check and `[generated]` only to the path check, so
  `delivery-planning-jobtypes-spec.md` — which had used the right marker for its
  shape — was reported anyway. One `MARKER_RX` now, honoured by paths, migration
  filenames and `npm run` names alike, and its closing-delimiter run went from
  one character to many so that `` `"test": "… && npm run x"` [gone] `` can be
  marked at all.
- **The `npm run` check had no markers.** Seven references to
  `npm run test:scale-contract` [gone] sit in entries whose SUBJECT is that script,
  deleted 2026-08-20. The only ways to clear them were to falsify the record or
  switch the gate off. It reads the shared list now, and skips an all-caps
  metavariable (`npm run X`) the way the path check already skips `NNNN_foo.sql`
  — safe because zero of the 114 scripts in the three manifests lack a lowercase
  letter.
- **`inFence` was assigned and read by nothing.** Dead state that looked like a
  working exclusion. Removed rather than wired up: a fence is where a doc puts
  the command a reader copies, and honouring it would have hidden the stale
  `npm run test:scale-contract` [gone] inside the powershell fence in
  `SCALE-PERFORMANCE-HARNESS.md`. The cost is recorded in CLAUDE.md — a fence quoting
  verbatim output cannot take a marker without falsifying the quote, so the path
  gets lifted into marked prose.

The 50 findings were triaged, not suppressed: 14 were duplicates inside a
`BUG-HISTORY.md` that a union merge had resurrected (see the sibling entry), 2
were the checker being wrong about a shape, and the remaining 34 became reader-
visible markers or corrected citations. No exemption list was added.

**Ref.** `fix/checkers-that-cannot-match`, 2026-08-21. Before/after measured on
the same untouched `origin/main` doc tree at `019ee2a64` by copying only the
repaired script into a detached worktree.
