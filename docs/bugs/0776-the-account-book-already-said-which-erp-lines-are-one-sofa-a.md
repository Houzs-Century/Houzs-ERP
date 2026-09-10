## The account book already said which ERP lines are one sofa, and the collapse guessed by adjacency [high]

**Symptom.** Five sales orders could not reach AutoCount with refusals that read
like a grammar problem — `cannot spell [CNR]`, `cannot spell [2A(RHF)]`,
`cannot spell [1A(LHF)]`. A corner or a single arm genuinely has no meaning on
its own in the book's Desc2 grammar: `1EL` alone decodes to a single SEAT, not a
left arm. So the refusals were right about the text and wrong about the question.

**Root cause (traced, and the evidence was already in the data).** A sofa is ONE
line in AutoCount and several here, and **every piece carries that one line's
`DtlKey`** (`docs/autocount-integration-map.md` 4.2). `collapseSofaLines` forms
its runs by ADJACENCY — consecutive lines sharing a model and a stored Desc2 —
which is right until something interrupts a sofa.

Measured on production 2026-09-10 with `check-sofa-refusals.mjs`:

| document | the refused run | shares its DtlKey with |
| --- | --- | --- |
| `HC-SO-001526` | `[2A(RHF)]` (key 102956) | `1A(LHF)` — with ANOTHER sofa's two lines between them |
| `HC-SO-001255` | `[CNR]` (key 83965) | `2A(LHF)`, `1ABOX(RHF)` |
| `HC-SO-002315` | `[1A(LHF)]` (key 152168) | `1A(RHF)`, `Console` |
| `HC-SO-004716` | `[2A(LHF)]` (key 335512) | `1A(RHF)` |

The book had already answered "which of these lines are one line", and the
collapse never asked.

**Fix, and the hazard it had to avoid.** `scatteredByBookLine` gathers sofa lines
sharing a non-null `DtlKey` **and** a model into one run, at the position of the
first of them. NON-CONTIGUOUS ONLY: a run the adjacency rule already forms is
left to it, so nothing that works today moves.

Gathering alone would have written the wrong sofa. A gathered run arrives in the
ERP's INSERTION order, which states nothing about how the sofa is built:
`HC-SO-001526`'s two ends arrive `[2A(RHF), 1A(LHF)]` while the book holds
`1EL + 2ER`. Composing from the row order round-trips perfectly and writes the
**MIRROR** of the sofa the book records — and nothing downstream would catch it.

So `collapseRun` takes a REQUIRED `bookGrouped` flag, and for a gathered run
whose pieces match the book's as a MULTISET, the ORDER comes from the book's own
text. The line's money, warehouse and dates still come from the ERP rows, which
are not reordered; size, colour and specials are still compared EXACTLY, so a
real edit to any of them recomposes — in the book's order.

**Also here: a last-resort echo.** When both compose attempts fail and the stored
text decodes to the same MULTISET, the book's own text is sent rather than the
document being refused. That is `HC-SO-000814` (`[L(LHF), 2A(RHF), 1NA]` here,
`[L(LHF), 1NA, 2A(RHF)]` in the book) and `HC-SO-001112`. It cannot hide an edit:
it is reached only after the composer has already failed, so a re-arrangement
that composes is written, and one that does not was never going to reach the book
at all.

**Proved RED on the unfixed tree**: with the gathering disabled, 4 of the new
tests fail — including the one that catches the mirror. Green after: 3,518 passed
across `src/services` + `src/scm`.

**Ref.** `fix/a-sofas-pieces-are-one-book-line`, 2026-09-10.
