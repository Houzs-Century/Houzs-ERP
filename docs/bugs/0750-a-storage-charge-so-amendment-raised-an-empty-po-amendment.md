## A storage-charge SO amendment raised an empty PO amendment [medium]
<!-- area: Purchase orders + GRN + PI -->
<!-- status: fixed -->

**Symptom.** Owner, 2026-09-09: SO amendment HC-SO-006772/A1 changed a storage
charge from 7 months to 10 months, and the system auto-raised
HC-PO-006690/A1 — a PO amendment reading **0 changes** ("This amendment has no
line changes recorded") against a PO already in RECEIVED. The purchaser had a
second signature to clear for a change the supplier can do nothing about. The
owner's rule: "SO amendment — 如果是关于 Service - storage, disposal, delivery —
无需升级到 PO amendment".

**Root cause (traced).** `raisePoFollowUps`
(`backend/src/scm/lib/amendment-po-followup.ts`) gated on `poRelevant` alone,
which reads only `change_type`: QTY / ADD / REMOVE returned true with no look at
WHAT line moved. Storage / disposal / delivery are SERVICE lines
(`scm/shared/service-sku.ts` — `item_group` 'service', `SVC-*` codes), and the
rest of the system already agrees they are not goods: never MRP demand, never
allocated stock, never a PO line (`docs/modules/mrp.md` §2). So no PO line is
ever bound to one.

The empty preview came from the same gap in a second place. Candidate POs were
discovered from the SO's **other** lines' links, so the goods line's PO was
found and an amendment inserted for it; step (7) then had nothing to preview
because the changed line has no PO line anywhere. Zero preview rows was the
visible symptom; the missing SERVICE filter was the cause.

**Fix.** Two gates, both before PO discovery.

- `serviceOnlyChange` drops SERVICE-line changes. Identity is judged on BOTH
  sides of the edit — live SO row, or the pre-apply snapshot for a REMOVE, which
  hard-deletes the row — so a SPEC edit swapping a service SKU for real goods
  still escalates. Unknown identity is deliberately NOT service: an extra
  follow-up the purchaser withdraws beats a real change the supplier never hears
  about.
- Candidate POs narrow to the ones that actually **host** a changed line (owner
  approved the same day). Previously every bound PO got one, so a one-line change
  on a multi-PO order raised a 0-change amendment against each untouched PO too.
  The narrowing applies only when EVERY changed line already has a PO home: a
  changed line with none may still need one — an ADD by construction, and equally
  a line that was never ordered — so there the full bound set stays in play and
  `reviseBoundPo` matches the supplier at confirm, exactly as before.

**Test.** `backend/src/scm/lib/amendment-po-followup.test.ts`, 10 cases.
Mutation-verified against the unfixed behaviour, each gate separately: all 10
pass on the fixed tree; with the SERVICE filter removed **4 fail / 6 pass** (the
three service cases plus the mixed one); with the narrowing reverted to "every
bound PO" **2 fail / 8 pass** (the two narrowing cases). Each gate's suite
therefore fails for its own reason, not merely because an export went missing.

**Not changed, and deliberate.** HC-PO-006690/A1 itself was left alone — the fix
stops the next one, it does not retract an amendment already raised. The owner
approved that one on 2026-09-09; approving a 0-change follow-up is inert
(`reviseBoundPo` re-derives the PO from the SO and finds nothing to change) apart
from a revision bump. Note for anyone clearing one by hand: **withdraw, do not
reject** — rejecting a follow-up releases the PO's un-allocated remainder to
STOCK (`docs/modules/purchase-order-amendment.md` §3).

**Lesson.** A change-type gate is not a change gate. `poRelevant` asked "what
kind of edit is this" and never "what kind of LINE is this" — and the SERVICE
predicate it needed had existed, shared and tested, since the SO-SKU spec.

**Ref.** `fix/service-amendment-no-po-followup`, 2026-09-09.
