# The SO / PO / DO reconcile remainder — 2026-09-08 (Malaysia, UTC+8)

> **UPDATED 16:40. Sections A, B and G are DONE — 11 sales-order lines on 9
> documents and 1 delivery-note line were written to production, and the whole
> reconcile went 36 -> 23.** What each section says below is what it said at
> 12:58; the section headings now carry their outcome, and the run ids are in
> *What was written to production* at the foot of this file. C, D, E and F are
> unchanged and still need what they needed.

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

### A — six sales orders are missing a line the shop added to the book after we imported (6 line count + 3 money) — **DONE, apply run `34204421089`**

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

### B — five bedframe lines on three orders (3 line count) — **DONE, same run**

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

### F — three that are the BOOK's own gap (2 DO line count + 1 SO line count) — **TWO OF THE THREE WERE MISCLASSIFIED. DONE, apply run `34213756311`**

> **CORRECTED 18:08.** `DO-001953` and `DO-004903` were **not** the book's own
> gap and never needed the owner. The reading below stopped at *"its own sales
> order contains neither"* and read that as nothing to do; what it actually
> means is that **four lines of goods the customer received were missing from
> our delivery note.** Repaired to the book, and the DO axis of the reconcile is
> now **0 on every column**. Full trace:
> `docs/bugs/0713-the-delivery-order-s-item-code-was-changed-after-the-convers.md`.
> `SO-011384` is unchanged and still stands.

| document | what the book says | outcome |
| --- | --- | --- |
| `DO-001953` (4 vs 2) | it ships `HB109M-CC` and `HB109NL`, and its own sales order `SO-003186` contains **neither** — its four lines are `AK-ULTIMATE MATT (K)`, `AK-SLEEP ESSENTIAL 7 HOLES`, `NTYR-CS LTX PIL + CSC`, `AK- LTX CLS PIL`. Identical in shape to `HC-DO-001800`, already ruled on. | **REPAIRED.** 4 vs 4 |
| `DO-004903` (3 vs 1) | the same two item codes against `SO-006438`, which contains neither | **REPAIRED.** 3 vs 3 |
| `SO-011384` (12 vs 11) | a row with **no item code and quantity 4**. The book orders four of something it does not name; there is no product to point at and inventing one is forbidden. | still stands |

**Why the first reading was wrong, in one measurement.** AutoCount increments a
sales-order line's `TransferedQty` only when it is CONVERTED. `SO-003186` has
exactly one delivery order converted from it and its total `TransferedQty` (8)
equals that note's total quantity (8); `SO-006438` the same at 3. So every unit
on those notes came through the conversion, and the item code on the line was
changed **after** it — which nothing objected to because `FromDocDtlKey` is
empty on all 48,772 DO lines in this book. And the goods are the same goods:
`HB109NL` is `LATEX PILLOW`, `HB109M-CC` is `COOL SILK LATEX PILLOW COVER`, and
the order lines that transferred are `NTYR-CS LTX PIL + CSC` (pillow **plus**
cool-silk cover) and `AK- LTX CLS PIL`. The note itemises the same pillows by
component code.

**WHICH ordered line each answers is still not decidable** — `{4,4}` answers
`{4,4}` — so `so_item_id` stays NULL, exactly the ruling `docs/bugs/0706` made
on `HC-DO-001800`. The rows carry `ac_substituted = true` instead, which is what
puts the amber badge on both surfaces.

**The class, sized, because the line-count axis cannot see it.** A note whose
code was changed without changing the count is invisible on that axis.
`backend/scripts/probe-do-code-changed-after-conversion.mjs` sweeps the book:
**34 lines on 30 delivery orders**. Against production (`probe-cutover-so-do-lines`
run `34213215063`, all 30 named) the ERP holds **4** of the 30 — `DO-001800` and
`DO-005583`, complete, and these two — and the other **26** are correctly absent,
their sales orders having been fully delivered before the cut. **There is no
third document.**

### G — one delivery note is short RM 150.00 (1 money) — **DONE, same run**

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

## What section A, B and G actually did — 2026-09-08 16:00-16:40

The tool the remedy above asked for is
`backend/scripts/topup-ac-lines-from-truth.mjs` +
`.github/workflows/topup-ac-lines-from-truth.yml` (PR #3213, corrected by
#3220). Plan by default; apply armed by
`CONFIRM="I HAVE REVIEWED THE BOOK LINE TOP-UP PLAN"`, narrowed to the ten
documents that were read in the plan, and capped at 12 writes.

| run | at (Malaysia) | what |
| --- | --- | --- |
| `34204160822` | 16:07 | PLAN. 11 sales-order lines across 9 documents + 1 delivery-note line to write; 13 book rows REFUSED for stating no item code; 87 documents left whole as UNJUDGEABLE; `SO-013160`'s orphan DtlKey reported, not deleted. Nothing written. |
| `34204316650` | 16:15 | reconcile BEFORE — **36** |
| `34204421089` | 16:19 | APPLY. `APPLIED — 11 sales-order line(s) on 9 document(s); 1 delivery-order line(s) on 1 document(s).` |
| `34204590904` | 16:25 | reconcile AFTER — **23** |

Verified on a fresh connection inside the apply run:

```
VERIFIED ON A FRESH CONNECTION — 11 of 11 sales-order line(s) carry the book's item,
quantity and money, the ERP's own line invariant, a jsonb OBJECT (not a string) in
variants, and a header equal to the sum of its lines; 1 of 1 delivery-order line(s)
the same.
```

Zero `WRONG SHAPE` rows. All nine sales-order headers now equal the book to the
sen, and so does `HC-DO-001604` (RM 6,688.00).

### What moved on the reconcile

| axis | 16:15 | 16:25 |
| --- | --- | --- |
| SO line count | 11 | **2** — only `SO-011384` (F) and `SO-013160` (D) |
| SO document total | 5 | **2** — only `SO-012571` (E) and `SO-013160` (D) |
| SO AutoCount lines with no ERP line | 12 | **1** — only `SO-011384`'s code-less row |
| DO document total | 1 | **0** |
| DO lines paired | 818 | 819 |
| whole reconcile | **36** | **23** |

**CONTROL — PO, GR, IV and PI did not move.** PO `0 / 0 / 0 / 0 / 0`; GR
`0 / 0 / 0 / 0 / 9` with 100 ERP-RM0 and 2 same-goods; IV 4 absent, 4 same-goods,
9 same-money, 1 no-key-open; PI 1 line-count, 11 same-money, 6 no-key-open —
identical in both runs. SO's `item 1`, `qty 1` and `phantom 1` and DO's
`line count 2` are also identical: nothing outside this lane was touched.

### `HC-SO-012842` — the self-inconsistency named in section A, and what the re-sum did to it

Its header read RM 4,888.00 while its own six lines summed RM 4,588.00. The
header is DEFINED as the sum of its lines, so the re-sum CORRECTED that: adding
the book's RM 300.00 `Miscellaneous` line makes the lines sum RM 4,888.00 and the
header stays exactly where it was, now agreeing with itself, with the book, and
with `paid RM 4,588.00 + balance RM 300.00`. Nothing was papered over — the plan
printed the disagreement by name before the write.

This document is also why the first plan (`34201640955`) was thrown away and the
tool corrected: it predicted RM 5,188.00, because the plan added to the HEADER
while the apply sums the LINES. Ledger
`docs/bugs/0705-the-plan-predicted-a-header-the-apply-would-not-write-on-the.md`.

### Three documents now owe RM 150.00 more than they are recorded as paying

`paid_sen` and the header `balance_sen` were NOT touched anywhere in this lane.
The three documents that gained a PRICED line therefore read:

| document | total now | paid + balance | short by |
| --- | --- | --- | --- |
| `HC-SO-010789` | RM 7,650.00 | RM 7,500.00 | RM 150.00 |
| `HC-SO-003945` | RM 3,350.00 | RM 3,200.00 | RM 150.00 |
| `HC-SO-008319` | RM 6,250.00 | RM 6,100.00 | RM 150.00 |

That is the truth of the business, not a defect: the customer was billed a
storage or cancellation charge the ERP did not carry, so the balance owing is
RM 150.00 higher. Whether the balance column is re-derived is the owner's call,
the same call still open on `HC-SO-000021` below.

### Readiness DID move, by exactly the demand that was added

Go-live readiness, `34199484225` (15:31) against `34204688974` (16:28):

| | before | after |
| --- | --- | --- |
| live orders / with a processing date / header READY_TO_SHIP | 2794 / 584 / 220 | 2794 / 584 / 220 |
| lines on PROCESSED orders | `READY=1725, PENDING=1368, PARTIAL=10` | `READY=1725, PENDING=1377, PARTIAL=10` |
| PROCESSED lines whose PO is received but the line is not READY | 36 | 36 |

**+9 PENDING, and nothing else.** Nine of the eleven new lines sit on orders that
carry a processing date; they are demand nobody has allocated stock to, which is
what a line the ERP has never seen before should look like. No line gained or
lost READY. A sales-order line is DEMAND, so
`recompute-so-allocation.mjs` should be run to give the new lines a stock
verdict — **UNTESTED: that has not been run, and it will move this table again.**

### Stock did not move at all

| check | before | after |
| --- | --- | --- |
| `check-stock-vs-autocount` | `cells compared: 996 \| AGREE: 962 \| DISAGREE: 0 \| AutoCount-only: 0 \| ERP-only: 3` | identical |
| whole sofas | `AutoCount 107 vs ERP 107 (net +0)` | identical |
| migrated documents that wrote a movement | 0 / 0 / 0 | identical |
| `check-migrated-cancel-exposure` | `0 movement rows behind 646 migrated documents` | identical |

Runs `34199542895` / `34199602289` before, `34204767930` / `34204854334` after.

**One thing the owner must see about `HC-SO-000021`.** Its total is now
RM 9,876.00 and `paid_sen` still reads RM 10,852.00 with a zero balance, so the
order looks RM 976.00 overpaid. That paid figure was never a recorded payment:
`import-ac-outstanding-so.mjs:328` computes `paid = total - UDF_BALANCE`, and the
book states `UDF_BALANCE = 0` with **no payment amount at all**. Re-deriving
`paid_sen` from the corrected total is the same formula on the same inputs — but
it is a payment column, so it is his call and it is not done.

## What section F did — 2026-09-08 17:53-18:10, and the controls

| run | at (Malaysia) | what |
| --- | --- | --- |
| `34212460613` | 17:53 | `probe-cutover-so-do-lines` — the ERP side read line by line. `HC-DO-001953` 2 rows, both KEYED; `HC-DO-004903` 1 row, KEYED. The missing lines are missing, not a pairing guess |
| `34213215063` | 17:59 | the same probe over all **30** book offenders — the ERP holds 4, does not hold 26 |
| `34212496647` | 17:54 | reconcile BEFORE — **21** |
| `34213468651` | 18:04 | PLAN, `lanes=do`. 4 delivery-order lines to write; `HC-DO-001604` refused as already done |
| `34213756311` | 18:08 | APPLY, `only_docs=DO-001953,DO-004903 max_writes=4`. `APPLIED — 4 delivery-order line(s)` |
| `34213899437` | 18:10 | reconcile AFTER — **19** |
| `34213902675` | 18:10 | the probe again: `HC-DO-001953` book 4 / ERP 4, `HC-DO-004903` book 3 / ERP 3, every book key claimed |

Verified inside the apply, on a fresh connection: *"4 of 4 delivery-order
line(s)"*, zero `WRONG SHAPE` rows. The check now asserts the shape this class is
DEFINED by as well — `ac_substituted` true and `so_item_id` **not** set.

### What moved, and the control

| axis | 17:54 | 18:10 |
| --- | ---: | ---: |
| **DO line count** | **2** | **0** |
| DO — every other column (item, qty, price, money) | 0 | 0 |
| DO lines paired | 819 | 823 |
| SO (**CONTROL** — another lane's) | lineCnt 2, money 2, phantom 1 | identical |
| PO (**CONTROL**) | 0 | identical |
| GR (**CONTROL**) | money 9 | identical |
| PI (**CONTROL**) | lineCnt 1 | identical |
| IV (**CONTROL**) | absent 4 | identical |
| whole reconcile | **21** | **19** |

### Stock did not move — and that is the risk this repair carried

Changing what a delivery note says went out changes WHICH product left the
warehouse, so this is the control that mattered. Runs `34213598089` /
`34213602189` before, `34213893128` / `34213896315` after:

| check | before | after |
| --- | --- | --- |
| `check-stock-vs-autocount` | `cells compared: 996 \| AGREE: 950 \| DISAGREE: 12 \| AutoCount-only: 0 \| ERP-only: 3` | **identical** |
| whole sofas | `AutoCount 107 vs ERP 107 (net +0)` | **identical** |
| sofa cells | `41 compared \| AGREE 19 \| DISAGREE 22` | **identical** |
| movement rows behind migrated documents | `0 behind 646 (473 receipts + 173 delivery orders)` | **identical** |

A migrated delivery order is `migrated_no_stock` and the FIFO trigger is
`AFTER INSERT ON inventory_movements`, so an INSERT into
`scm.delivery_order_items` writes none. That is the reasoning; the table is the
observation.

### The invoice DID follow — and only ONE of the four absent invoices is this chain

The GR/IV/PI lane wrote *"a short delivery order silently becomes a missing
invoice"*. True, and measured rather than assumed: `create-migrated-invoices`
DRY-RUN run `34213920643`, taken AFTER the repair, on production:

```
WOULD CREATE HC-I-2411-0323 (AutoCount I-2411-0323) RM 0.00  2 line(s), 8 unit(s)  from HC-DO-001953
WOULD CREATE HC-I-2410-0192 (AutoCount I-2410-0192) RM 6688.00 4 line(s), 4 unit(s)  from HC-DO-001604
total_disagrees_with_autocount: 2
   HC-DO-000097 -> I-000213      ours RM 2499.00 vs AutoCount RM 2549.00
   HC-DO-003699 -> I-2411-0275   ours RM 0.00    vs AutoCount RM 6800.00
```

`I-2411-0323` read `nothing_to_invoice` before this repair — *"our delivery order
holds no line to bill"* — and now writes. **But the four absent invoices are not
one chain with these two delivery orders**: `I-2410-0192` is `HC-DO-001604`'s,
unblocked by section G's own repair at 16:19 and waiting on nothing but a
dispatch; `I-000213` and `I-2411-0275` are money gaps on documents this lane
never touched (`docs/bugs/0669` and `stamp-migrated-source-prices.mjs`).

**NOT APPLIED here, deliberately.** `create-migrated-invoices.mjs` takes no
per-document narrowing, so one apply writes BOTH — and `HC-I-2410-0192` carries
RM 6,688.00 on another lane's document. One dispatch of *Migrated invoices*
(`mode=apply kind=si target=prod`, confirm `I HAVE REVIEWED THE DRY-RUN`) takes
IV absent **4 → 2** and the reconcile **19 → 17**. **UNTESTED as applied: the
dry-run above is the evidence, and the write has not been run.**

`DO-004903`'s own invoice needs nothing: `I-2506-0074` is already in the ERP and
the reconcile classifies it `same-money` — its total equals the book and the two
book lines it lacks are RM 0.00.

### The class reads ZERO on its own instrument

`Probe DO item codes changed after conversion (read-only)` shipped with #3244 and
was dispatched on `main` after the merge — run `34216439995`:

```
THE CLASS: 34 delivery line(s) on 30 delivery order(s)
OF THE 30 ... the ERP HOLDS 4 and does not hold 26
Of the 4 it holds: 4 already carry every flagged line; 0 are SHORT, 0 line(s)
```

### What this RULED OUT — the checker itself moved between the two reconcile runs

Both reconcile runs were dispatched on `main`, and **#3239 merged at 10:01:25Z,
between the BEFORE (09:54Z) and the AFTER (10:10Z)**, so the AFTER run read a
checker that was not byte-identical to the BEFORE one. (#3238, which changes what
the reconcile PRINTS, merged at 10:34:55Z — after both.) That contaminant is
refuted by the control rather than by argument: SO, PO, GR, IV and PI are
identical on every axis across the two runs, and the only movement is DO's line
count 2 -> 0 with lines paired 819 -> 823 — **+4, exactly the four rows written.**
A moved checker does not land on one type's one column at exactly the write's own
size.

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

---

# The lines the IMPORT dropped — measured 2026-09-08 18:15, and nothing was written

The sections above are about book lines the ERP does not hold on documents it
does. This one is about the lines the cutover import itself let go, which no
reconcile axis reports at all: a document the ERP holds correctly is not on any
list, whatever the import decided along the way.

**The owner was asked about them as a number and answered 「这些都要」.** The
number is `import-ac-outstanding-so.mjs`'s own `Blank zero-value lines dropped:
17`, and it is the only trace the run leaves. Put in front of the live database
it turns out not to be seventeen and not to be one thing.

Measured: probe run `34214774396`
(`probe-dropped-book-lines.yml`, read-only, 2026-09-08 10:18 UTC = **18:18
Malaysia**), plus run `34211433089` (`probe-cutover-so-do-lines`) for the
document-by-document read.

## Two of the seventeen were never dropped, and writing them would have doubled the goods

The importer resolves a code-less line's free text against the **live** pick list
BEFORE the owner's rule can see it. So `code-less AND zero-priced` — all the
committed export can tell you — is the CANDIDATE set, not the dropped set:

```
of the 17 zero-priced code-less line(s), the resolver answers 2 TODAY
  SO-000015 dtl 123388 "AKEMI BASTION MATTRESS (153x190x25CM)" -> AKEMI BASTION MATT (SP)
  SO-000015 dtl 123389 "NK-JAGER B/FRAME(Q) (152x190CM)"       -> JAGER-(Q)
```

`HC-SO-000015` (customer `CUSTOMER`, 2024-07-31, CONFIRMED) holds all three of
its book lines — `AKEMI FORTRESS MATT (K)` RM 9,099.00, `AKEMI BASTION MATT (SP)`
RM 0.00, `JAGER-(Q)` RM 0.00 — header RM 9,099.00, lines summing RM 9,099.00,
equal to the book to the sen, and its `mfg_so_audit_log` is EMPTY. The import
wrote them itself.

**Why it looked missing:** none of its rows carries an AutoCount line key, so the
reconcile calls the document UNJUDGEABLE. That is not a hand edit —
`backfill-ac-line-keys.mjs` buckets by the TRANSLATED item code, and a code-less
book line has no mapping row, so the ERP row minted for it can never be keyed.
Eight sales orders are in that state and every keyless row on the five that were
read corresponds to a code-less book line
(`docs/bugs/0712-a-code-less-book-line-can-never-be-keyed-so-the-eight-unjudg.md`).

## What was really dropped: 15, and 3 of them are somebody's

| n | what | who owns it |
| --- | --- | --- |
| 12 | the book states nothing at all and quantity is 0 | nobody — `lib/ac-blank-book-row.mjs` already rules this the two sides agreeing |
| 2 | a build INSTRUCTION on a line of its own | the FIELD it belongs on, not a product line |
| 1 | the book states nothing and ORDERS FOUR | **the owner** |

### `HC-SO-000102` — `COLOUR : 885-4` is nowhere on the document, and the library does not have the colour

Searched over every line's `description2`, `remark`, `variants` and
`custom_specials` and the header's remark fields, punctuation removed from both
sides: **not found**. And `scm.fabric_colours` holds **0** rows whose colour code
is `885-4`, so there is no colour field it could be written to even by decision.
The order is CONFIRMED, RM 2,549.00 fully paid, and its `CROWN (SS+S)` bedframe
was delivered on `DO-000097` in 2023. The same instruction is a line of that
delivery note too, and equally absent.

**Not a line to add.** A colour is a variant of the bedframe line; minting a
product for it would invent goods. It needs a fabric-library row first, and then
it is a variant write — the lane `repair-so-variant-from-book.mjs` owns.

### `HC-SO-000814` — `LEG: FOLLOW DISPLAY` is nowhere on the document

Same search, same answer. The sofa's own build text IS carried on all three
compartments (`[ (1 ELT / T + NA +2ER) (28") / COL: J9883-1-1 PAMA]`, on
`description2` and on `remark`); the leg instruction was a separate book line and
did not come. The order is `IN_PRODUCTION` with a processing date of 2024-05-07,
and the book already shows the sofa transferred to `DO-000542` — so the sofa is
built and this is a record, not a live build instruction.

### `HC-SO-011384` — the row that orders four of nothing

Already section F above, and re-confirmed here from the import side: dtl 783795,
quantity 4, no item code, no description, no Desc2, no money, on Ramachandran's
RM 17,888.00 roadshow order for `PENANG WATERFRONT CONVENTION CENTRE`. Every
other line on that order is quantity 2. **Nothing in the book names it** and
inventing a product is forbidden — the original order slip is the only source.

## And the other document types, which the owner asked about (「其他order也是这样？」)

| type | code-less lines in the cut the importer read | what happened |
| --- | --- | --- |
| sales orders (14,041 lines) | 22 | 2 resolved as goods, 1 resolved as a mattress, 1 became a charge by delivery wording, 3 became charges by the owner's rule, 15 dropped |
| purchase orders (501 lines) | 1 | `PO-009979` `ERGOTEX PILLOW CASE - FAIR` **x20 at RM 50.00 = RM 1,000.00**. The purchase importer does not drop — it records an exception, because `scm.purchase_order_items.item_code` is NOT NULL. It is that document's ONLY line, so **the whole purchase order is absent from the ERP** (`PO-009979 -> (NOT IN THE ERP)`, run `34211433089`). Owner 2026-09-02 already ruled 「要进 accessories」; it needs the product minted before the column will take the line |
| delivery orders (369 lines) | 3 | `DO-000097`'s `COLOUR : 885-4`, `DO-001604`'s empty row, and `DO-001604`'s `* DISPOSE …` at RM 150.00 — the last already written by `topup-ac-lines-from-truth` (run `34204421089`, section G above) |

## Nothing was written, and here is the reading that says so

| check | run | reading |
| --- | --- | --- |
| reconcile | `34211712847`, 09:44 UTC | **21** disagreements. CONTROL: PO `0 / 0 / 0 / 0 / 0`; GR `0 / 0 / 0 / 0 / 9` with 100 ERP-RM0 and 2 same-goods; IV 4 absent, 4 same-goods, 9 same-money, 1 no-key-open; PI 1 line-count, 11 same-money, 6 no-key-open — identical to the 16:25 baseline above |
| movements behind the affected documents | `34214774396`, section G | `HC-DO-000097` 0, `HC-DO-000542` 0, both `migrated_no_stock = true` |

**There is no "after".** No quantity, price, item code, status, variant or
payment column was written by this lane on any document, so readiness and stock
cannot have moved and the reconcile reading above is the current state, not a
before.
