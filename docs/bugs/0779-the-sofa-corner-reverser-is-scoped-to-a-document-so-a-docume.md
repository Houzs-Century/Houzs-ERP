## The sofa corner reverser is scoped to a DOCUMENT, so a document carrying two sofas could not be repaired at all [high]

**Symptom.** `HC-SO-012025` came out of the TV-direction round HELD, with this
note in `data/sofa-compartment-corrections-tv-direction.json`:

> HELD: this document carries 2 sofa lines and the drawing round did not record
> which line the build belongs to. Guessing would put one sofa's build on
> another.

It stayed held. A held document is a customer's sofa still recorded mirrored —
the factory builds the corner at the wrong point in the run and the piece cannot
be turned round afterwards.

**Root cause (traced, by reading what the ERP actually holds).** The hold was
correct and its stated reason was wrong, which is why it never resolved.

`diag-so-erp-build` against production (run 34448843248) prints the document as
eight lines, and the two sofas are not ambiguous at all — the account book's own
line key separates them:

```
#1 9050-1A(LHF)  key 829179      #6 9050-1NA      key 829179
#2 9050-1S       key 829180      #7 9050-CNR      key 829179
#3 LONG PILLOW                   #8 9050-1A(RHF)  key 829179
#4 MISCELLANEOUS  #5 STORAGE CHARGES
```

Key `829180` is a loose single seater. Key `829179` is the four-piece sectional,
and it is the only build on the document whose shape matches the one the held
entry recorded (`1A(LHF)+CNR+1NA+1A(RHF)`). Nothing had to be guessed; the
answer was one read away and nobody made it. That is the memory
`open-the-source-file-not-the-summary` again — the held NOTE was believed
instead of the document.

**The defect the hold was really hiding** is in the tool.
`reverse-sofa-middle-order-2026-09-10.mjs` selects `lower(item_group) = 'sofa'`
for a whole `doc_no` and reverses the middle of THAT sequence. Here that
sequence is `1A(LHF)+1S+1NA+CNR+1A(RHF)` — one sofa's pieces with another sofa's
chair sitting inside them — so its middle is `1S+1NA+CNR` and reversing it would
move the loose chair into the sectional. The script's pre-flight refuses (the
target is not its own middle reversed), which is the right answer and also a
dead end: **there was no tool that could repair this document, and the hold
recorded the symptom as if it were a data gap.**

`apply-sofa-compartment-corrections` cannot do it either — it pairs rows by
CODE, and a corner that only MOVES keeps its code, which is exactly
`docs/bugs/0777`.

**Fix.** `backend/scripts/reverse-sofa-build-middle-2026-09-10.mjs`. The unit
that has a direction is the BUILD, not the document, so the target names
`linked_ac_dtlkey` — a sofa is one line in the book — and only that build's rows
are read and moved. Same safety argument as 0777: it moves `line_no` and never
`item_code`, so a purchase order's `so_item_id` keeps naming the same
compartment; the movers are parked on negative line numbers inside one
transaction; the build's first and last rows never move, which is what keeps the
money still.

**The verification asserts the thing that was missing.** Beside the build's
SEQUENCE (never merely its multiset — a reordering does not change a multiset,
which is how 0777 passed while nine sofas were still wrong), its code multiset,
its row count and both money columns, it asserts on a fresh connection that
**every row on the document OUTSIDE the build kept its `line_no` to the number**.
On a multi-sofa document that is the whole risk, and it is the assertion neither
existing tool could have made, because neither had a concept of "outside the
build".

**Lesson.** A HELD item is a claim, and a claim decays. This one named a cause
("we do not know which line") that a single read refuted, and because the note
sounded like a data problem nobody re-opened it for a day. When something is
parked, park the OBSERVATION that would release it, not the conclusion.

**Ref.** chore/sofa-direction-backlog, 2026-09-10.
