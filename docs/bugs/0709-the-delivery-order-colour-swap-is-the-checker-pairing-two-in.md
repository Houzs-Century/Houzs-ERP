## The delivery-order colour swap is the checker pairing two indistinguishable rows by position [high]

<!-- area: AutoCount sync + write-back -->
<!-- status: fixed -->

**Symptom.** The AutoCount reconcile has printed the same four fabric colours as
an exact swap on every run for two days, most recently
[`34206269750`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34206269750)
(2026-09-08 16:45 +08):

```
DO-011496 DtlKey 919934 (ERP HC-DO-011496 TRION (A) (HB STR)-(K)): book "PC151-02" vs ERP "PC151-03"
DO-011496 DtlKey 919942 (ERP HC-DO-011496 TRION (A) (HB STR)-(K)): book "PC151-03" vs ERP "PC151-02"
DO-010128 DtlKey 822696 (ERP HC-DO-010128 FENRIR-(SS)):            book "PC151-08" vs ERP "PC151-06"
DO-010128 DtlKey 822698 (ERP HC-DO-010128 FENRIR-(SS)):            book "PC151-06" vs ERP "PC151-08"
```

Read as written, two customers on PROCEEDED orders are getting the wrong fabric.
`docs/bugs/0689` recorded the mechanism as **UNKNOWN** after refuting the
previous attribution, and pointed the next reader at the fabric matcher and the
Desc2 decoder.

**It is neither.** Nothing read the Desc2 onto the wrong row. The ERP never
claimed which row is which, and the checker filled that in.

**Root cause (traced, on production, twice).**

*1 — the two rows carry no line key, and it is not an oversight: it is a
refusal.* `backfill-ac-downstream-line-keys.mjs` stamps
`scm.delivery_order_items.linked_ac_dtlkey` only where the document FORCES the
pairing (`lib/ac-forced-line-pairing.mjs`). Its own production APPLY run
[`34194376108`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34194376108)
(2026-09-08 14:22 +08) names these documents in its refusal list:

```
DO-011496: 2 line(s) left unkeyed — TRION (A) (HB STR)-(K): the book has 2 lines of this
  item at this quantity and they are NOT identical (2 distinct price/location/Desc2
  combinations), so which is which is unknowable
DO-010128: 2 line(s) left unkeyed — FENRIR-(SS): ... same
DO-011566: 2 line(s) left unkeyed — FLAT-(Q): ... same
DO-011446: 2 line(s) left unkeyed — VICTORIA-(SS): ... same
```

Read the committed book snapshot (`ac-reconcile-truth.json.gz`, `exported_at
2026-09-08T00:03:44Z`) and the refusal is exactly right. On `DO-011496` the two
lines are the same AutoCount code `HOK-2008(A) (K)`, the same quantity 1, the
same unit price RM 0.00, the same location `KL`, the same sales order
`SO-004994` — and differ in **Desc2 alone**:

```
DtlKey 919934  Desc2 "Clr: PC151-02/Divan:8\"+no legs/Gap:14\""
DtlKey 919942  Desc2 "Clr: PC151-03/Divan:8\"+no legs/Gap:14\""
```

**So the one fact that makes the colours "differ" is the same fact that made the
line key unstampable.** The stamping rule and the difference are two readings of
one measurement.

*2 — production confirms the refusal landed, and the checker still answered.*
`probe-cutover-so-do-lines.mjs`, run
[`34207863902`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34207863902)
(2026-09-08 17:03 +08), over `secrets.DATABASE_URL`:

```
DO-011496  BOOK seq=48  key=919934 "HOK-2008(A) (K)" -> NO ERP ROW CLAIMS THIS KEY
           BOOK seq=112 key=919942 "HOK-2008(A) (K)" -> NO ERP ROW CLAIMS THIS KEY
           ERP "TRION (A) (HB STR)-(K)" qty=1 -> CARRIES NO AUTOCOUNT KEY
           ERP "TRION (A) (HB STR)-(K)" qty=1 -> CARRIES NO AUTOCOUNT KEY
DO-010128  BOOK key=822696, 822698 "HOK-1005 (SS)" -> NO ERP ROW CLAIMS THIS KEY
           ERP "FENRIR-(SS)" qty=1 x2               -> CARRIES NO AUTOCOUNT KEY
```

`check-ac-erp-reconcile.mjs` pairs on `linked_ac_dtlkey` where the ERP carries
one, then falls back to `(quantity, unit price)`, then to document order. **A
migrated delivery order carries no money at all**, so both rows bucket as
`1|0` on both sides, the value pass separates nothing, and the assignment is
made by the order the two lists happen to be in — the book's `Seq`, ours
`(line_no, created_at, id)`. Two values into two slots by an ordering neither
side shares: a "swap" is what that looks like half the time.

*3 — what the document actually says, measured without any pairing at all.*
The bag of colours is order-independent, so no ordering can fake it in either
direction. From the reconcile's own printed values:

| document | book bag | ERP bag | |
|---|---|---|---|
| `DO-011496` | `{PC151-02, PC151-03}` | `{PC151-03, PC151-02}` | **EQUAL** |
| `DO-010128` | `{PC151-08, PC151-06}` | `{PC151-06, PC151-08}` | **EQUAL** |

One delivery order, one customer, one address, both lines on the same note. The
customer receives one bedframe in each of the two colours the account book
ordered. **Nothing on the floor is wrong, and there is no fabric to re-make.**

*4 — the experiment was already run, by accident, and it is decisive.* Compare
the DO colour axis either side of the key backfill. Nothing repaired a colour
between the two runs: `backfill-ac-downstream-line-keys.mjs` writes ONE column,
`linked_ac_dtlkey`, and its own run proves money, quantities, readiness, stock
and the migrated-document movement leak identical before and after. Every
`workflow_dispatch` run in the window was listed and its writers read — the only
other write touching `scm.delivery_order_items` was one line on `DO-001604`, a
different lane's document.

| DO colour axis, PROCEEDED | 06:19 +08, run [`34194151677`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34194151677) — before the keys | 16:45 +08, run [`34206269750`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34206269750) — after |
|---|---|---|
| DIFFER | **16** | **4** |
| ERP blank | 2 | 4 |
| book blank ("we hold a colour the book never stated") | **60** | **1** |

Twelve colour "differences" and fifty-nine "the ERP invented a colour" findings
evaporated the moment the ERP could say which of its rows is which — including
`DO-011505` and `DO-011478`, **the two documents `docs/bugs/0689` is about**,
which are absent from the backfill's refusal list because their two lines carry
different item codes and so were forced and stamped. The keys did not correct
a colour. They removed the checker's need to guess.

*5 — and the pre-backfill run shows the guess crossing PRODUCTS, not just rows.*
Its own output, at 06:19:

```
DO-011566 DtlKey 927185 (ERP HC-DO-011566 FLAT-(Q)):        AutoCount "taroni 1 cream" vs ERP "(blank)"
DO-011566 DtlKey 927189 (ERP HC-DO-011566 BREEVA (W)-(SP)): AutoCount "taroni 10 sliver" vs ERP "(blank)"
```

DtlKey 927185 is the book's `HOK-2027 (SP)` → `BREEVA (W)-(SP)` line and it was
paired to a `FLAT-(Q)` row; 927189 is a `FLAT-(Q)` line paired to the BREEVA row.
The reason is in the fallback's own key:

```js
for (const keyOf of [ (q, p) => `${q}|${p}`, (q) => `${q}` ]) {
```

**There is no item code in it.** On a migrated delivery order every line is
RM 0.00, so every unkeyed line of the same quantity lands in ONE bucket and is
consumed in order — a bedframe can be paired to a mattress. Nothing catches it
downstream either, because the DO type DECLARES its item-code axis away
(`delivery_order_items.item_code is taken from the SALES ORDER line by design`),
so the whole error surfaces on the variant axes as invented colours.

**This is the fifth and sixth instance of one bug class, and the fifth and sixth
false alarm from it.** `docs/bugs/0672` names it — *key without identity: a link
written on the key alone* — and `0688`, `0695` and `0696` are the same shape:
two similar rows, no line key, paired by position, reported as transposed. The
reconcile ALREADY declares this class on the item-code axis, in the owner's own
table, as `same-goods`: *"we hold NO AutoCount line number on these rows, so
which of our lines answers which of the book's was the checker's own guess."*
**The variant axes have no such guard, and that is the defect** — one checker
holding a pairing it has publicly declared untrustworthy, and trusting it
anyway one section further down. The same run shows two more of them on
`DO-011446`, where `gap` reads `10"` against `12"` and `T.Heights` `22"`
against `24"`, both ways round, on the same refused `VICTORIA-(SS)` bucket.

**What this entry does NOT close.** Four lines on the same axis are a different
shape and are still open work: `DO-004868` `VALKYRIE-(K)` and `DO-011566`
`BREEVA (W)-(SP)` are **key-forced** — the pairing is certain and the ERP
genuinely carries no colour where the book states one — and `DO-011566`'s two
`FLAT-(Q)` rows are unkeyed but blank on BOTH rows, so the verdict is the same
whichever way they pair. All four sit on PROCEEDED orders.

**Fix — SHIPPED and MEASURED on production.** Nothing was written to the two
documents, deliberately: they are not wrong. What changed is the checker, and
what it printed either side of the change is the whole proof.

| DO colour axis, PROCEEDED | before, run [`34210768489`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34210768489) 17:34 +08 | after the guard, [`34217483131`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34217483131) 18:49 | after the blanks were filled, [`34217807499`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34217807499) 18:53 |
|---|---|---|---|
| agree | 164 | 164 | **168** |
| ERP blank (the only column that is WORK) | 4 | 4 | **0** |
| **differ** | **4** | **0** | **0** |
| no-key (new; not work) | — | 4 | 4 |

`docs/bugs/0712` is the checker change. The four ERP-blank lines were a
different shape and are closed by `repair-migrated-do-line-colour.mjs`, plan run
[`34217614240`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34217614240)
and apply run
[`34217713545`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34217713545):
`APPLIED: 4 row(s) written of 4 planned`, then, on a FRESH connection, `all 4
row(s) hold the planned colour` with money, quantities, readiness, stock, the
migrated-document movement leak and the AutoCount outbox (45 rows) identical
before and after.

**Fix (original text).** NONE to the two documents, deliberately — they are not wrong.
`backend/scripts/probe-do-colour-pairing.mjs` (read-only, no `APPLY` path) is
added here as the observation that decides this class: per line, whether the
pairing was FORCED by a line key or GUESSED, and where it was guessed, whether
the two sides' values form the same multiset. The guard that stops the reconcile
printing a guessed pairing as a difference, and the repair of the four ERP-blank
lines, follow in their own PR with their own before/after.

**Lesson.** `docs/bugs/0689` sent the next reader to the fabric matcher and the
Desc2 decoder because both COULD produce a wrong colour. Neither had to have
run: the swap is fully explained by two rows the ERP cannot tell apart and a
checker that had to choose. **Before attributing a transposition to a writer,
ask whether anything ever assigned those two rows at all** — and the cheapest
place to ask is the line-key backfill's own refusal list, which had already
named all four documents by the time the reconcile printed them.

**Ref.** fix/do-colour-swap, 2026-09-08.
