# The SO / PO / DO reconcile remainder — 2026-09-08 (Malaysia, UTC+8)

What the go-live reconcile still reports on the sales-order, purchase-order and
delivery-order line, quantity and money axes, **one row per document, with the
cause**. Written so the next person repairs rather than re-derives.

Measured, not recalled: reconcile run `34185154444` (11:55) before,
run `34188835226` (12:58) after, and probe run `34186980493`
(`probe-cutover-so-do-lines.yml`, read-only) for the line-by-line evidence. The
book is the committed snapshot `ac-reconcile-truth.json.gz`, exported
2026-09-08T00:03:44Z = **08:03 Malaysia**.

## What moved

| axis | 11:55 | 12:58 | what closed it |
| --- | --- | --- | --- |
| SO line count | 19 | **11** | 8 were AutoCount's own EMPTY ROWS — `docs/bugs/0695` |
| SO quantity | 1 | 1 | — |
| SO document total | 6 | **5** | `SO-000021`'s line discount — `docs/bugs/0696`, applied run `34188782181` |
| PO document total | 1 | **0** | `PO-009770`'s line discount — `docs/bugs/0693`/`0694`, applied run `34187837941` |
| DO line count | 4 | **2** | 2 were the book's own annotation rows — `docs/bugs/0695` |
| DO quantity | 2 | **1** | `DO-001604`'s was a pairing artifact of one of those empty rows |
| DO document total | 1 | 1 | — |
| **these three types** | **34** | **21** | |

Whole reconcile over the same window, all lanes: **127 → 40**.

## The 0691 blind spot, SIZED

`docs/bugs/0691` named it and did not measure it: a document whose book side and
ERP side hold the same NUMBER of rows can still be missing a line, because a
decomposed sofa contributed two rows and the line beside it contributed none.
Section B of the probe counts the DISTINCT AutoCount keys the ERP CLAIMS — a
decomposition counts once — for every paired document. Run `34186980493`:

```
SO: 2882 paired; 93 UNJUDGEABLE (an ERP row carries no AutoCount key);
    2772 claim every book line; 17 do NOT — and 0 of the 17 are invisible to the
    line-count column.
PO: 574 paired; 12 UNJUDGEABLE; 562 clean; 0 offenders.
DO: 173 paired; 173 UNJUDGEABLE; 0 measurable.
```

**On the judgeable population the blind spot hides nothing** — every unclaimed
book line is already on the line-count list. `HC-SO-012128`, the document the bug
was written about, is in the 93: BOTH its ERP rows carry no line key, so its
missing pillow line surfaces on the quantity and item-code axes instead.

**On delivery orders the question is UNANSWERABLE, and that is the finding.**
`delivery_order_items.linked_ac_dtlkey` is null on every one of the 173 migrated
documents, so no DO can be compared line by line at all; each verdict there rests
on the checker's value-then-order fallback.

## The 21 that remain

### A — six sales orders are missing a line the shop added to the book after we imported (6 line count + 3 money)

| document | the missing line | why it is still there |
| --- | --- | --- |
| `SO-007144` | `AK-HAPPY SLEEP EASY` x2, RM 0.00, "Compensate" | out of the outstanding scope, so `ac-outstanding-so.json.gz` carries **zero** lines for it and `topup-ac-so-lines.mjs` cannot see it (`docs/bugs/0694`) |
| `SO-013181` | `DISPOSE` x1, RM 0.00 | same |
| `SO-003945` | `STORAGE` x1, **RM 150.00** | same, and priced |
| `SO-010789` | `TRANSPORTATION CHARGES` x1, **RM 150.00**, "Last minute cancellation fee" | `topup` reports a priced miss and never writes it — adding one moves the header total |
| `SO-008319` | `STORAGE` x1, **RM 150.00** | same |
| `SO-012842` | `Miscellaneous` x1, **RM 300.00**, "bedframe Change fabric color to PC151-01" | same — **and this one is worse than the money column says**: its header reads RM 4,888.00 while its own lines sum to RM 4,588.00, so the total matches the book only because the header already disagrees with itself |

Remedy: one tool that adds a missing book line over the population the ERP
HOLDS (not the outstanding scope), reading `ac-reconcile-truth.json.gz`, and
re-sums the header + the five category buckets when the line is priced — the
same write `repair-so-line-discount.mjs` already performs. `paid_sen` is not
touched; the inconsistency is named.

### B — five bedframe lines on three orders (3 line count)

`SO-011752` (2: `HOK-1013 (Q)` at PC-151-02 and PC-151-17), `SO-010602`
(2: `HOK-DIVAN ONLY (K)`, `HOK-1013 (Q)`), `SO-007362` (1: `HOK-2006(A) (K)`) —
all RM 0.00, all carrying a build text. `topup-ac-so-lines.mjs` REFUSES them by
design: a bedframe line has to be parsed into gap / divan / leg / colour, and
that decoder belongs to `import-ac-outstanding-so.mjs` + `lib/parse-bedframe.mjs`.
Re-decoding it anywhere else is a second copy of an import rule.

### C — the same missing pillow line, seen twice (1 SO quantity + 1 DO quantity)

`SO-012128` / `DO-011465`: `HOK-SQUARE PILLOW` **x4** at RM 0.00, "FOR
CONPESSANTION WRONG ITEM DELIVERY" — four pillows the customer is owed for a
wrong delivery. It is NOT a quantity defect on either document; the ERP's two
rows are the `HOK-5530 SOFA`'s compartments, they carry no AutoCount line key,
and the checker's fallback pairs the book's pillow line against the second
compartment. Money agrees on both documents (RM 3,300.00).

Blocked on the keys: `backfill-ac-sofa-line-keys.mjs` has not reached this
document, so `topup` calls it UNJUDGEABLE and refuses — correctly, under-repair
rather than duplicate.

### D — one order carries a line AutoCount does not have (1 line count + 1 money)

`SO-013160`: the ERP holds a 4th row, `STORAGE` RM 300.00, claiming **DtlKey
892917**. That key is on **no document of any type in the whole snapshot** —
searched across SO, PO, GR, DO, IV and PI. The book's own three lines total
RM 300.00 and ours total RM 600.00. The line was almost certainly deleted in
AutoCount after we imported it.

**This one needs the owner**: removing it is a line DELETION on a live order.

### E — one sofa is priced RM 88.00 above the book (1 money)

`SO-012571`: the book says `DSL-8050 SOFA` RM 3,300.00; the ERP's lead
compartment `8050-1A(R)(LHF)` says RM 3,388.00, and with the RM 150.00 DISPOSE
line that is RM 3,538.00 against the book's RM 3,450.00.
`repair-so-price-from-autocount.mjs` deliberately SKIPS it — dry run
`34188098187`, 2026-09-08 12:47: `SKIPPED, one book line decomposed into several
ERP lines: 305 AutoCount line(s) / 460 ERP row(s)`, because which compartment
carries the money is a decision, not a copy. It belongs to the sofa tooling.

### F — three that are the BOOK's own gap (2 DO line count + 1 SO line count)

The owner accepts these as 一模一样.

| document | what the book says |
| --- | --- |
| `DO-001953` (4 vs 2) | it ships `HB109M-CC` and `HB109NL`, and its own sales order `SO-003186` contains **neither** — its four lines are `AK-ULTIMATE MATT (K)`, `AK-SLEEP ESSENTIAL 7 HOLES`, `NTYR-CS LTX PIL + CSC`, `AK- LTX CLS PIL`. Identical in shape to `HC-DO-001800`, already ruled on. |
| `DO-004903` (3 vs 1) | the same two item codes against `SO-006438`, which contains neither |
| `SO-011384` (12 vs 11) | a row with **no item code and quantity 4**. The book orders four of something it does not name; there is no product to point at and inventing one is forbidden. |

### G — one delivery note is short RM 150.00 (1 money)

`DO-001604`: the book's third line is `* DISPOSE 3S L SHAPE SOFA + CONSOLE
TABLE`, no item code, quantity 1, **RM 150.00**. The ERP's three rows are the
`RDS-5527 SOFA`'s compartments and the dispose line is absent, so the note reads
RM 6,538.00 against the book's RM 6,688.00. A text-only line carrying real money
is explicitly NOT in the blank-row class (`docs/bugs/0695`).

## What was written to production, and what was not

| run | at (Malaysia) | what |
| --- | --- | --- |
| `34187837941` | 12:39 | `HC-PO-009770` — 15 of 15 lines, 1 of 1 header. Verified on a fresh connection: `header total RM 13,893.75, sum of its lines RM 13,893.75` |
| `34188782181` | 12:57 | `HC-SO-000021` — 3 of 3 lines, 1 of 1 header. Verified: total RM 9,876.00 = the book |

**Nothing else was written.** No quantity and no item code moved on any document,
so readiness cannot have moved: the only columns touched are `discount_sen`,
`line_total_sen` / `total_sen` / `total_inc_sen` / `balance_sen` on the line and
`local_total_sen` + the five category buckets on the header.

**One thing the owner must see about `HC-SO-000021`.** Its total is now
RM 9,876.00 and `paid_sen` still reads RM 10,852.00 with a zero balance, so the
order looks RM 976.00 overpaid. That paid figure was never a recorded payment:
`import-ac-outstanding-so.mjs:328` computes `paid = total - UDF_BALANCE`, and the
book states `UDF_BALANCE = 0` with **no payment amount at all**. Re-deriving
`paid_sen` from the corrected total is the same formula on the same inputs — but
it is a payment column, so it is his call and it is not done.

---

# INSIDE the line: colour, seat size and specials — closed 2026-09-08 16:20

The section above is about documents, lines, quantities and money. **The headline
number it produces has never counted what is INSIDE a line.** Colour, seat size,
specials and sofa compartments are a separate scoreboard in the same report, and
reading `40` as the whole story understates it in one direction and overstates it
in another. This section closes the first three of those four. **Sofa
compartments are NOT here** — `fix/staff-reported-flow` owns them.

## Where it landed

On the ORDERS the factory builds from (SO + PO), PROCEEDED — the only population
the owner's rule 「还没proceed还没确认的就可以直接放空的」 counts as work:

| axis | 15:15 (run `34198407570`) | 16:20 (run `34203745033`) |
| --- | --- | --- |
| colour / fabric, DIFFER | 2 | **0** |
| seat size, DIFFER | 2 | **0** |
| specials, ERP blank | 8 | **1** |
| specials, DIFFER | 5 | 5 |
| the book states it and a proceeded order does not carry it | **8** | **1** |

Two separate causes, and only one of them was a data defect.

## Cause 1 — the decoder invented eight of the twelve

`docs/bugs/0705`. The book writes a fabric's code and the mill's own name for the
shade together — `BO315-26 (YELLOW)`, `NX011 (BEIGE)`, `M2402-19(DARK GREY)`.
`parse-sofa.mjs` read the colour correctly and then left the bracket standing,
where the structure pass freed it into a token and the rider catch-all turned it
into a SPECIAL ORDER. The book was asking the factory to build a "PEARL". Seven
lines reached the go-live tally that way. `STOOL(25 X 40INCH)` was the same shape
on the seat axis: a stool's length by its width, read as a 40" seat.

Sized over all 1,979 distinct sofa Desc2 in the snapshot: **49 → 2** (both
remaining are the one genuine instruction, `(PLS FOLLOW DRAWING)`) and **1 → 0**.
No production row was written for this half — the defect was in what the book was
READ as.

## Cause 2 — four lines really did disagree, and were corrected TO THE BOOK

Owner's rule, 2026-09-08: 「一律跟账本。除了sofa compartment而已啊」. Applied by
`repair-so-variant-from-book.mjs` + `repair-so-variant-from-book.yml` from the
reviewed list `backend/scripts/data/variant-book-corrections.json`. PLAN run
`34203337587`, APPLY run **`34203653853`**: `4 of 4 book line(s) merged, across 6
ERP row(s)`, then `VERIFIED on a fresh connection: 6 ERP row(s) ... hold the
book's value, and every one is still a jsonb OBJECT`.

| document | axis | was | now | already downstream? |
| --- | --- | --- | --- | --- |
| `HC-SO-010120` `9058-1S` | colour | `BO315-22` | `HR805-31` | no purchase order, no delivery |
| `HC-SO-013258` `9058-2A(LHF)` + `L(RHF)` | colour | `HR805-31` | `HR805-10` | 2 purchase-order lines |
| `HC-SO-009708` `9050-2A(LHF)` + `1A(RHF)` | seat | 30" | **28"** | 2 purchase-order lines |
| `HC-SO-013310` `5535-1S` | seat | 28" | **30"** | 1 purchase-order line |

**The three with a purchase order behind them are not a divergence this created.**
Checked before writing, with `diag-so-po-variant-divergence.mjs` (run
`34203454325`): on `HC-SO-013258` the purchase order ALREADY held `HR805-10` and
the Desc2 backs the PO — `SO-vs-PO conflict axes: colourId | Desc2 backs PO on:
colourId | backs SO on: (none)`. The factory was already building the right
colour; the sales order was the wrong document, and correcting it CLOSED that
conflict. On `HC-SO-009708` and `HC-SO-013310` the SO and PO Desc2 are IDENTICAL
and the PO seat axis reports zero differences against its own book, so neither
correction can open one.

## What was deliberately NOT written, and by whom it should be

- **Specials — 1 ERP-blank + 5 DIFFER still open on proceeded orders.**
  `variants.specials` folds into the authoritative unit price at ten call sites
  across nine files, so stamping a code there reprices a historical document
  (`docs/bugs/0013`), and `custom_specials` is a DERIVED column the next
  recompute erases. Two writers already know that —
  `backfill-specials-into-variants.mjs` for unpriced codes and
  `record-priced-specials-on-migrated-lines.mjs` for the owner's money-neutral
  ruling 甲. A third would be the bug. The open set is `PO-010082` (blank; the
  book asks for `Backrest change to 8030 design` + `Bottom wrap nylon`),
  `PO-010146`, `PO-010151`, `PO-010161` (the phrase is on the line, the pickable
  CODE is not), `SO-011717` (`one side armrest replace seat`), and `SO-012128` —
  which is not a specials defect at all but the pairing artifact of the missing
  pillow line in section C above.
- **`SO-001526` and `SO-013227`** (seat, both NOT PROCEEDED) carry no AutoCount
  line key, so only the reconcile's own value-then-order fallback can identify
  the row. Building a second, private matcher in a repair script is this repo's
  most expensive recurring bug, so they are REPORTED and untouched
  (`docs/bugs/0707`).
- **`HC-SO-010120` line 2**, `AMN-SOFA PILLOW` DtlKey 687987, Desc2
  `colour : HR 805-10`, holds no colour. It is an ACCESSORY, and the variant
  reconcile models only bedframe and sofa, so it appears on no axis. Found by the
  divergence diagnostic, recorded here because nothing else will report it.

## Stock, money and readiness did not move — measured, not asserted

Only `variants` was written: no quantity, no price, no item code, no status.
Across the two reconcile runs the SO document axes read `quantity: 1; unit price:
0; document total: 5` **before and after**, and every migrated goods receipt is
still `migrated_no_stock with 0 inventory movements naming it`. The document-level
headline moved 40 → 36 in the same window and **that is not this work**: it stayed
at 40 across both branch runs (`34200092543`, `34200664197`), and the change came
with other lanes merging into `main` — more lines paired (SO 14,903 → 14,913, PO
1,309 → 1,327, IV 43 → 45 documents) and a GR item-code reclassification.
