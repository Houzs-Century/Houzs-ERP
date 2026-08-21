## The discount rode the amendment but no reader showed it — the approver was told nothing changed [high]

<!-- area: Sales orders + pricing -->

**Symptom.** Minutes after #2624 deployed, the operator retried the RM 250 →
125 fee reduction on locked `2990-SO-2608-020`. The submit worked — amendment
`/A2` was created, pending, *"waiting for Logistics"*. But **view changes**
answered:

> No line changes recorded — every line matches the order exactly. This request
> predates order-detail tracking, so what was asked for is in the Reason below.

The discount was in the database. Nobody could see it.

**Root cause (traced).** #2624 shipped the write half of the channel (signature
→ payload → column → apply) and the approver's card render — but not the
**read**: `GET /so-amendments/:id` selects its line columns by name
(`routes/so-amendments.ts`), and `new_discount_sen` was not on the list. The
API returned the row without the field, `amendmentLineChangedFields` computed
it delta-free, `visibleAmendmentLines` dropped it, and the dialog rendered its
legacy-empty message — which *misattributes* the emptiness to a pre-tracking
request, on a request raised five minutes earlier.

The precedent had already mapped this territory: #1992 (the remark channel,
mig 0280) touched **thirteen files**, including this exact select, the
amendment PDF map, and the view-changes renders on desktop, V2 and mobile.
#2624 mirrored its migration, builder, apply and sig — and missed its read
sweep. The apply path reads its own select (updated in #2624), so an approval
signed blind would still have applied the right discount; the defect was
purely that every human surface denied the change existed.

**Also corrected here:** #2624's docs claimed a discount change waits on
Purchasing. The lane split (`shared/amendment-lane.ts`) classifies by **item
code** — service lines (the delivery fee) go to the **DELIVERY lane →
Logistics**; product-line discounts go to LINES → Purchasing. The banner's
"waiting for Logistics" on /A2 was correct behaviour, not a routing bug.

**Fix.** The read sweep #1992 prescribed:

- `routes/so-amendments.ts` — `new_discount_sen` joins the select (root cause);
- `amendment-pdf-map.ts` — a `Discount` before/after row, via the shared
  changed-fields test so page and print never disagree;
- `SalesOrderDetail.tsx` (view-changes dialog) and `MobileSODetail.tsx` (the
  sheet) — discount lines on both sides, "Discount cleared" for a zero.

Proved RED: with `amendment-pdf-map.ts` stashed, its two discount-emitting
tests fail (`2 failed | 5 passed`); the untouched-discount case passes both
ways. The AmendmentDetailV2 card needed no change (#2624 covered it) — it was
starved by the API, not broken.

**The lesson, for the next channel field:** mig 0281's rule ("a field may join
the signature only with its payload, column and apply write behind it") was
incomplete. A channel has **five** parts: signature, payload, column, apply —
and every reader. `git show --stat` the PR that added the previous field, and
touch every file it touched.

**Ref.** fix/so-amendment-discount-visible, 2026-08-21.
