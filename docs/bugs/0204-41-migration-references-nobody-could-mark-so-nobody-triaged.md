## 41 migration references nobody could mark, so nobody triaged any of them [medium]

<!-- area: Repo tooling: tests, ratchets, generators -->

**Symptom.** `check-docs-drift` reported **41** `renamed-migration` advisories —
each one a doc naming a migration filename that no longer exists, where the
NUMBER now resolves to a completely different migration. A reader following
`0210_so_amendments.sql` [external] opens `0210_scm_threepl_companies.sql` and finds
something unrelated.

Nobody acted on any of them, and that was rational: the list was mostly correct
references with no way to say so.

**Root cause.** The path check honours three markers — `[gone]`, `[planned]`,
`[external]` — and the migration-FILENAME check honoured none. So a doc could not
declare an honest reference, the advisory could never shrink below 41, and the
real drift sat inside it unread. **A list that can only grow is a list nobody
reads.**

And the markers that existed did not cover the commonest honest case here. The
migration usually still EXISTS and simply carries a different number, because
parallel PRs collide and the loser renumbers. `[gone]` would have been a new lie.

**What the 41 actually were** — established by reading each one's context, not by
pattern:

| kind | count | marker |
|---|---|---|
| 2990's migration tree, said so in the sentence (`migrations-postgres/`, "2990's ...") | 8 | `[external]` |
| the migration exists under a new number | 16 | `[renumbered]` (new) |
| genuinely deleted, incl. `MIGRATION-RETIREMENTS.md`, whose subject IS retirement | 17 | `[gone]` |

**The trap avoided.** The obvious fix — a script that renumbers every reference
to the current file — would have rewritten *2990's* `0210_so_amendments.sql` [external] into
a Houzs migration number. That reference was CORRECT; the checker resolves
against this repo's tree and the doc was talking about another repo's. Reading
one line of context is what caught it.

**Fix.** The migration-filename check honours the same markers, plus a fourth,
`[renumbered]`, which tells the reader the file is findable — just not at that
number. All 41 marked with what is TRUE of each.

**Measured: 41 -> 0.** Not because anything was suppressed — every reference now
carries a reader-facing statement — but because the list is finally a list of
problems. Proven by adding one fake reference to a doc: it appears immediately
against a clean baseline, and removing it returns to zero.

**Ref.** 2026-08-15. Lesson: **a detector with no way to record a legitimate
finding produces a backlog instead of a signal** — and the fix is vocabulary, not
suppression. CLAUDE.md already said it: *"Do not add a silent exemption list
instead. A suppression the reader cannot see is a suppression nobody
re-checks."*
