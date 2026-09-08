# The goods-receipt / invoice reconcile remainder — 2026-09-08 (Malaysia, UTC+8)

The sales-order and delivery-order half of the go-live remainder was written up
one row per document, with its cause, in
`docs/cutover-so-do-remainder-2026-09-08.md`, and then repaired. **This is the
same document for the other half** — the 18 differences on goods receipts, sales
invoices and purchase invoices that nobody had classified, which is why they had
been sitting.

Measured, not recalled. Four production runs, all on 2026-09-08:

| run | at (Malaysia) | what |
| --- | --- | --- |
| `34198407570` | 15:15 | the reconcile — `AutoCount vs ERP reconcile (read-only)` |
| `34198777922` | 15:19 | `probe-gr-pi-iv-residue.mjs` — the GR/PI/IV residue, re-run AFTER the line keys landed |
| `34199062827` | 15:23 | `create-migrated-invoices.mjs` DRY-RUN, `kind=si` — why each absent invoice is absent |
| `34199483652` | 15:28 | `backfill-ac-downstream-line-keys.mjs` DRY-RUN — which receipt lines the book can and cannot key |

The book is the committed snapshot `ac-reconcile-truth.json.gz`, exported
2026-09-08T00:03:44Z = **08:03 Malaysia**.

## The one fact that made this tractable, and it is hours old

`backfill-ac-downstream-line-keys.mjs` stamped AutoCount's own line key onto the
migrated downstream documents at **14:22** (run `34194376108`). Before that,
`scm.grn_items.linked_ac_dtlkey` was NULL on all 636 rows, so every goods-receipt
verdict rested on the checker pairing lines by value and position — a guess that
had already been wrong five times in two days.

Production now, from run `34199483652`: **563 of 636** goods-receipt lines carry
a key (371 of 400 documents fully keyed) and **795 of 831** delivery-order lines.
**0 stored keys DISAGREE with the derived one.** So a verdict recorded before
14:22 may simply no longer exist, and one that survives is much more likely to be
real. Every row below was re-measured after 15:15. None is inherited.

## What moved — measured, with the control

Reconcile **before** run `34198407570` (15:15), **after** run `34202350017`
(16:02). Nothing between them but the two writes named below.

| type | 15:15 | 16:02 | what closed it |
| --- | ---: | ---: | --- |
| GR item code | 2 | **0** | the checker's per-document key flag — `docs/bugs/0704`. Now printed as *"the CHECKER's own guess, not a wrong product"* |
| GR money | 9 | 9 | — |
| IV absent | 6 | **4** | `I-2410-0016` and `I-2507-0234` written, run `34202228734` |
| PI line count | 1 | 1 | — |
| **the 18** | **18** | **14** | |
| SO (**CONTROL** — another lane's) | 19 | **19** | untouched, as it must be |
| DO (**CONTROL**) | 3 | **3** | untouched |
| PO (**CONTROL**) | 0 | **0** | untouched |
| whole reconcile | 40 | **36** | |

**The stock control, and it is a SHAPE, not a row count.**
`probe-gr-iv-pi-remainder.mjs` before (run `34202080707`) and after (run
`34202524554`), on a fresh connection each time:

```
                                    before    after
movements_behind_migrated_grns           0        0
movements_behind_migrated_invoices       0        0
migrated_grns                          400      400
migrated_grns_not_flagged                0        0
migrated_gr_units                      957      957
migrated_gr_line_money            46078593 46078593
migrated_sales_invoices                 43       45   <- the two written
migrated_purchase_invoices              55       55
```

Nothing moved but the thing that was meant to. The apply verified itself on a
fresh connection too: *"VERIFY (fresh connection) scm.sales_invoices: read back
2/2 — all 2 created invoice(s) are migrated_no_stock, AutoCount-linked, and carry
no journal entry."*

## Where the 18 stand

| | count | what it is |
| --- | ---: | --- |
| **identical to the book after this pass** | **2** | two sales invoices the book has and we did not — written |
| **PROVEN 一模一样, the difference was the checker's own guess** | **2** | the goods on `GR-005334|PO-009887` are the book's goods; only the row order is unknown |
| **a decision that is the owner's** | **6** | 5 receipts where a sofa's money must be placed on a compartment, 1 invoice line that can only be removed by DELETING it |
| **built, blocked on a delivery order** | **4** | four sales invoices that cannot be written until their delivery note carries the book's money |
| **money, traced, not yet repaired** | **4** | RM 2,119.50 we would overpay a supplier, plus one RM 55.00 short |
| **total** | **18** | of which **4 are closed** and **14 stand** |

The whole reconcile read **40** on run `34198407570`: SO 19, PO 0, GR 11, DO 3,
IV 6, PI 1. The 18 here are the GR 11 + IV 6 + PI 1. The other 22 belong to the
sales-order / delivery-order lane and are not touched by anything in this
document — the control row above is the proof that they are not.

---

## A — goods receipts, item code: 2. The checker counting its own guess

**PROVEN.** Both rows are on `GR-005334|PO-009887` and they are each other's:

```
DtlKey 917594: the book says AK-IMMORTAL MATT (K)   we answer AKEMI ULTIMATE MATT (K)
DtlKey 917604: the book says AK-ULTIMATE MATT (K)   we answer AKEMI IMMORTAL MATT (K)
```

Read as printed, that says a customer's receipt names the wrong mattress. Two
measurements say it does not:

* Run `34199483652` — the seven rows of that receipt carry **no** line key, and
  it names the reason it refused to give them one: *"AKEMI IMMORTAL MATT (K): the
  book has 2 lines of this item at this quantity and they are NOT identical (2
  distinct price/location/Desc2 combinations), so which is which is unknowable."*
  AutoCount cannot tell them apart either.
* Run `34198777922` — *"326 pairs where the book's item codes and ours are the
  SAME MULTISET ...; **0** where they genuinely DIFFER."*

So the receipt holds the book's goods in the book's quantities, and the only
unknown is which of our rows answers which of the book's. Under the owner's
standard that document IS 一模一样.

**Why it was counted anyway, and what changed.** `splitGuessedItemCodePairing`
moves exactly this row out of the difference column, and it asked the DOCUMENT
whether it had a line key rather than the LINE. That was right while a document
was all-keyed or all-keyless; the 14:22 backfill made **partially keyed** the
normal state (29 receipts are), so one keyed line beside these seven answered for
them. Fixed in this PR, pinned by three tests proved RED on the unfixed line —
`docs/bugs/0704-*.md`. **No production data is touched by that fix**; it changes
what the report says, not what the receipt holds.

## B — goods receipts, money: 9. Two different causes, and one of them is real money

The reconcile counts 109 receipts whose total is not the book's; **100** carry
RM 0.00 and are the owner's own accepted class (「GR 0 没关系」, proved per
document as `migrated_no_stock` with zero movements). The **9** that remain carry
a non-zero figure that is not the book's, and they split cleanly:

### B1 — four receipts whose money is simply wrong (RM 2,119.50 of it against us)

**PROVEN**, run `34198777922`, all four fully priced:

| receipt x purchase order | the book | ours | difference |
| --- | ---: | ---: | ---: |
| `GR-005363|PO-010019` | RM 3,525.00 | RM 4,700.00 | **+RM 1,175.00** |
| `GR-005367|PO-009982` | RM 1,575.00 | RM 2,100.00 | **+RM 525.00** |
| `GR-005368|PO-009887` | RM 1,258.50 | RM 1,678.00 | **+RM 419.50** |
| `GR-005326|PO-009953` | RM 1,055.00 | RM 1,000.00 | -RM 55.00 |

The first three are ours = the book x 4/3 to the sen, and the cause is no longer
inferred from the ratio — run `34202080707` reads the discount off the book
itself, per purchase order:

```
GR-005363|PO-010019   PO book gross RM  9,008.00 vs net RM  6,756.00   discount RM 2,252.00
GR-005367|PO-009982   PO book gross RM  9,180.00 vs net RM  6,885.00   discount RM 2,295.00
GR-005368|PO-009887   PO book gross RM 17,335.00 vs net RM 13,001.25   discount RM 4,333.75
```

The book took **25% off** and we did not: AutoCount keeps the unit price and the
discounted line amount in two columns, every purchase-order importer here
multiplies the undiscounted one, and the receipt copies the order's line price by
design. That is `docs/bugs/0662`, and `repair-po-line-discount.mjs` repairs the
ORDER — its own header says receipts already raised are "not this script's
business". These were raised before. **RM 2,119.50 more than the supplier billed,
on paperwork a purchase invoice is raised from.** Ledger: `docs/bugs/0705-*.md`.

**Not repaired in this pass, and the blocker is measured rather than assumed.**
Run `34199483652` refuses to key three of the four, because the book itself holds
two lines of one item at one quantity with different price/location/Desc2 —
`AKEMI BASTION MATT (Q)` x2 on `GR-005363`, `AKEMI NOBILITY MATT (Q)` x2 on
`GR-005367`, `HAPPI SLEEP SOLITUDE MATT (Q)` x2 on `GR-005368`. The DOCUMENT
total is decidable from the book; which of our two rows carries which of the
book's two prices is not, and putting money on the wrong line is the failure the
owner's 「每个 line 都是要一样的」 forbids. `GR-005326|PO-009953` is fully keyed
and is decidable line by line; its -RM 55.00 is **UNKNOWN** — both its lines are
priced, there is no sofa on it and the book states no line discount on its
purchase order (run `34202080707`), so none of the three known causes explains
it.

### B2 — five receipts where a sofa's money was dropped. THE OWNER'S CALL

**PROVEN** these are the other five, by partition: the probe compares every
non-sofa pair and found four; the reconcile counts nine; these five are the ones
it printed with a non-zero ERP total and the probe did not, i.e. the sofa pairs
it excludes by design.

| receipt x purchase order | the book | ours |
| --- | ---: | ---: |
| `GR-004909|PO-009017` | RM 3,200.00 | RM 120.00 |
| `GR-005171|PO-009344` | RM 2,330.00 | RM 80.00 |
| `GR-005169|PO-009475` | RM 2,230.00 | RM 60.00 |
| `GR-005151|PO-009415` | RM 2,290.00 | RM 90.00 |
| `GR-005303|PO-009676` | RM 3,150.00 | RM 200.00 |

**PROVEN**, run `34202080707` — every one of the five is `sofa on this pair: YES`
and carries **1 or 2 priced lines out of 3 to 6**, and the purchase order behind
it states **no line discount at all**. So this is not the discount class: each is
a receipt that mixes a sofa with an accessory, the sofa's compartment
purchase-order line carries the book's unpriced `PODTL.UnitPrice` of 0, the
sofa's money vanishes and the accessory beside it keeps its own.
`GR-004909|PO-009017` is RM 3,080.00 of sofa plus RM 120.00 of pillow, and we
kept the pillow.

**This is his, and it is the one thing the brief says stops.** Writing the book's
figure means deciding **which compartment carries the money** — the book states
one price for a sofa and we hold one row per compartment. That is a sofa
compartment decision, not a copy, and it is the single class the owner said needs
him. 「GR 0 没关系」 does not settle it either: it says a migrated receipt may
carry NO money, and RM 120.00 against RM 3,200.00 is not no money.

## C — sales invoices, absent: 6. Two are now written; four are blocked, and not by us

The owner overturned the historical-invoice exclusion on 2026-09-07 —
「没有的 SO DO 何来发票？有的 SO DO 自然要发票」 — so these six are gaps by his own
words. `create-migrated-invoices.mjs` DRY-RUN, run `34199062827`, names each one:

| invoice | the book | its source | verdict |
| --- | ---: | --- | --- |
| `I-2410-0016` | RM 0.00 | `HC-DO-001800` | **WRITTEN** — run `34202228734`; AutoCount billed RM 0.00 on it too |
| `I-2507-0234` | RM 0.00 | `HC-DO-005583` | **WRITTEN** — same |
| `I-2411-0323` | RM 0.00 | `HC-DO-001953` | `nothing_to_invoice` — our delivery order holds no line to bill |
| `I-2410-0192` | RM 6,688.00 | `HC-DO-001604` | `total_disagrees_with_autocount` — ours RM 6,538.00, short the book's RM 150.00 `* DISPOSE` line |
| `I-000213` | RM 2,549.00 | `HC-DO-000097` | `total_disagrees_with_autocount` — ours RM 2,499.00, short RM 50.00 |
| `I-2411-0275` | RM 6,800.00 | `HC-DO-003699` (+2 the ERP does not hold) | `total_disagrees_with_autocount` — ours RM 0.00; a price the cutover dropped |

The gate is `src/scm/lib/migrated-chain.ts` rule 4: an invoice is written only
when its total equals AutoCount's to the sen. **A short delivery order therefore
becomes a missing invoice, silently** — which is why four of these are not
invoice problems at all.

* `DO-001604` and `DO-001953` are section F and G of
  `docs/cutover-so-do-remainder-2026-09-08.md` and belong to the delivery-order
  lane. **Repair those two delivery notes and `I-2410-0192` and `I-2411-0323`
  resolve themselves.** Nothing in this document touches them.
* `DO-000097`'s RM 50.00 does not surface on the reconcile at all — a migrated
  delivery order carries no money to compare — so it is only visible through this
  gate. `docs/bugs/0669`.
* `I-2411-0275` is the RM 0.00 case the dry-run itself calls *"writable once the
  AutoCount invoice price is stamped on the source lines"* —
  `stamp-migrated-source-prices.mjs`. **UNTESTED**: that script has not been run
  in this pass and the claim is the dry-run's, not a measured one.

The two `WRITTEN` rows are the whole of what this pass wrote — run
`34202228734`, `mode=apply kind=si target=prod`, confirm phrase `I HAVE REVIEWED
THE DRY-RUN` passed by the workflow to the script. They carry AutoCount's own
numbering, are flagged `migrated_no_stock`, post no journal entry and are never
enqueued to the write-back — the invoice each mirrors already exists in the
account book. Both are RM 0.00 in the book too, so **no money moved in either
system.**

## D — purchase invoice, line count: 1. A DELETION, so it stops here

`PI-007875` (ERP `HC-PI-007875`). The totals agree to the sen. The book bills two
lines; we hold three:

```
book:  CELENE 2.0 (A)(F)-(SS) x1 | TRION (A) (HB STR)-(K) x1
ours:  CELENE 2.0 (A)(F)-(Q) x1  | CELENE 2.0 (A)(F)-(SS) x1 | TRION (A) (HB STR)-(K) x1
```

The extra `CELENE 2.0 (A)(F)-(Q)` is qty 1 at RM 0.00 (run `34198777922`,
"money IDENTICAL"). A migrated purchase invoice draws its rows from OUR goods
receipt, so a RM 0.00 row riding along is the shape the migration produces.

**Removing it is a line DELETION on a live document, and this repo's rule is
never delete, only cancel.** Written up, not done. It costs no money either way.

---

## The instrument, and the mistake it made on its first run

`backend/scripts/probe-gr-iv-pi-remainder.mjs` + `Probe GR / IV / PI remainder
(read-only)`. It re-asks every difference WITH the line keys and prints the stock
control in the same run.

**Its first run, `34202080707`, printed six findings that were not findings** —
four goods receipts as "BAGS DIFFER" and two invoice rows as goods the book does
not have — and every one was a sofa DECOMPOSITION: the book holds `2379-1S`,
`9058-1S`, `8069-1S` as one line and we hold one row per compartment. The probe
compared the raw codes. That is the same shape as `docs/bugs/0694`, where a sofa
exclusion testing only `line_suffix` printed 40 decompositions as wrong products,
and it is recorded here rather than quietly deleted because the numbers from that
run are cited above.

Fixed by folding both sides through `lib/keyless-multiset.mjs`'s `comparisonKey`
— the SAME canonicalisation the reconcile's own keyless verdict uses, rather than
a second opinion — with one trap worth knowing: the fold reads the book's
UNTRANSLATED code, because the book names a sofa `AMN-SF2379 SOFA` and the
mapping sheet turns that into `2379-1S`, which contains no "SOFA" at all. Passing
the translated string turns the fold off on exactly the rows it exists for.

**Nothing in sections A to D depended on the six**: the item-code verdict comes
from `GR item code — 0 line(s) where the ERP row and the book line carry the SAME
AutoCount key and DIFFERENT products`, which is keyed and unaffected, and the
money and control sections do not use the bag at all.

## What this pass does NOT claim

* **The four B1 receipts are still wrong.** RM 2,119.50 is still on the wrong
  side of the ledger and the remedy is described, not run.
* **The 5 keyless / 3 ambiguous purchase-invoice rows the reconcile reports under
  `no-key-open`** are outside the 40 and outside this document. Run
  `34198407570` prints them: `PI-001531` (`SOFA 5527`: book RM 2,867.43 vs ours
  RM 3,373.45), `PI-007918` (book `SOFA 8030`, ours `SOFA 9058`), `PI-007875`,
  and three sofa builds it calls AMBIGUOUS. Every one is a sofa. They are
  recorded here so the next person does not rediscover them, and they are the
  owner's class.
* **`I-2410-0016` and `I-2507-0234` mirror an invoice AutoCount billed at
  RM 0.00.** Creating them changes no money in either system.
