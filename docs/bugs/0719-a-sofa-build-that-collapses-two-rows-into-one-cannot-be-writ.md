## A sofa build that collapses two rows into one cannot be written while a purchase line is dedicated to the row it drops [medium]

<!-- status: fixed -->

<!-- area: AutoCount sync + write-back -->

**白话.** 老板看图后说 `HC-SO-011099` 那张沙发是「一张两人位」，不是「两张单人位」。
要改的话，两行要并成一行 —— 但被删掉的那一行，工厂那张采购单还指着它，所以系统不敢
删，整张单就改不了。**他的答案没有问题，是我们这边的做法卡住了。** 更要紧的是：如果
只改采购单那一半（那一半是改得动的），工厂看到的会变成两人位，客户那张还是两张单人位
—— 两张纸就对不上了。所以宁可先不动，等把「采购单指向哪一行」修好再一起改。

**Symptom.** The owner ruled `HC-SO-011099` is `2S`. The ERP holds
`1A(LHF)+1A(RHF)`. The apply run refuses it (dry-run `34220106079`):

```
HC-SO-011099: REFUSED — a surplus line is referenced downstream:
9028-1A(RHF): 1 PO line(s), 0 DO line(s)
```

**The dangerous half is the one that does NOT refuse.** The same run plans the
purchase order successfully:

```
HC-PO-009882  9028  1A(RHF)+1A(LHF)  ->  2S  @30"
```

So an unscoped apply would correct the factory's document and leave the
customer's document stating the old build — a chain disagreement created by the
repair itself.

**Root cause (traced).** The build goes from two rows to one on both sides.
`pairRowsToPieces` (`backend/scripts/lib/sofa-build-plan.mjs:239`) reuses one
leftover row for the target piece — *"Reuse a leftover row rather than
delete-and-insert: the id is what carries the dedication"* — and the second row
becomes surplus. The guard in `apply-sofa-compartment-corrections.mjs` then
refuses any surplus row that something downstream points at, which is correct
and is not the defect.

The defect is that **the two sides keep different rows.** Read off production
(probe `34220446190`, section B):

| side | rows, in the order the script pools them | row it keeps | row it drops |
| --- | --- | --- | --- |
| `HC-SO-011099` (by `line_no`) | `1A(LHF)`, `1A(RHF)` | `1A(LHF)` | `1A(RHF)` |
| `HC-PO-009882` (by `id`) | `1A(RHF)`, `1A(LHF)` | `1A(RHF)` | `1A(LHF)` |

The purchase order's surviving row carries `so_item_id` -> the sales order's
`1A(RHF)` row, which is exactly the row the sales order has to delete. So
**ordering does not rescue it**: run the purchase order first and its one
remaining line still points at the row the sales order must drop. A collapse
needs the dedication RE-POINTED onto the surviving row, and nothing does that.

**Fix — none yet; the ruling is parked, not lost.** The entry moved to `_held`
in `sofa-compartment-corrections-2026-08.json`, carrying his ruling verbatim and
this reason. `_held` is the file's own mechanism for a build whose answer is
known and whose write is blocked: `loadCorrections` keeps it in a separate list
that the apply script PRINTS on every run and never writes, so it cannot be
mistaken for done. Proven by the next run (`34221653216`), which printed
`HELD HC-SO-011099 / HC-PO-009882`.

It also keeps the reconcile honest: the new `RULED` verdict is fed only from
WRITTEN builds, so `HC-SO-011099` keeps reporting `DIFFER` — which is true. It
is the one of the three that is still work.

**What a fix must do.** Re-point `purchase_order_items.so_item_id` onto the
surviving sales-order row as part of the collapse, in the same transaction, and
refuse if the two sides do not end up one-to-one. It must not simply relax the
surplus guard: that guard is what stops a row being cut from under a document
that references it.

**Ref.** `fix/apply-sofa-rulings`, 2026-09-08. Dry-run `34220106079`; evidence
probe `34220446190`; held-and-printed `34221653216`.

### 2026-09-08 — the machinery this asked for now exists (NOT yet run against production)

"What a fix must do" above asked for the dedication to be dealt with as part of
the collapse. `apply-sofa-compartment-corrections.mjs` now does it, and it does
it by RELEASING rather than re-pointing:

```
release 1A(RHF) — HC-PO-009882 9028-1A(RHF) stops being dedicated to a row
        this collapse removes; the PO half of this entry deletes it
```

`so_item_id = NULL`, in the SAME transaction as the delete it exists for. Not
re-pointed onto the surviving row, and that is deliberate: the dedication is one
sales line to one purchase line, so a second purchase line aimed at the
surviving row would read as two incoming units of one ordered piece — the exact
reason an inserted PO line never copies `so_item_id` either. It also avoids the
trap re-pointing walks into, which is worth naming because it is not obvious:
the downstream carry sets `item_code` on every PO line dedicated to a corrected
SO row, so re-pointing would have made BOTH purchase rows `9028-2S`, and the PO
half of the same entry would then have read them as **two identical sofas**
(`splitBuildCopies`) and refused. Releasing leaves the released row on its old
code, which is exactly what makes it surplus and deletable.

**The guard was not relaxed.** Five conditions gate the release and every one is
a refusal that leaves the old behaviour in place:

1. sales-order side only — a GRN hanging off a purchase line is goods, not
   paperwork;
2. the build must collapse to exactly ONE piece, so "which surviving row did
   this purchase line mean" has one answer and needs no guess;
3. the dropped row must carry NO delivery-order line — something shipped against
   it, and 「已经出货了的就随便把」 says leave those alone;
4. every purchase line being released must itself be free of goods receipts, so
   the PO half can really delete it;
5. the entry must NAME the purchase order, or nothing would clean up the
   released line and we would trade a refusal for an unbound purchase line
   stating the old build.

`HC-SO-011099` moved out of `_held` in the same change, carrying his ruling and
this reason. **WRITTEN AND VERIFIED**, and the runs are below.

**Ref.** `fix/so-last-6-and-gr-transpose`, 2026-09-08.

### The runs, 2026-09-08 — both halves, in order

**Dry-run `34243523350`** planned it for the first time since the guard was
taught the release:

```
HC-SO-011099  9028  1A(LHF)+1A(RHF)  ->  2S  @30"   money total 288800, charged 288800
      change 1A(LHF) -> 2S
      release 1A(RHF) — HC-PO-009882 9028-1A(RHF) stops being dedicated to a row
              this collapse removes; the PO half of this entry deletes it
      remove 1A(RHF)
```

**Apply `34244691604` — the sales order:**

```
builds touched 1 (1 sofa) · lines updated 1 · added 0 · removed 1
downstream carried: PO lines 1 · GRN lines 0 · DO lines 0
purchase dedications RELEASED by a collapse: 1
VERIFY — re-reading 1 document(s) on a fresh connection
  OK  HC-SO-011099  2S  money 288800/288800
VERIFY OK — 1 document(s), piece multiset and both money columns
```

**Apply `34245244962` — the purchase order**, run second, scoped with `DOC=`:

```
HC-PO-009882  9028  1A(RHF)+2S  ->  2S  @30"   money total 0, charged 0
      remove 1A(LHF)
VERIFY — re-reading 1 document(s) on a fresh connection
  OK  HC-PO-009882  2S  money 0/0
```

Read the second run's opening state — `1A(RHF)+2S`, not `1A(RHF)+1A(LHF)`. That
is the sales order's downstream carry having already moved the SURVIVING
purchase line onto `2S` through the dedication it kept, leaving the RELEASED row
still on its old code and therefore surplus. That is the mechanism working end
to end, and it is why releasing beats re-pointing: had the dedication been
re-pointed, the carry would have moved BOTH purchase rows to `2S` and the PO
half would have read them as two identical sofas.

**Both documents now state the same build**, which was the whole point — writing
only the purchase half would have left the factory's paper saying `2S` while the
customer's still said `1A(LHF)+1A(RHF)`. Money did not move on either side, and
the sales-order tally (`34254400214`) no longer lists `HC-SO-011099` on any axis.
