## A mobile upload never submitted a gated document for review [high]

<!-- area: Projects + PMS + fair report -->

**Symptom.** Owner 2026-08-21: "stock out transfer sim already uploaded but
still appear on my pending task sim ... supposed my pending task on peter and
kris not sim". Measured live: a Stock Out uploaded from the phone sat with
`review_status NULL` (Approval column "—"), so NOT_IN_REVIEW kept it in the
purchaser's lane and no approver lane ever saw it. Three related holes
surfaced in the same trace:

1. **Mobile never submits.** Desktop's upload handler calls
   `/review submit` afterwards (for `isReviewableTitle` rows); mobile
   `MobilePMS.upload()` just PUTs the attachment. Phone uploads stayed
   un-submitted forever.
2. **A submitted STOCK IN reached no approver anyway.** The director lane
   matched only the title 'Stock Out Transfer Record', and the generic
   approver lane only `projects.approve` (`GATING_APPROVE_PERMS`), so
   `stock_in.approve` submissions surfaced in nobody's My Pending.
3. **The purchaser card LABEL listed in-review rows.** `my_pending_titles`
   for the role lane had no review filter, so even a correctly-routed
   submitted doc was still NAMED on the purchaser's pending card.

**Fix.** (1) The upload route itself submits a gated, pending, not-in-review
row after saving the file — client-independent, so every surface routes the
doc to its approver. (2) The director stock lane + duty chips are
title-driven from the keys the director explicitly holds
(stock_transfer.approve → Stock Out, stock_in.approve → Stock In), and
pendingApprove widens with explicitly-held stock/agreement keys for the
owner / BD branches. (3) `my_pending_titles` excludes
pending_review/amended rows. Stuck rows were repaired in production by
flipping them to pending_review.

**Ref.** fix/purchaser-scope-and-review-routing, 2026-08-21.
