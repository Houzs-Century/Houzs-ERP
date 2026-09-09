# The seven documents the alignment lane is closing — state, 2026-09-09

One page so the next person does not re-derive any of this. Every fact below
either cites the run that produced it or is labelled UNKNOWN.

## What each document needs, and who owns it

| document | what the book has that we do not | the writer that does it | state |
| --- | --- | --- | --- |
| `HC-DO-011465` | a second line: `HOK-SQUARE PILLOW` x4 @ RM 0.00, Desc2 *"for conpesantion wrong item delivery."* | `topup-ac-lines-from-truth.mjs` DO lane, target `DO-011465/924550` | **BUILT** (PR #3419); apply pending |
| `HC-DO-010332` | a second line: `DSL-8050 SOFA` x1 @ RM 0.00, Desc2 `BO315-11 metal/75cm/1S` | NOT a top-up - see below | OPEN, blocked on a seat size |
| `HC-DO-010332` | our EXISTING row carries the OTHER line's build text (`1S` where its own book line says `2S`) | none yet — see *What is not built* | OPEN |
| `HC-I-2606-0047` | the same two things one document down: the missing RM 0.00 invoice line, and the build text on the existing one | none yet — no invoice-line INSERT lane exists | OPEN |
| `HC-DO-010104` | the option CODE `Nylon Fabric` in `variants.specials` (the line carries the words, not the code) | none yet | OPEN |
| `HC-DO-011371` | same | none yet | OPEN |
| `HC-I-2605-0294` | same | none yet | OPEN |
| `HC-I-2506-0056` | colour `NV-1WP` on the invoice line | none yet — no colour repair exists for invoice lines | OPEN |

Deliberately NOT in this lane: `HC-DO-011470` (the sofa lane's) and
`HC-SO-2609-002` (ruled left alone — two genuinely different products, the
book's line is our own write-back, money nil both sides).

## What the book actually says — read from the committed snapshot

`backend/scripts/data/ac-reconcile-truth.json.gz`, exported
`2026-09-09T00:18:49.235Z`. These are copies, not summaries.

```
DO-010104  818716  DSL-9058 SOFA      x1 @ 4990.00 = 4990.00
                   Desc2: 1+1NA+C+1(30'Inch)/Col:HR805-90/Bckrsrt at Crnr cmprtmnt32'Inch/Bttm upgrade to umbrella fabric
           818718  AMN-SOFA PILLOW    x4 @    0.00
DO-011371  909888  DSL-8030 SOFA      x1 @ 4990.00 = 4990.00
                   Desc2: L2 (28") / COL: HR805-90 / BOTTOM USE UMBRELLA FABRIC
DO-011465  924547  HOK-5530 SOFA      x1 @ 3300.00 = 3300.00
           924550  HOK-SQUARE PILLOW  x4 @    0.00   Desc2: for conpesantion wrong item delivery.
DO-010332  836939  DSL-8050 SOFA      x2 @ 3250.00 = 6500.00   Desc2: BO315-11 metal/75cm/2S
           836941  DSL-8050 SOFA      x1 @    0.00 =    0.00   Desc2: BO315-11 metal/75cm/1S
I-2605-0294 856708 DSL-9058 SOFA      x1 @ 4990.00   (same Desc2 as DO-010104)
I-2606-0047 847331 DSL-8050 SOFA      x2 @ 3250.00   Desc2: BO315-11 metal/75cm/2S
            847333 DSL-8050 SOFA      x1 @    0.00   Desc2: BO315-11 metal/75cm/1S
I-2506-0056 463392 NK-1045 (K)        x1 @    0.00
                   Desc2: mattress gap:12"/divan:8"+no leg/colour:NV-1WP
```

## What is NOT built, and the one thing that blocks each

**The `Nylon Fabric` write is blocked on an OBSERVATION, not on a decision.**
The owner has already ruled: 「nylon fabric是special order啊」 — write it. The
code is not typed by anyone either; `scripts/lib/sofa-special-map.mjs` DERIVES
it from the book's own words, verified locally:

```
"…/Bttm upgrade to umbrella fabric"        -> ["Nylon Fabric"]
"L2 (28") / COL: HR805-90 / BOTTOM USE UMBRELLA FABRIC" -> ["Nylon Fabric"]
"BO315-11 metal/75cm/2S"                   -> []          (correctly nothing)
```

What is missing is WHICH ROW. A sofa is ONE line in the book and SEVERAL rows in
the ERP — one per compartment — and the reconcile names a different compartment
for each of the three findings (`9058-1NA`, `8030-2A(RHF)`, `9058-1A(LHF)`).
Whether the option belongs on the lead row, on every compartment row, or on the
one the reconcile names is a decision the book does not record, and writing it
onto the wrong row is the mistake `docs/bugs/0709` and `0712` are about.
`probe-doc-alignment` (merged in #3416) prints those rows; **read its output
before choosing.** Do not resolve it by item code or by position — that has
already written wrong links twice (`GR-004940`, `GR-005334`).

It must go in **`variants.specials`**, not `variants.specialsRecorded`: the
latter is the ruling-甲 recorder for PRICED options
(`record-priced-specials-on-migrated-lines.mjs`) and `Nylon Fabric` is unpriced.
And **never `custom_specials`** — it is derived and self-erasing.

**The invoice line insert** (`I-2606-0047/847333`) needs a new IV lane in
`topup-ac-lines-from-truth.mjs`. The DO lane is the template, one hop down:
`scm.sales_invoice_items` (FK `sales_invoice_id`, link to the note `do_item_id`),
header `scm.sales_invoices` carrying `line_count` / `total_sen` /
`local_total_sen`. `create-migrated-invoices.mjs:358` has the column list.

**The invoice colour** (`I-2506-0056`, `NV-1WP`) should NOT be parsed out of
Desc2. `repair-migrated-do-line-colour.mjs` copies a delivery line's colour from
its SALES ORDER line, merging the key the parent used rather than choosing one;
the same shape one hop down is: copy from the DELIVERY ORDER line the invoice
line was built from, which `do_item_id` already names. Blank-only, never
overwrite.

**The build-text swap** on `HC-DO-010332` / `HC-I-2606-0047` is a
`description2` UPDATE on an existing row, and the value is a straight copy of
that line's own book Desc2. The row is identifiable by price (RM 6,500 against
RM 0.00), so it does not need the sofa lane. It is small; it simply was not
reached.

## The rules that govern all of it

- 「一律跟账本」 / 「autocount怎么写我们就怎么写」 — copy the book's own LINE
  value even where the cause is unknown.
- 「库存先不看」 — if a write would move an on-hand figure, STOP and name it.
  `probe-doc-alignment` re-measures `inventory_movements` per document in one
  read-only snapshot; run it immediately before any apply rather than quoting an
  earlier run.
- 「写回autocount的你不需要理了」 — nothing goes INTO AutoCount. Reading it is
  encouraged.
- Money: none of these seven lines is priced except the two that already exist,
  and no header total moves.

---

## MEASURED 2026-09-09 — what production actually holds

`probe-doc-alignment` run 34328818076, one read-only snapshot at
`2026-09-09T08:23:41.238Z`. Re-run it before any apply rather than quoting this.

**Stock: every delivery note in this lane reads ZERO movements.**
`HC-DO-010104`, `HC-DO-010332`, `HC-DO-011371`, `HC-DO-011465` — all
`STOCK MOVEMENTS: 0`. Writing on them moves no on-hand figure. (Sales invoices
write no movement at all; stock leaves on the delivery note.)

### The `Nylon Fabric` blocker is GONE — the rows answer it themselves

The worry was "a sofa is one book line and several ERP rows, so which
compartment carries the option?". The rows settle it: every compartment row of
one book line shares the SAME `linked_ac_dtlkey` and an IDENTICAL `variants`
object. `HC-DO-010104` has four rows, all keyed `818716`, all carrying

```
specials: ["Bttm upgrade to umbrella fabric"]
```

So the write is a union-add of `Nylon Fabric` into `variants.specials` on
**every row carrying that DtlKey** — there is no compartment to choose, and
after the write every row of the line still holds an identical object. Same
shape on `HC-DO-011371` (2 rows, key `909888`, `specials:
["BOTTOM USE UMBRELLA FABRIC"]`) and `HC-I-2605-0294` (5 rows, key `856708`).

The CODE is not typed by anyone: `scripts/lib/sofa-special-map.mjs` derives it
from the book's own words. Verified locally against those exact two texts, both
answer `["Nylon Fabric"]`, and `"BO315-11 metal/75cm/2S"` correctly answers `[]`.

`custom_specials` is `null` on every one of these rows — leave it that way, it
is derived and self-erasing.

### `HC-I-2506-0056` — the colour has a parent to copy from

The invoice line carries `do_item_id`, and its `variants` holds every bedframe
axis EXCEPT the colour:

```
{"gap":"12\"","colourId":null,"fabricId":null,"specials":[],"legHeight":"0\"",
 "fabricCode":null,"colourLabel":null,"divanHeight":"8\"","fabricLabel":null,
 "totalHeight":"20\""}
```

So this is `repair-migrated-do-line-colour.mjs` one hop further down: copy the
colour keys from the row `do_item_id` names, blank-only, never overwrite, and
never parse them out of Desc2. Which key to write is not a choice — copy the
ones the parent uses (`colourId` / `fabricId` / `fabricCode` / `colourLabel` /
`fabricLabel`).

### `HC-DO-010332` — NOT a missing line. A seat size

```
HC-DO-010332  1 line
  item 8050-1S  qty 2 @ RM 3,250   ac_dtlkey 836939
  description2 "BO315-11 metal/75cm/1S"
```

The row is keyed to the book's **2S** line and carries the **1S** line's build
text and item code. Adding the free 1S line on its own would leave two rows both
claiming 1S, one priced at the other's money. The existing row must become the
2S line first — a seat size on a delivered document, which belongs to the sofa
tooling. `HC-I-2606-0047` is the same document one hop down and inherits the
same block.

**A target that satisfied every assertion the book could make was still wrong.**
It was in `DO_TARGETS` until this probe ran. `tests/doTopupTargets.test.mjs`
pins its absence.
