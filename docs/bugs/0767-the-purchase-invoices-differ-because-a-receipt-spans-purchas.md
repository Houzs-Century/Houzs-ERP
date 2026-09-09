## The purchase invoices differ because a receipt spans purchase orders the cutover never brought in [low]

**Symptom.** 141 migrated purchase invoices were created on 2026-09-09 from the
account book's own invoice lines (run 34372044049, `APPLIED — 141 invoice(s)
created`, `VERIFY OK 141/141`). The tally then read **PURCHASE INVOICES — 196
documents, 159 differ**, against 35 of 55 before. Of those 159, **~121 carry the
same two axes**: `a book line we do not have` and `document total`.

**First hypothesis, REFUTED — say so before the one that held.** I expected the
missing lines to come from receipts outside the cutover's scope. Measured on the
committed cut with `buildScope`:

```
book purchase invoices IN SCOPE: 189
  every line from an in-scope receipt:            172
  has a line from an OUT-OF-SCOPE receipt:         17
```

Seventeen, not 121. The hypothesis explains a seventh of the population and was
dropped rather than stretched.

**Root cause (traced, one level further up).** The scope rule runs on PURCHASE
ORDERS, and one receipt in this book serves MANY of them. `GR-000201`:

```
book GR-000201 — 12 lines from 10 purchase orders
  PO-000273  in scope ✓     PO-000275  in scope ✓
  PO-000272 · PO-000277 · PO-000279 · PO-000280 · PO-000281
  PO-000282 · PO-000283 · PO-000284      — none in scope
```

The cutover imported the receipt lines belonging to the two POs in scope, so our
`HC-GR-000201-PO-000273` + `-PO-000275` hold 2 lines where the book's receipt
holds 12. `PI-000832` bills all twelve — RM 8,025.00 against our RM 1,365.00 —
and every one of its lines names `GR-000201`, which IS in scope. That is why the
first hypothesis missed it: the RECEIPT is in scope; the PURCHASE ORDERS behind
most of its lines are not.

**And it is the normal shape here, not an outlier:**

```
in-scope receipts: 211
  with lines from an OUT-OF-SCOPE purchase order: 124   (59%)
  their lines: in scope 587 · out of scope 837
```

**More of those lines are out of scope than in.**

**So the ~121 are not work.** Every line we wrote IS the book's own line, byte
for byte — that is what building from `PIDTL` bought (`docs/bugs/0766`). What is
absent belongs to purchase orders the owner decided not to migrate, and
`document total` is the axis he ruled need not match:
「total amount不需要 可是line amount一定一样」.

**NOT changed here, deliberately.** The obvious move is to teach the reconcile to
class this as `book-gap` — "already accepted as 一模一样" — the way it already
classes the invoice types the cutover did not bring over. That is a change to the
one module allowed to decide whether two things differ, and a wrong widening
there hides real work rather than a known gap. It needs its own PR, its own
tests, and a rule stated on the LINE's source purchase order rather than on the
document. Recorded so the next reader starts from the measurement instead of the
hypothesis I had to throw away.

**What remains genuinely work**, from the same diag run: 15 `transfer from`,
5 specification axes (T.Heights / colour / divan / gap / leg), 3 sofa
compartments, 3 unmatched lines, 2 specials, 1 item code, plus 6 sofa builds that
need the owner's drawing — about 38 documents.

**Ref.** 2026-09-09/10. Follows `docs/bugs/0764`, `0766`.
