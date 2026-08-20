## The purchaser could not N/A her own gated tasks — the approval key gated the wrong verb [medium]

<!-- area: Projects + PMS + fair report -->

**Symptom.** Owner 2026-08-17: "user sim cannot click N/A on her task please
allowed her to click N/A." Sim (Purchaser) clicking N/A on Exchange List /
Stock In / Stock Out rows got 403 `Requires stock_transfer.approve`.

**Root cause (traced).** POST `/checklist/:itemId/status` required the item's
`required_perm` approval key for EVERY status transition on a gated row. All
three PURCHASER document rows are gated (`stock_transfer.approve` /
`stock_in.approve` / `projects.approve`), while the purchaser-lane design
(2026-08-11) explicitly expects the purchaser to N/A them when an event needs
none — the gate and the lane contradicted each other, and since only approvers
held the keys, the flood could only be cleared by Peter/Kris clicking N/A on
the purchaser's behalf.

**Fix.** The approval key now gates only the decision-equivalent transitions
('done' / 'blocked'). 'na' and its undo ('pending') fall through to the
existing role-badge gate, so the badged function (or projects.write) may N/A
their own document rows; the approver brand scope still applies whenever the
caller holds the key.

**Ref.** 2026-08-17, same PR as the cancelled/pending-lane entry above.
