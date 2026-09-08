## The delivery order's item code was changed after the conversion and the ERP dropped the line [medium]

<!-- area: Cutover + migrated data -->
<!-- status: fixed -->

**Symptom.** The go-live reconcile has reported the same two documents on the
delivery-order line-count axis since 2026-09-08 12:58, most recently run
[`34212496647`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34212496647)
(17:54 Malaysia), where they are 2 of the 21 remaining differences:

```
DO-001953: AutoCount 4 vs ERP 2 (ERP HC-DO-001953)
DO-004903: AutoCount 3 vs ERP 1 (ERP HC-DO-004903)
```

`docs/cutover-so-do-remainder-2026-09-08.md` section F classified them as
**the BOOK's own gap** — *"it ships `HB109M-CC` and `HB109NL`, and its own sales
order `SO-003186` contains neither"* — and parked them. **That classification is
wrong**, and it is wrong in the direction that matters: it says there is nothing
for us to do, when there are four lines of goods the customer received that our
delivery note does not name.

**Root cause (traced, not guessed).** Two separate faults, one in the book and
one in ours.

*1 — the book: the item code was changed on the delivery order AFTER it was
converted from the sales order.* AutoCount stamps a delivery line with the
document it came from and never with the LINE:

```
DO lines carrying FromDocDtlKey:  0 of 48,772
PO lines carrying FromSODtlKey:   10,792 of 18,890
```

The column exists and is populated on the purchase side, so its emptiness on the
delivery side is AutoCount's own DO conversion not recording which order line a
delivery line drew from. Nothing was watching the line, so nothing objected when
the code on it was edited.

**The test that proves the lines were CONVERTED and not typed fresh, and it is
the one that would have refuted this reading.** AutoCount increments
`TransferedQty` on the ORDER only when a line is converted. If these delivery
rows had been typed onto the note by hand, the order's transfer counters would
not account for them. Read out of the committed snapshot
`backend/scripts/data/ac-reconcile-truth.json.gz` (`exported_at
2026-09-08T00:03:44Z`):

| sales order | delivery orders converted from it | its total `TransferedQty` | those notes' total `Qty` |
| --- | --- | ---: | ---: |
| `SO-003186` | `DO-001953` only | 8 | **8** |
| `SO-006438` | `DO-004903` only | 3 | **3** |
| `SO-002281` | `DO-001800` only | 6 | **6** |
| `SO-007435` | `DO-005583` only | 2 | **2** |

Exactly one delivery order each, and every unit on it is accounted for by the
order's own transfer counter. The units came through the conversion; the code on
them did not survive it.

*2 — the goods are the SAME goods, and the codes say so.* Read the book's own
`LineDesc` (`data/ac-partial-dos.json.gz`, the cut the migrated-DO writer reads):

```
HB109NL    LATEX PILLOW
HB109M-CC  COOL SILK LATEX PILLOW COVER
```

and the two `SO-003186` lines that transferred are `NTYR-CS LTX PIL + CSC`
(latex pillow **+ cool-silk cover**) x4 and `AK- LTX CLS PIL` (latex classic
pillow) x4. The delivery note itemises the same pillows by their component
codes. `SO-006438` is the same shape: `NTYR-CS LTX PIL + CSC` x1 transferred and
the note carries one pillow and one cover, beside the `AK-CS AIRLOFT COMFY PIL`
that kept its own code.

**Which ordered line each delivered line answers is still not decidable, and
this entry does not decide it.** `{4,4}` answers `{4,4}` as a multiset and the
book cannot say which is which — the ruling in `docs/bugs/0706` on the identical
shape stands, and `so_item_id` stays NULL here for the same reason.

*3 — ours: the ERP dropped the changed lines, and the fix for that could never
reach these two documents.* Owner ruling 2026-09-07 (*"改我们的程式，允许换型号"*)
made `lib/migrated-do-writer.mjs` carry a line whose code the order does not hold
— the SUBSTITUTED shape in `docs/modules/delivery-order.md`. But its plan ends:

```js
const plan = [...byDo.values()].filter((d) => !done.has(d.doNo));   // :293
```

and `done` is *"every `linked_ac_docno` already in `scm.delivery_orders`"*
(`create-migrated-documents.mjs:226`). **A document the ERP already holds is
skipped WHOLE.** So the ruling could create a delivery note whose every line was
a substitution — which is exactly what `DO-001800` and `DO-005583` are, and they
came out complete — and could never add a line INSIDE a note imported by the
earlier writer. `DO-001953` and `DO-004903` each had a line the old writer COULD
match, so the document was created without the ones it could not.

**PROVEN on production**, `probe-cutover-so-do-lines` run
[`34212460613`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34212460613),
which also shows the two siblings for contrast:

```
DO-001953 -> HC-DO-001953: book 4 line(s), ERP 2 row(s) claiming 2 key(s)
   unclaimed key=234488 "HB109M-CC" qty=4  [CODED LINE]
   unclaimed key=234490 "HB109NL"   qty=4  [CODED LINE]
DO-004903 -> HC-DO-004903: book 3 line(s), ERP 1 row(s) claiming 1 key(s)
   unclaimed key=465251 "HB109NL"   qty=1  [CODED LINE]
   unclaimed key=465254 "HB109M-CC" qty=1  [CODED LINE]
DO-001800 -> HC-DO-001800  book 2 / ERP 2   both rows carry the book's code
DO-005583 -> HC-DO-005583  book 1 / ERP 1   the same
```

Both offenders are FULLY KEYED on the rows they do hold, so this is not the
checker guessing a pairing (`docs/bugs/0709`): the missing lines are missing.

**THE POPULATION, because the line-count axis cannot see this class.** These two
were found only because their line COUNT differs; a note whose code was swapped
without changing the count is invisible there. Swept over the whole book —
`backend/scripts/probe-do-code-changed-after-conversion.mjs`, added here:

```
THE CLASS: 34 delivery line(s) on 30 delivery order(s) carry a real item code
           that the sales order they were converted from does not contain
EXCLUDED:  58 annotation / free-text rows (the book states no ItemCode) — the
           docs/bugs/0695 class, counted so the exclusion is visible
```

and against production (`probe-cutover-so-do-lines` run
[`34213215063`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34213215063),
all 30 named): the ERP holds **4** of the 30 and does not hold **26** — the
outstanding rule working, their sales orders were fully delivered before the
cut. Of the 4: `DO-001800` and `DO-005583` are complete, and `DO-001953` and
`DO-004903` are the two here. **There is no third document. This PR closes the
class, not two instances of it.**

**Fix.** Four lines added to `DO_TARGETS` in
`backend/scripts/topup-ac-lines-from-truth.mjs`, in the SUBSTITUTED shape the
module guide declares — the book's code and quantity, `so_item_id` NULL,
`item_group` blank, `ac_substituted = true` so both surfaces badge the row, and
the book's own line key so the document stays fully keyed. Each target asserts
`hasCode`, quantity, unit price and line subtotal against the book before the
write and REFUSES rather than adjusting to fit. The fresh-connection
verification now asserts the SHAPE that defines this class as well: that
`ac_substituted` is true and that `so_item_id` is **not** set — a link written
here would be the `docs/bugs/0672` failure, whose whole point is that a key
without an identity puts a customer on a different product.

No money moves: every line is RM 0.00 and both notes read RM 0.00 on both sides
before and after. No stock moves: a migrated delivery order is `migrated_no_stock`
and the FIFO trigger is `AFTER INSERT ON inventory_movements`, so an INSERT into
`scm.delivery_order_items` writes none — asserted before and after rather than
argued.

**APPLIED to production**, run
[`34213756311`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34213756311)
(`only_docs=DO-001953,DO-004903 max_writes=4`, confirm phrase passed by the
workflow): `APPLIED — 4 delivery-order line(s)`, then *"VERIFIED ON A FRESH
CONNECTION — 4 of 4 delivery-order line(s)"* with zero `WRONG SHAPE` rows. PLAN
first, run
[`34213468651`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34213468651).

Re-read afterwards on a fresh connection (`probe-cutover-so-do-lines` run
[`34213902675`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34213902675)) —
the SHAPE, not a row count: `HC-DO-001953` book 4 / **ERP 4**, `HC-DO-004903`
book 3 / **ERP 3**, every book DtlKey claimed by an ERP row and every header
still RM 0.00.

| | 17:54 run [`34212496647`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34212496647) | 18:10 run [`34213899437`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34213899437) |
| --- | ---: | ---: |
| **DO line count** | **2** | **0** |
| DO item / qty / price / money | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| DO lines paired | 819 | 823 |
| SO / PO / GR / IV / PI (**CONTROL**) | 5 / 0 / 9 / 4 / 1 | **identical** |
| whole reconcile | **21** | **19** |

**STOCK — the risk this repair carried, measured either side.** Changing what a
delivery note says went out changes WHICH product left the warehouse. Runs
`34213598089` / `34213602189` before, `34213893128` / `34213896315` after:

| check | before | after |
| --- | --- | --- |
| `check-stock-vs-autocount` | `cells compared: 996 \| AGREE: 950 \| DISAGREE: 12 \| AutoCount-only: 0 \| ERP-only: 3` | **identical** |
| whole sofas | `AutoCount 107 vs ERP 107 (net +0)` | **identical** |
| sofa cells | `41 \| AGREE 19 \| DISAGREE 22` | **identical** |
| movement rows behind migrated documents | `0 behind 646` | **identical** |

**The invoice followed, and it is ONE of the four, not four.**
`create-migrated-invoices` DRY-RUN run
[`34213920643`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34213920643),
taken after the repair: `WOULD CREATE HC-I-2411-0323 ... from HC-DO-001953` —
it read `nothing_to_invoice` before. `I-2410-0192` is `HC-DO-001604`'s and was
unblocked by a different lane; `I-000213` and `I-2411-0275` are money gaps on
documents nobody has repaired. **UNTESTED: the invoice APPLY has not been run** —
that tool takes no per-document narrowing and one apply would also write
`HC-I-2410-0192`, RM 6,688.00 on another lane's document.

**Ref.** fix/do-swapped-codes, 2026-09-08.

Module guide: `docs/modules/delivery-order.md`, *"A delivery line can carry a
SUBSTITUTED item code"*.
