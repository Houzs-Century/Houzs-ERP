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
