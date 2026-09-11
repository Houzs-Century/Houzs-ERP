## The reconcile reports a sofa the owner has already ruled on as an open difference [medium]

<!-- status: fixed -->

<!-- area: AutoCount sync + write-back -->

**白话.** 有些沙发的件数是老板亲自看图定下来的，账本的字和图不一样时以图为准——所以
ERP **本来就应该**和账本的字不同。可是对账报告不知道有这回事，每次都把这些单当成
「还没处理的问题」再报一次。2026-09-08 那份报告上 8 张单里有 5 张是这种。谁看到都会
再查一次，再问老板一次同样的问题。

**Symptom.** Reconcile run `34212598908` reported `SO VARIANT sofa compartments
— 8 DIFFER on a PROCEEDED order`. **Five of the eight are documents the owner
has already ruled on from the drawing**, and on all five the ERP matches his
ruling exactly:

| document | owner's ruling (pieces) | ERP holds | ruling recorded in |
| --- | --- | --- | --- |
| `HC-SO-010209` | `1A(LHF) 1NA 1A(RHF)` | `1A(LHF)+1NA+1A(RHF)` | `sofa-compartment-corrections-2026-08.json` |
| `HC-SO-011099` | `1A(LHF) 1A(RHF)` | `1A(LHF)+1A(RHF)` | `sofa-compartment-corrections-2026-08.json` |
| `HC-SO-013327` | `1A(LHF) 2A(RHF) 1NA` | `1A(LHF)+2A(RHF)+1NA` | `sofa-compartment-corrections-2026-09.json` |
| `HC-SO-013329` | `1B(LHF) CNR 2A(RHF)` | `1B(LHF)+CNR+2A(RHF)` | `sofa-compartment-corrections-2026-09.json` |
| `HC-SO-013475` | `1A(LHF) 1NA 1A(RHF)` | `1A(LHF)+1A(RHF)+1NA` | `sofa-compartment-corrections-2026-09.json` |

The disagreement is the ruling working. Reported as `DIFFER`, it reads as
outstanding work with a customer behind it.

**Root cause (traced).** `check-ac-erp-reconcile.mjs` already has an
"owner has already ruled" concept — but only for DOCUMENT ABSENCE, at `:823`
and `:1813`, where a ruled absentee is counted separately and named in full.
Nothing equivalent exists on the variant axes. `lib/variant-reconcile.mjs`
compares the decoded Desc2 against the ERP multiset and has no input for a
per-document override, so a build the owner deliberately set against the text
can only come out as `DIFFER`.

The rulings themselves are not lost — they are in
`backend/scripts/data/sofa-compartment-corrections-2026-08.json` and
`-2026-09.json`, which is what `apply-sofa-compartment-corrections.mjs` reads.
The reconcile simply never opens them. `data/variant-book-corrections.json` says
as much in its own `not_here_and_why`: sofa compartments are "another lane, and
the owner's only named exception".

**Why this is worth fixing and not just knowing.** This repo has already named
the cost: *"Quoting the all-orders figure as the backlog has already wasted the
owner's time twice — sofa compartments read as 141 when the work was 30"*
(`lib/variant-reconcile.mjs` header). This is the same failure one level down —
the PROCEEDED figure is itself inflated, by 5 of 8, and every session that reads
it re-derives the same five rulings before it can start.

**Not fixed here, deliberately.** The repair is a new verdict on the
compartments axis — the shape `RECORDED` already uses for the owner's specials
ruling: its own column, never folded into `AGREE`, because the line genuinely
does differ from the book. That touches `VERDICTS`, the summary table's columns,
the axis tests and the checker's loader. `fix/sofa-proceeded-eight` was a
correctness fix to the decoder with a customer waiting, and stacking a
reporting change into it would have put a shared-machinery edit behind an urgent
one. Recorded here so the next lane starts from the measurement rather than
from the investigation.

**What a fix must not do.** It must not fold a ruled line into `AGREE`. The ERP
really does differ from the book's text there, and hiding that would remove the
only signal that would catch a ruling applied to the wrong document.

**FIXED 2026-09-08 by `fix/apply-sofa-rulings`.** The repair is the `RULED`
verdict this entry specified: its own column, never folded into `AGREE`, fed
from the SAME corrections files the apply script writes from. It does what this
entry asked and one thing more - a ruling that has NOT been written stays
`DIFFER` and now NAMES the answer it is failing to match, which is the line that
would have caught `HC-SO-013327` holding `1NA` while the ruling said `1B(RHF)`.
Note the table in this entry is superseded on two rows: the owner re-read those
slips on 2026-09-08 and CHANGED his answers, so what it records as "the ERP
matches his ruling" was true of the OLD reading. See
`docs/sofa-compartment-owner-rulings-2026-09-08.md`.
One of the five, `HC-SO-011099`, is deliberately still `DIFFER`: its ruling
cannot be written yet (`docs/bugs/0719`), and that is the safety property
working, not a gap.

**Ref.** `fix/sofa-proceeded-eight`, 2026-09-08. Measured on reconcile run
`34212598908` and ERP evidence run `34213198537`.
