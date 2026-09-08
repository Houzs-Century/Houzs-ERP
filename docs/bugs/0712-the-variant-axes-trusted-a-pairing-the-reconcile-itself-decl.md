## The variant axes trusted a pairing the reconcile itself declared a guess [high]

<!-- area: AutoCount sync + write-back -->
<!-- status: fixed -->

**Symptom.** `check-ac-erp-reconcile.mjs` has put the same nine values in front
of the owner on every run for two days, as differences that need a human:

| axis | what it printed | run [`34210768489`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34210768489), 2026-09-08 17:34 +08 |
|---|---|---|
| colour / fabric | `DO-011496` book PC151-02/PC151-03 vs ERP PC151-03/PC151-02 | 4 DIFFER |
| | `DO-010128` book PC151-08/PC151-06 vs ERP PC151-06/PC151-08 | |
| gap | `DO-011446` book 10"/12" vs ERP 12"/10" | 2 DIFFER |
| T.Heights | `DO-011446` book 22"/24" vs ERP 24"/22" | 2 of 3 DIFFER |

Every one of them is an exact transposition of two values across two rows of ONE
item at ONE quantity on ONE document. `docs/bugs/0709` traced the colour half:
those ERP rows carry no `linked_ac_dtlkey`, so the checker had to GUESS which of
our rows answers which of the book's, and the two sides hold the same values
either way. This entry is the CHECKER defect behind it.

**Root cause (traced).** `check-ac-erp-reconcile.mjs` pairs on
`linked_ac_dtlkey` where the ERP carries one and otherwise falls back to
`(quantity, unit price)` and then to document order. A migrated delivery order
carries no money at all, so two rows of one product at one quantity bucket
identically on both sides, the value pass separates nothing, and the assignment
is made by an ordering the two systems do not share — the book's `Seq`, ours
`(line_no, created_at, id)`.

**The reconcile already knew this and already said so — one section higher up.**
Its own summary table carries a `same-goods` column for exactly this population,
in the owner's own terms:

> we hold NO AutoCount line number on these rows, so which of our lines answers
> which of the book's was the checker's own guess. Both sides list the SAME
> products in the SAME quantities, which no ordering can fake.

That declaration was applied to the item-code axis and to nothing else. The
variant axes read the same pairing, printed its arbitrary assignment as a
finding, and — because `DIFFER` locks — held the document's per-document verdict
LOCKED on it. One checker, two opposite positions on one pairing.

Two facts make the class expensive rather than cosmetic:

- **The refusal that produced these rows is deliberate and permanent.**
  `lib/ac-forced-line-pairing.mjs` stamps a line key only where the document
  FORCES the pairing, and it refuses when the bucket's book lines differ **in
  Desc2 alone** — which is where the colour, the gap and the heights live. So
  the very fact that makes the values look different is the fact that makes the
  key unstampable, and no amount of re-running the backfill will clear these.
  Its production APPLY run
  [`34194376108`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34194376108)
  names all four documents in its refusal list.
- **Six of these have now been raised and five were phantoms** —
  `docs/bugs/0672`, `0688`, `0689`, `0695`, `0696`, `0709`. Each cost a session,
  and `0689` was reported to the owner as fixed once when nothing had been.

**Fix.** `foldGuessedPairing` in `backend/scripts/lib/variant-reconcile.mjs` — a
new verdict `NO_LINE_KEY` and a `no-key` column beside `differ`, printed with
its own sentence and with every row named. A value moves into it only when all
three hold:

1. at least TWO rows of the bucket carry no AutoCount line key — one unkeyed row
   among keyed ones is forced by elimination, not guessed;
2. the bucket holds more than one row;
3. the two sides' value MULTISETS for that axis are EQUAL. A bag is
   order-independent, so no ordering can fake it and none can hide a real
   difference behind it. **A bucket whose bags DIFFER keeps every one of its
   differences** — a partial cover is not a cover, which is the lesson of
   `docs/bugs/0668`, where a hand-typed label printed 30 real gaps as owner
   decisions.

It is deliberately NOT folded into `AGREE`, for the reason `RECORDED` was not:
the row genuinely does not state what the book's row states. What is proven is
that the DOCUMENT ships the right values and that which of our rows is which is
unknown — so it is printed as unknown, does not lock, and is not counted as
work. It applies to the SCALAR axes only (`FOLDABLE_AXES`); compartments already
have a stricter rule (an unkeyed sofa build is UNREADABLE, never AGREE) and
specials are a multiset over one line already.

**Pinned by `backend/tests/variantGuessedPairing.test.mjs` (11 tests)**, in
`backend/tests/` and not beside the module, because eleven of the thirteen
`*.test.mjs` files in `scripts/lib/` are collected by no vitest project and run
by no workflow — a guard nobody runs is not a guard.

**PROVED RED on the unfixed tree**, one clause at a time:

```
clause 1 (two unkeyed rows) removed  -> 1 failed | 10 passed
   × ONE keyed row leaves the bucket FORCED — the last row is settled by elimination
clause 3 (equal multisets) removed   -> 2 failed | 9 passed
   × a bucket whose two sets DIFFER keeps every one of its differences
   × an ERP blank is not a transposition — the sets cannot be equal
both restored                        -> 11 passed
```

**What it does NOT fix, named rather than left to be re-found.** The keyless
fallback's first two passes bucket on `(quantity, unit price)` with **no item
code in the key**, so on a document where every line is RM 0.00 a bedframe can
be paired to a mattress. That is not hypothetical: the 06:19 +08 run
[`34194151677`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34194151677)
printed `DO-011566 DtlKey 927185` — a `BREEVA (W)-(SP)` book line — against a
`FLAT-(Q)` ERP row. It stopped mattering for delivery orders and goods receipts
when the line keys landed, and it is still live for sales invoices and purchase
invoices, which carry no keys at all. Fixing it means preferring a same-product
candidate in the fallback, which moves pairings on document types two other
lanes are working in today (`fix/gr-iv-pi-remainder`), so it is deliberately NOT
done here — a change that moves another lane's numbers under it is not a
courtesy.

**MEASURED on production, before and after, with nothing else written between
the two runs.** Reconcile [`34210768489`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34210768489)
(17:34 +08, pre-guard) then [`34217483131`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34217483131)
(18:49, post-guard):

| DO axis, PROCEEDED | differ before | differ after | no-key after |
|---|---|---|---|
| colour / fabric | 4 | **0** | 4 |
| gap | 2 | **0** | 2 |
| T.Heights | 3 | **1** | 2 |

The run states its own effect — `DO — 8 axis value(s) across 3 bucket(s) moved
out of DIFFER into no-key` — and `differ + no-key` is preserved on every axis,
so nothing was invented or destroyed. The T.Heights survivor is the CONTROL that
the guard is not a blanket: `DO-000608 DtlKey 84752`, book `12"` against ERP
`22"`, is the only row of its item on its document, so no pairing could have
transposed it and it stays a difference.

**The wider control.** `no-key` across ALL SIX document types totals **8** — the
same 8 — so not one value on a sales order, purchase order, goods receipt, sales
invoice or purchase invoice was reclassified. Every other DO axis reads exactly
as it did: divan `143/0/1/0`, leg `143/0/1/0`, seat `25/1/3/0`, compartments
`19/0/0/2` with `unread 8`, specials `167/1/2/2` with `recorded 1`.

**What moved that this did NOT move, said plainly.** Between those two runs the
document-axis total went `21 -> 17` disagreements and the sales-order verdict
`2730 -> 2736` open, and the sofa-compartment DIFFER on the ORDERS went `14 ->
8`. None of that is this change: other lanes were writing to the same corpus in
the same 75 minutes (#3240 stamped sofa line keys, #3243 and #3251 landed), and
this guard cannot touch a document axis at all and excludes compartments from
`FOLDABLE_AXES` by construction. Attributing them here would be the kind of
tidy story this ledger exists to stop.

**Ref.** fix/do-colour-guard, 2026-09-08. (Filed as `0711`, renumbered to `0712` at merge time — two other lanes took `0711` the same hour.)
