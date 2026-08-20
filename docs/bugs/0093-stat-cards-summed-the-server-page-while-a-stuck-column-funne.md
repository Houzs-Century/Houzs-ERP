## Stat cards summed the server page while a stuck column funnel decided what was on screen [high]

**Symptom** - reported by the owner as two separate faults: *"this 2 PO could
not find"* (`PO2608-007`, `PO2608-005 revise`) and *"PO outstanding not
tally"*. Both POs were present, `SUBMITTED`, uncancelled. Every pill count and
every money total was independently correct against the database - 60 POs,
RM 164,349.70, pills 13 + 0 + 43 + 4 = 60.

**Root cause (traced)** - a DATE funnel was active on the table. The
per-column funnels are client-side **and persisted per user** (`dt:filters:*`,
added 2026-07-29 because *"filters kept resetting on reload"*). A filter set
once survives every reload, and past the first reload it no longer reads as a
filter - it reads as a broken list. The stat cards summed the SERVER page and
knew nothing about the funnels, so the screen showed **5 rows worth RM 9,112.50
under a card reading RM 164,349.70**, and the two "missing" POs - dated 08-03
and 08-10 - were three rows below the filter. Two contradictory numbers on one
screen are indistinguishable from a bug, which is exactly how it was reported.

**Fix** - `DataTable` gained `onFilteredRowsChange`, named and shaped to match
the `DataGrid` prop it mirrors so a page swapping components does not relearn
the contract (#2092, Purchase Orders). The same shape was live on Purchase
Invoices, Sales Invoices and Delivery Orders, so #2097 lifted the logic into
`hooks/useVisibleRows`, retrofitted Purchase Orders onto it rather than leaving
a hand-copied block in four pages, and every tile now describes the rows on
screen and says `Filtered` while a funnel narrows them. #2097 also corrected a
stale comment shipped in #2092 that claimed the test compared array identity
when the code compares length - length is right, because the table returns a
fresh array on every recompute.

**Lesson** - **persisting a filter changes what it means.** A filter the user
set this minute is understood; the same filter three reloads later is invisible
state that reframes every number beside it. Anything that survives a reload
must keep saying so on screen - which is what the `Filtered` label now does.
A second lesson, from the pair: the follow-up was needed only because the first
fix was written inline in one page. Fix the shape, not the instance.

**Ref** - PR #2092 and PR #2097, 2026-08-13. Entry written 2026-08-13 during a
documentation audit, not at merge time.

---
