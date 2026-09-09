## The sofa classifier read AutoCount's ItemCode, so 19 sofas were reported as having no benign explanation [medium]

<!-- area: Cutover + migrated data -->
<!-- status: fixed -->

**Symptom.** `check-ac-convert-symmetry` section 6, on every run up to
2026-09-09, ended its shared-line-key block with:

```
        SO: 455 DtlKey(s) carried by more than one ERP row
           434 are a SOFA line - the expected compartment decomposition
           19 are on a document carrying NO sofa at all; 0 do not resolve to any book line
             SO-002961 key 188830 THL-2379 (2 ERP rows, ERP qty 2 vs book 1)
             ...
NOT SOFA (SO): 19 shared DtlKey(s) sit on a document with no sofa line - each is a
key claimed by ERP rows the book never split, and none has a benign explanation.
```

Read plainly that says: nineteen AutoCount sales-order lines were imported twice
or more, quantity inflated 1 -> 2, 3, even 4, and nobody can say why. It is the
loudest line the section prints and it is wrong.

**Root cause (traced).** The predicate is `SOFA_RE = /\bSOFA\b/i` and it was
applied to `bookLine.itemKey` — AutoCount's ItemCode — and then, as a fallback,
to the ItemCode of every other line on the same book document.

`export-ac-convert-edges.mjs` projects `itemKey` as
`ISNULL(NULLIF(ItemCode,''), LEFT(Description,120))`. So the word SOFA only ever
reaches that field on a **code-less** book line, where the Description ("SOFA
2379 2A(LHF)") is substituted in. A sofa that carries a real item code —
`THL-2379`, `THL-7179`, `THL-7223`, `THL-7219`, `THL-7233` — can never match,
and on these documents the sofa is the ONLY line, so the document fallback
cannot rescue it either.

The split was never sofa vs non-sofa. It was **code-less book line vs coded book
line**, wearing the wrong name.

**Measured, 2026-09-09, against the live book and prod:** all 19 are sofas. Every
one resolves to ERP rows whose `description` matches `/\bSOFA\b/`:

| book line | ERP rows carrying that key |
| --- | --- |
| `SO-002961` key 188830 `THL-2379` | `2379-2A(LHF)`, `2379-1A(RHF)` — "SOFA 2379 …" |
| `SO-006752` key 467885 `THL-2379` | `2379-1A(R)(LHF)`, `2379-2NA`, `2379-1NA`, `2379-2A(RHF)` |
| `SO-008683` key 608174 `THL-7233` | `7233-CNR`, `7233-2NA`, `7233-2A(LHF)` |

19 of 19, no exceptions. The "ERP qty 2 vs book 1" in the message is the same
fact stated twice: one sofa in the book, its compartments in the ERP — the
decomposition this repo has documented since 0273/0280, not a duplicate import.

**Fix.** Ask the side that actually holds the decomposition. The `dups` query now
carries `string_agg(DISTINCT c.description)` for the ERP rows on that key, and a
key whose ERP rows describe a sofa is classified as sofa decomposition. The two
older tests are kept ahead of it — a code-less book line still settles on the
book alone, and the upholstery-line case still settles on the document — so the
new test only ever runs on what those two could not name.

**Verified.** Same snapshot, same database, before and after:

```
before:  434 are a SOFA line | 19 are on a document carrying NO sofa at all
after:   453 are a SOFA line |  0 are on a document carrying NO sofa at all
         SETTLED (SO): all 455 shared DtlKeys are sofa decomposition
```

`diff` of the two full runs is 27 lines and every one of them is inside this
block. Nothing else in the report moved.

**What it cost.** Nothing was repaired on the strength of it — but it is the one
line in a 478-line report that says a population has no explanation, and it
survived every run since the section was written. A checker that cries wolf in
its loudest sentence spends the reader's attention on the wrong nineteen
documents.
