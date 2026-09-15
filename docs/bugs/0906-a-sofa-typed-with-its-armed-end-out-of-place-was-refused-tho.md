## A sofa typed with its armed end out of place was refused, though the book reads an armed end as the end its hand names [medium]

<!-- area: AutoCount sync + write-back -->

**Symptom.** The AutoCount write-back refused edits of HC-SO-012736 and
HC-GRN-2609-006 with *"composed Desc2 does not survive a decode"*. Both refusals
were re-read by a resend plan against production on 2026-09-14 (run
34861556114):

- HC-SO-012736, sofa 8030: *"Desc2 decodes to [2A(LHF), Console, 1A(RHF)] but
  the ERP holds [Console, 2A(LHF), 1A(RHF)]"*.
- HC-GRN-2609-006, sofa 9058: *"[1A(LHF), 1NA, CNR, 1A(RHF)] but the ERP holds
  [1NA, 1A(LHF), CNR, 1A(RHF)]"*.

A refused edit sends nothing, so neither document's changes reached the book.

**Root cause (traced).** `collapseSofaLines`
(`backend/src/services/autocount-sofa-collapse.ts`) composes a sofa's Desc2 from
the ERP's pieces in ERP row order. That is the order they were typed, which the
file itself says states nothing about how the sofa is built. It then requires
the text to decode back to that exact sequence.

The book's decoder (`backend/scripts/lib/parse-sofa.mjs`) reads a plain armed
end as the end of the sofa its hand names. Probed locally the same day:

- `CT + 2EL + 1ER` decodes to [2A(LHF), Console, 1A(RHF)].
- `1NA + 1EL + C + 1ER` decodes to [1A(LHF), 1NA, CNR, 1A(RHF)].
- `1EL + C + 1ER + 1NA` decodes to [1A(LHF), CNR, 1NA, 1A(RHF)].
- `C + 1ER + 1NA + 1EL` stays as typed.
- `2EL + 1ER + 2EL + 1ER` (two sofas) stays as typed.

So the composed text was refused for decoding into the only arrangement those
pieces can take.

**Fix.** The compose gate accepts one reordering, and only one: the decoded
pieces are the ERP's pieces with nothing moved except plain armed ends
(1A/2A LHF/RHF). There must be at most one of each hand, the left end first,
the right end last, and every other piece in the ERP's relative order. Size,
colour and specials are then compared exactly against that arrangement.
Handedness is never changed, so the mirror cannot be written. The echo rungs
stay exact.

The test is `backend/src/services/autocount-sofa-collapse.armed-ends.test.ts`,
built from the production rows of both documents. It fails on the unfixed tree
(2 failed: `expected [ { …(3) } ] to deeply equal []`) and passes after, with
controls for swapped hands and for two sofas' worth of ends. The five sofa
suites pass: 81 tests.

**Not fixed here.** Also refused on 2026-09-14, and not this defect:

- HC-SO-012025, sofa 9050: its row order is typed out of place too, but its
  specials run long. Whether it now composes is UNTESTED until the resend plan
  after deploy.
- HC-SO-002861 / HC-PO-009827: one book line mixes model 8060 pieces with an
  8069-CNR.
- HC-PO-2609-047 and HC-PO-2609-063: book lines that each hold a single armed
  end or chaise, which the grammar has no word for (`2ER` decodes to [2S]).

Those need a person to decide what the book should say.

**Ref.** fix/ac-sofa-spelling, 2026-09-14.
