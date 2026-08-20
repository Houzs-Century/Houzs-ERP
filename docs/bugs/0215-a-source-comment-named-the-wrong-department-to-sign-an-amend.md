## A source comment named the wrong department to sign an amendment, and a guide's list had rotted 5-of-13 [low]

<!-- area: Sales orders + pricing -->

**Two findings from verifying the SO amendment section of
`docs/modules/sales-order.md`. Neither is a runtime defect; both are what a
reader would act on.**

**1. The comment said Purchasing; the code says Logistics.**
`so-amendment-header.ts`'s `AMENDABLE_HEADER_KEYS` carried:

> *(DELIVERY lane — Logistics signs; the Processing Date above signs with
> Purchasing per the same ruling)*

`soHeaderFieldKind` returns the literal `'DELIVERY'` for **every** key including
`processingDate`, and `amendment-routing.ts` maps `DELIVERY` to **Logistics**.
Purchasing is reached only through the `SUPPLIER` atom — a PO header field with
no SO-header counterpart.

Three places agree with the code and only the comment did not: the routing table
itself, `sales-order.md`, and `purchase-order-amendment.md` section 7. That is
the worst place for it to be wrong — a comment is where a reader looks FIRST when
working out who signs off on a change. Corrected in place, with what it used to
say.

**2. The guide named 5 amendable header keys; there are 13.**
The prose listed delivery date, processing date, state, postcode and city. The
two-lane rework (owner 2026-07-27) added the whole delivery-address block
(`address1`..`address4`, `shipToAddress`, `billToAddress`, `installToAddress`)
plus `replacementDisposal`, and the prose did not follow. **A reader planning an
amendment would have concluded the ship-to address could not be amended.**

**The fix is not to update the list — it is to stop repeating it.** The keys
already have a guard the prose never had: `so-field-policy.test.ts` asserts
`AMENDABLE_HEADER_KEYS` equals `soAmendableHeaderKeys()` exactly. Proven live
here by deleting `'shipToAddress'` from the array — 1 of 12 fails with
`expected [ 'processingDate', …(11) ] to deeply equal [ 'processingDate', …(12) ]`.
The guide now points at the constant and that test instead of carrying a
hand-written copy, because a hand-written copy is exactly what rotted.

**Ref.** 2026-08-15, module-guide verification of `sales-order.md`.
