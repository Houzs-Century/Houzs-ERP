## The sofa still short at the selling warehouses is 25 units with no purchase document, not missing stock [medium]

**Status: OPEN — measured, deliberately NOT written.** This entry exists to give
the refusal a SIZE. 0679 lifted the display refusal and recorded that a second
refusal stayed in place; what it never carried was how big that one is.

**Symptom.** After the display units came in, the sofa axis reads
**AutoCount 107 vs ERP 107 — net zero** (reconcile run **34162013501**,
2026-09-08 **05:08 (+08)**). The total agrees and the distribution does not:
**41 cells compared, 19 agree, 22 disagree.** Both showroom warehouses are now
clean — `BALAKONG DISPLAY` 15/15 cells agree (24 vs 24) and `PENANG DISPLAY`
2/2 (2 vs 2) — so every remaining disagreement is at a SELLING warehouse:

| warehouse | cells | agree | AutoCount | ERP | delta |
|---|---|---|---|---|---|
| PENANG WAREHOUSE | 11 | 1 | 24 | 20 | **-4** |
| BALAKONG WAREHOUSE | 13 | 1 | 57 | 61 | **+4** |
| BALAKONG DISPLAY | 15 | 15 | 24 | 24 | 0 |
| PENANG DISPLAY | 2 | 2 | 2 | 2 | 0 |

The shorts sum to **25 units over 10 cells** and the overs to **25 units over 12
cells**. That balance is a coincidence of totals, NOT a warehouse move: only
model **8050** appears on both sides (short 1 at PG, over 1 at KL). Every other
model is short-only or over-only, so "the same sofas standing in the wrong
branch" is REFUTED for 24 of the 25.

**Root cause (traced, and it is two different causes, one per side).**

**The SHORT side — the book holds sofas that no received purchase order
documents.** `import-ac-sofa-stock.mjs` reconstructs a sofa from its PO's
compartments, so a unit with no PO cannot be built. Its own run
(**34160820055**, APPLY, 04:49 (+08)) named 47 such units, and **every short
model appears on that list**: `HOK-5530` AutoCount 12 / documented 5,
`RDS-5527` 5 / 1, `THL-2379` 7 / 1, `HOK-5540` 4 / 2, `THL-7219` 2 / 0,
`HOK-5536` 2 / 1, `HOK-5537` 1 / 0. This is the SAME class as the display units
— a sofa the book holds with no purchase document behind it — and the display
half was written while this half was not. The difference is deliberate and worth
keeping: a display unit stands where nothing is sold, but a configuration-less
lot opened at a SELLING warehouse would show as on-hand beside real demand while
remaining un-allocatable (no batch → `findCoveringBatch` can never cover it),
which reads as a bug to whoever looks at the MRP page. The importer says so
itself: *"the remedy is to recover the document, not to open a
configuration-less lot beside real demand."*

**The OVER side — LIKELY, not proven.** The same run dropped **16 builds as
"over AutoCount balance"** and **11 as unparsed placeholders**, and the
over-models are exactly those it dropped (`DSL-8030` from PO-008310 and
PO-006830, `DSL-9058` from PO-007520 and PO-007009, `DSL-9028` from PO-007250,
`DSL-8050` five times, `TD-5119`, `DSL-8069`). The dropped builds were not
created, so the surplus is standing rows from EARLIER import rounds that the
book's balance has since drawn down. Two of the over models — **9028** and
**9058** — are additionally the only sofa models fed by TWO AutoCount codes each
(`AMN-SF9028` + `DSL-9028`, `AMN-SF9058` + `DSL-9058` both fold to one ERP
model), so they carry a second, independent way to double. Neither mechanism is
proven for a specific cell here; both are named so the next person tests them
rather than re-deriving them.

**Money.** Value across the disagreeing cells is **RM 59,568.49**, and it is
still a LOWER BOUND — only **9 of the 22** disagreeing cells carry any cost at
all. (It has RISEN from the RM 50,147.23 measured over 38 cells before the
display import, because the cells that closed were the costless ones.)

**Fix.** None, by intent. Opening these 25 units is an owner decision, not a
defect repair, and the recorded remedy is to recover the missing purchase
documents. Whatever is decided must not be a flag on a migrated row.

**Ref.** fix/display-sofas-as-the-book-holds-them, 2026-09-08.
