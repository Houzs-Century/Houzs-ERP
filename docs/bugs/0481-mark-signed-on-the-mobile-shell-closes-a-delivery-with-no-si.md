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

**Fix. RESOLVED 2026-08-21** by the first candidate remedy below — the owner
decided to remove "Mark signed" system-wide (Option A), so the answer to the
"owner question" flagged here is settled. The `IN_TRANSIT → SIGNED` "Mark Signed"
rung is dropped from `MobileModuleDetail`'s DO ladder (it now stops at
DISPATCHED → "Mark In Transit"), the desktop/list "Mark signed" advance is
removed from `do-next-step.ts` (`doAdvanceStep` offers only DRAFT → Confirm), and
`doCloseWithoutEvidenceWarning` is deleted. SIGNED / DELIVERED are now written
ONLY by the driver's Proof-of-Delivery screen, which signs the delivery — so the
no-evidence close is gone. `do-status-evidence.test.tsx`'s allowlist comment is
updated to record the closure.

The candidate remedies were:
  - drop the `IN_TRANSIT → SIGNED` rung from the mobile shell entirely, the way
    DELIVERED already was, leaving the POD screen as the only close **← chosen**; or
  - give the action table an optional per-row hook override so DO status rows
    route through `useUpdateMfgDeliveryOrderStatus` like every other surface.

**Ref.** feat/txn-workflow-unify, 2026-08-21 (owner-chosen removal). Original
record under fix/pod-evidence-and-service-actions, 2026-08-21.
