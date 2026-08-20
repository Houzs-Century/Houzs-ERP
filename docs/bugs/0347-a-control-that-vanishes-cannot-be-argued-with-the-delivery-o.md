## A control that vanishes cannot be argued with — the delivery order's next step, the purchase order's dead Submit [high]

<!-- area: Delivery, DO, returns -->

The owner opened one delivery order per company, side by side. Same screen, same
green slot in the same corner — one said "Transfer to Sales Invoice", the other
"Mark signed". His reading: *"我又不是两套系统."*

The code was right. `DeliveryOrderDetailV2.tsx` gated the transfer on
`signed || delivered` and the sign-off on `loaded || dispatched || in_transit`,
with no company in either predicate; the two documents differed only in STATUS.
He was still right, because the transfer was not rendered as UNAVAILABLE — it
was not rendered at all. From the second seat the product did not have the
feature. **A capability that disappears without a word is indistinguishable from
one that does not exist**, and that is how one system comes to look like two.

**The rule applied here.** A control the STATE forbids stays on screen, disabled,
carrying the reason and the next step, and the reason lives in ONE module so a
second surface cannot invent a different one. PERMISSION still hides — that is a
separate, deliberate rule (`auth/salesAccess.ts:200`, "off, not hide"), and
nothing here starts advertising actions to people who may never take them.

**Two modules now own the sentences.** `vendor/scm/lib/do-next-step.ts` (DO) and
`vendor/scm/lib/po-next-step.ts` (PO). Four surfaces read the DO one — desktop
detail header, that same page's phone bar, the list quick-view drawer, the native
mobile shell — where before each re-derived the answer. Precisely: the
SALES-INVOICE question is shared by all four; the ADVANCE question is shared by
the three desktop-side surfaces, and the mobile shell keeps its finer driver
ladder on purpose (see below), so on DISPATCHED the desktop still says "Mark
signed" and the phone still says "Mark In Transit" — now a recorded decision
with a reason rather than two hand-written copies that had drifted.
An unrecognised status gets a generic sentence, never a guess; the COMPLETED
story in `shared/do-shipped-states.ts` is what that rule is for.

**Three dead controls found by reading the server, not the screen.**

1. **PO "Submit" could never work.** `PATCH /mfg-purchase-orders/:id/submit` read
   the row, echoed an already-SUBMITTED PO, 409'd on a missing warehouse, then
   returned `cannot_submit` unconditionally — no `.update(...)` anywhere in it.
   So the DRAFT it existed to advance was the one case it could not serve, and
   the operator was told *"That change was not saved — PO is DRAFT"* in answer to
   "submit this draft". `/confirm` (the handler that does write) was reachable
   from the Edit view and the phone but not from the page the route mounts
   (`App.tsx:616`). Four controls advanced a draft PO; three used `/confirm`, and
   the fourth — the one the operator actually meets — used the dead one. The
   endpoint is deleted; the page calls `/confirm`. The file's own comment had
   called `/submit` "an idempotent no-op for legacy callers": it was neither
   idempotent nor harmless, and its last caller was live.
2. **PO "Confirm" was rendered only when it would do nothing.** `canConfirm`
   gated on SUBMITTED, where `/confirm` is an explicit echo. Both predicates were
   inverted relative to their endpoints. One control now, gated on DRAFT.
3. **The DO list drawer's "Reopen" 409s every time.** `PATCH /:id/status` refuses
   ANY transition out of CANCELLED with `do_cancelled_final`
   (`delivery-orders-mfg.ts:5401`) — un-cancelling leaves the cancel's stock
   add-back standing while the re-deduct no-ops, inflating stock by the whole DO.
   It sat in the green PRIMARY slot on every cancelled row. Removed, not
   disabled: a control whose only outcome is a 409 is not a capability to
   explain, so the module states the real next step (raise a new DO) instead.

**The same slot no longer changes verb.** That was the other half of the
complaint — the operator had to read a status badge to learn what the green
button would do. The DO drawer held three verbs in one primary slot (Mark signed
/ Transfer / Reopen) and the PO phone bar held three (Submit / Transfer / Edit).
Each surface now has fixed slots: one "advance this document", one "produce the
next document", each keeping its meaning at every status.

**A desktop-only capability gap closed on the way.** A DRAFT delivery order could
not be advanced from the desktop AT ALL — `canMarkSigned` excluded DRAFT and
neither the detail page nor its editor writes a status, so a draft raised on the
desktop could only be moved by picking up a phone. The desktop now offers the
same "Confirm" (→ DISPATCHED) the mobile shell always had: same endpoint, same
body, same permission gate.

**The reason is TEXT, not a `title=`.** A tooltip needs a hover and says nothing
on a touch screen, so on the phone a disabled button would have explained itself
to nobody — reproducing the defect the rule exists to end. `NextStepNote` renders
the sentence and the control points at it with `aria-describedby`.

**What was deliberately NOT changed.** The mobile shell's finer driver ladder
keeps its extra rung: `IN_TRANSIT` is the departure marker
`MobileDeliveryPlanning.tsx:1280` writes for "On the way", so collapsing it into
the desktop's single jump would have deleted a step drivers use. Verified before
touching it. And the "Mark signed" control writes `DELIVERED`, not `SIGNED`
(`DeliveryOrderDetailV2.tsx:777`, `MfgDeliveryOrdersListV2.tsx:968`) — both
satisfy the invoice gate so the outcome is right; the label/target mismatch is
recorded in the module and left for its own change rather than folded in here.

**Why this kept happening.** Fixes in this tree get applied where the bug was
SEEN, not where the rule LIVES. `DateField` was built to force one date format
and reached 14 of 189 inputs; nothing errored, so nobody knew. The gate that
finished the date rule was a CI check, not diligence. These two modules are the
same shape of fix, and the tests pin the property that matters: every legal
status gets a real sentence out of them, and a status that cannot act must say
why. That is what stops the next surface from re-deriving a fifth answer.
