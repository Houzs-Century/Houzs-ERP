## A held purchase document read as cancelled, draft, or partly paid [medium]

**Symptom.** Found while adding `ON_HOLD` to the three purchase documents
(migs 0318/0319/0320), before any of them could reach a screen. Each detail page
resolves a status into a display "stage", and none of the three chains named the
new value — so all three would have shown something **false** rather than
something missing:

| page | what a HELD document would have shown | why |
|---|---|---|
| `PurchaseOrderDetailV2` | **Cancelled** | `effectiveOf` ended `return "cancelled"` |
| `GoodsReceivedDetailV2` | **Draft** | its fall-through is `draft` |
| `PurchaseInvoiceDetailV2` | **Partially paid / Paid** | it tests `paid_sen` before status |

The Purchase Order one is the worst of the three, and not by a little. A hold is
the **reversible** stop — it exists precisely because CANCELLED is final and
reaches AutoCount, where it cannot be un-cancelled. Telling a buyer his held
order was CANCELLED inverts the one property the status was added for.

The Purchase Invoice one is the most easily missed: the money checks come first,
so an invoice that was partly paid and *then* put on hold would have read
"Partially paid" — and the hold would have been invisible on the one screen a
person opens to decide whether to pay the rest.

**Root cause (traced).** Not a typo in three places — one structural habit. Each
`effectiveOf` is an if-chain that ends in a **default arm rather than a refusal**,
so an unrecognised status does not surface as unknown, it silently adopts
whichever meaning happens to be last. The three defaults were `cancelled`,
`draft` and (via the money tests) `paid` — three different wrong answers from the
same shape.

This is the label half of a pattern this repo has already paid for: ASSR's
`voided` had no entry in `customerStatusFor`, fell through to
`default: { label: stage }`, and printed the raw slug **"voided"** on the customer
portal. That one leaked an internal word. This one is worse in kind, because a
default arm does not look wrong — it produces a real, plausible status.

**Fix.** All three chains name `ON_HOLD` explicitly, and the Purchase Invoice one
names it **before** its money checks. `PurchaseOrderDetailV2`'s comment records
why its last line is dangerous, so the next status added there is not left to the
fall-through.

**Not fixed here, and stated rather than left implied.** The three chains still
end in a default arm. Making them refuse an unknown status is the real fix and it
changes what those pages render for legacy rows, which is a separate decision.

**What made it findable.** `check-duplicated-decisions` reported the PO's
`VALID_STATUSES` as a near-miss against the detail page's `STAGE_LABEL` — one
value in the write vocabulary that the display map did not have. That pointed at
`STAGE_LABEL`; reading the file for it is what surfaced `effectiveOf` beside it.
The gate found a missing label and the missing label led to a wrong one.

**Ref.** `feat/hold-on-purchase-docs`, 2026-08-21. Found before release, not in
production: `ON_HOLD` did not exist as an enum label until the migrations in the
same PR, so no row has ever carried it.
