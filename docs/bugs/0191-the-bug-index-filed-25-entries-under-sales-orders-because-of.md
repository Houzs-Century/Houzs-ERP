## The bug index filed 25 entries under Sales orders because of the English word "so" [medium]

<!-- area: Repo tooling: tests, ratchets, generators -->

**Symptom.** None, which is the point. `docs/generated/bug-index.md` [gone] is the only
way into a 9,000-line ledger — "have we hit this before?" is answered by reading
one area's rows. `audit:bug-index` was green throughout: it checks that the FILE
matches the GENERATOR, never that the generator is right. A reader looking under
the right subsystem simply found nothing and concluded there was no prior entry.

**Root cause, two of them.**

*One.* The document abbreviations sat in the case-INSENSITIVE patterns as
`\bso[- ]`, `\bpo[- ]` and `\bdo[- ]`. Under `/i` those match the English words
"so " and "do ". Counted across the ledger:

| form | SO | DO | PO |
|---|---|---|---|
| UPPER + space/hyphen | 151 | 65 | 147 |
| lower + hyphen (`so-revision.ts`) | 111 | 16 | 57 |
| **lower + space (prose)** | **556** | **42** | 0 |

Body hits cap at 5, so any entry whose prose said "so the…" five times scored a
FULL body hit for Sales orders. Of 185 entries, 54 had no area word in their
TITLE and were placed by their body; **20 of those were placed by "so" alone**,
with no real document reference in them at all.

*Two.* There was no area for the repo's OWN machinery. An entry about a ratchet,
a generator or a test runner carries no subsystem vocabulary, so it landed on
whatever English word matched: the coverage-ratchet entry in "Auth, permissions"
on *scope* and *token*, the codebase-map generator in "Fleet, trips" on *route*,
the node:test conversion in "Projects + PMS" on *project* — a vitest project.

**Fix.** A third, case-SENSITIVE column for the abbreviations (uppercase either
separator; lowercase only with a hyphen), a new **Repo tooling** area placed
FIRST so ties fall to it, and an explicit `<!-- area: ... -->` tag an entry can
carry when no keyword table can place it. An unknown tag FAILS the generator
rather than falling back to the guess — a typo that silently reverts to guessing
is worse than no tag. The index now prints how many of its own rows are guessed.

**Measured.** 43 → 18 in Sales orders; 15 entries into the new tooling area; 25
rows left an area they were in only because of an English word.

**What the first fix got wrong, twice, and both are in the guard now.**

`\bgate\b` was in the tooling pattern for one round and dragged four PRODUCT
entries in — the confirm gate, the stock-location gate, a permission gate, and
"A shipped DO's line cost was rebuilt from a ROUNDED unit price", which is about
money. Houzs calls product features gates. **A word is generic or not according
to THIS REPO's vocabulary, not English.**

And the guard's own red proof slipped through: it listed six literal strings
(`"\\bso[- ]"` and friends), a shell ate the `\b` while reverting the fix, the
generator got a bare `so[- ]` — every bit as ruinous — and the guard said
nothing and reported exit 0. It matches the SHAPE now, and the red proof was
redone by editing the file directly.

**Ref.** 2026-08-14. `backend/tests/bugIndexAreas.test.ts`, red-proven. Lesson:
**a generated doc can be perfectly consistent with its generator and still be
wrong about every row** — `--check` gates the copy, and nothing gated the
judgement until this test.
