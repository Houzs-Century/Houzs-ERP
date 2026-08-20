## The confirm gate demanded a spec the customer had not chosen yet, so real orders could not be booked [high]

**Symptom** — a salesperson with a real customer and a real deposit could not
create the Sales Order. From 2026-08-08 the DRAFT→CONFIRMED gate demanded every
goods line's category-required variant axes — sofa Seat Height + Fabrics,
bedframe Divan/Leg/Gap/Fabrics — date or no date, in the server gate and three
client surfaces. Those are precisely the facts a customer comes back to give
later. On `/scm/sales-orders/new/from-products`, which has no variant editors by
design, the client silently downgraded the whole cart to a DRAFT instead, because
a direct-CONFIRMED create would have been refused outright.

**Root cause (traced, not guessed)** — a correct fix aimed at the wrong gate.
HC-SO-2607-008 (a bedframe line `Y103-(Q)` confirmed with no selections at all)
was answered by adding the axis check at CONFIRM. The owner narrowed it the same
week, 2026-08-13: *"只要是没有 proceed 这一张订单，其实都不一定是需要填写的，除非它是
proceed 了"* — an order that has not been PROCEEDED does not have to be
spec-complete; the moment it is proceeded, it does. Setting a Processing Date IS
proceed, and that rule already existed and was never in question
(`so-variant-check.ts`, gated through `shared/so-save-problems.ts`, together with
the colour-KIV rule of 2026-07-24 and the address/postcode/delivery-date
completeness the same date requires). So the 2026-08-08 change added no rule; it
moved an existing deadline earlier than the owner wanted, and left two gates
enforcing one rule.

**Fix** — the variant check is REMOVED from
`backend/src/scm/lib/so-confirm-gate.ts` entirely rather than softened to a
warning: `variants` is off `SoConfirmLineFacts`, off the row type, and out of the
`mfg_sales_order_items` SELECT, so the gate cannot read a variant even by
accident. `SalesOrderNew.tsx` goes from `if (!asDraft || processingDate)` to
`if (processingDate)`; `MobileNewSO.tsx` from `if (!asDraft && (procDate ||
!isEdit))` to `if (!asDraft && procDate)`; `SalesOrderNewFromProducts.tsx` drops
the `asDraft: needsCompletion || undefined` downgrade, which would now only
strand a real order in Draft for no reason. Confirm again means "this is a real
order for a real customer"; proceed means "this is buildable". The test file pins
the boundary from both directions, including `no problem this gate can raise is
ever about a variant`.

**Left behind, verified at origin/main `de99056d5`** —
`missingConfirmVariantAxes` (`backend/src/scm/shared/so-variant-rule.ts:127`) now
has **no production caller anywhere**. `git grep` finds it in its own definition,
two test files, one comment in `backend/scripts/check-so-noncatalog-lines.mjs`,
this ledger, and the stale guide row this commit fixes. It is a live export whose
confirm-vs-proceed distinction no longer decides anything, and it is still
maintained by `so-variant-rule.exemptions.test.ts`.

**The class, for next time** — two gates for one rule is how these drifted apart,
and the PR names that as the reason for deleting rather than relaxing. The check
that should have caught the 2026-08-08 change is the owner rule itself, which
lives in `docs/modules/sales-order.md` — and the guide was updated to MATCH the
new gate rather than to question it, so for five days the documentation
corroborated the bug. A module guide that is updated to agree with a change is
worth nothing as a check; it is worth something only when it is read BEFORE the
change, which is the order CLAUDE.md asks for.

**Ref** — 2026-08-13, PR #2072 (`fix/variant-exemption-required-itemcode`). Entry
written 2026-08-14 from the merged diff. Module guide: the Confirm-gate table in
`docs/modules/sales-order.md` carried a `variants_incomplete` row describing the
removed rule in full — the last non-test description of it in the repository —
for a day after the code stopped implementing it. **It was corrected on
2026-08-14 by the documentation audit, PR #2129**, which also recorded that
`missingConfirmVariantAxes` has zero production callers. Nothing further is owed
there; what this PR owed was that correction in its own diff.

---
