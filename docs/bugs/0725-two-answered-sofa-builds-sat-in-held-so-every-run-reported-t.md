## Two answered sofa builds sat in _held, so every run reported them as outstanding [medium]

**Symptom.** The owner read his slips one by one on 2026-09-08 and ended with
「所以全部答案我都给你了」. Two of those documents still reported as unanswered on
every tally run afterwards: `HC-SO-011601` as "CANNOT BE COMPARED — your drawing
decides these", and `HC-SO-011657` as a build nobody had settled. That is the
report handing him back work he had already done, which is the same objection as
docs/bugs/0720 and 0722 — 「这个很多我刚刚都给过你答案了啊」.

**Root cause (traced).** Both were held for a REAL reason at the time, and both
reasons had since been answered by him rather than by us:

- `HC-SO-011601` — he had given only the corner and the seat
  (「第一个是corner 你也应该懂的 32寸seat」), so the drawing round left it in that
  file's `_unread` list as ambiguous on two counts. The rest of the slip is
  legible once the 240px original is enlarged; read, put to him, confirmed
  「对啊」.
- `HC-SO-011657` — his STOOL ruling was never in doubt, but `9838-STOOL` is not
  minted (prod dry runs 34234942367 / 34235361240 / 34235917676 all answered
  `REFUSED - piece SKU not minted`) and which model a `TNS-9838 DB` stool belongs
  to was a judgement nobody held, since `TNS-9838 DB` and `TNS-9838 SOFA` are two
  separate Discontinued items in the book. Put to him, he answered
  「那就放8030 daybed把」.

The mechanism that made the staleness invisible is in `lib/sofa-rulings.mjs`:
`makeSofaRulingLookup` EXCLUDES `_held` by design, so a build parked there keeps
reading DIFFER / unanswerable however complete its answer has become. `_held` is
correct for a build we cannot write; it is wrong the moment the answer arrives,
and nothing was checking which of the two a held entry was.

Writing his 8030 answer then hit a second, separate wall. `tests/sofaCorrectionsVsBook.test.mjs`
refuses any entry naming a model the book does not — the guard bought by
docs/bugs/0693, where three hand-typed models outranked the book for a month —
and the book names `9838 DB` on this line. Loosening that guard was not an
option; a typed model and a decided one had to become distinguishable instead.

**Fix.** Both builds moved out of `_held` into `entries` in
`backend/scripts/data/sofa-compartment-corrections-2026-09.json` (34 -> 36
builds, `_held` now empty), each carrying the evidence in its own `why`.

`HC-SO-011657` is the first entry to carry `modelOverride`, and
`lib/sofa-corrections-book-grade.mjs` gained an `OWNER-OVERRIDE` verdict that is
STRICTER than what it sits beside, not looser:

- an undeclared model that differs is still `DIFFER`, so 0693 stays caught;
- a declaration must name the book model it overrides AND who decided it;
- a declaration that stops matching the book is `DIFFER` again, so refreshing
  the book cut re-opens every override whose ground has moved;
- the verdict is reported with the differences, never folded into `AGREE`.

Proved RED on the unfixed tree first: `sofa-corrections-source.test.mjs` failed
`actual: 34, expected: 36` and `HC-SO-011601: the owner answered this one`, and
`sofaCorrectionsVsBook.test.mjs` failed `- "OWNER-OVERRIDE": 1 / + "DIFFER": 1`.
Both green after.

**What this deliberately does NOT hide.** With model `8030` the line classifies
as `different` against the book's `TNS-9838 DB` in `lib/item-code-class.mjs`
("the book's sofa is model 9838; ours says 8030"), where the book's own model
would have classified as `decomposition` and cost nothing. So the ERP names a
product the book does not on that one line, BY HIS DECISION — the book's daybed
is discontinued and has no stool piece to sell. It is declared in the file and
printed by `check-sofa-corrections-vs-book.mjs` rather than suppressed, because
a book disagreement made invisible is exactly what 0693 was about.

**Ref.** fix/sofa-two-held, 2026-09-08.
