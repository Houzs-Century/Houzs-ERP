## Mark Signed on the mobile shell closes a delivery with no signature [medium]

<!-- area: Delivery, DO, returns -->

**Symptom.** `MobileModuleDetail`'s delivery-order action bar offers
`IN_TRANSIT → SIGNED` labelled "Mark Signed". It writes the status and nothing
else: no signature, no photo, no GPS. The status is literally named for the
evidence it does not collect.

`SIGNED` is not a lesser state than `DELIVERED`. It is a member of the
`delivered` list bucket, `doCountsAsDelivered` returns true for it, and it
satisfies the Sales-Invoice gate — so a delivery parked at SIGNED is closed
everywhere that matters while carrying no customer-side proof.

**Root cause (traced).** Not the same shape as `0480`, which is why it was not
fixed with it. This surface's status actions are a DECLARATIVE table shared by
about ten document types — each row is `{ path, method, body }` executed by one
generic mutation — so it cannot call the DO-specific hook without special-casing
the table for one module. The file's own comment shows the DELIVERED case *was*
thought about and routed away ("DELIVERED is the POD screen's job, so it is never
offered here"); SIGNED was left on the ladder, and the reasoning that removed
DELIVERED applies to it just as well.

**Fix.** NOT DONE. Recorded so the gap is visible rather than accidental. It is
an explicit allowlist entry in
`frontend/src/vendor/scm/lib/do-status-evidence.test.tsx`, carrying this
reasoning, so a sixth raw writer still fails that test while this known one does
not masquerade as clean.

Two candidate remedies, neither chosen here:
  - drop the `IN_TRANSIT → SIGNED` rung from the mobile shell entirely, the way
    DELIVERED already was, leaving the POD screen as the only close; or
  - give the action table an optional per-row hook override so DO status rows
    route through `useUpdateMfgDeliveryOrderStatus` like every other surface.

The first is smaller and matches the decision already recorded in that file. It
removes an action drivers may be using, so it is an owner question, not a
unilateral fix.

**Ref.** fix/pod-evidence-and-service-actions, 2026-08-21.
