## The purchase text and the sales order described different sofas, and nothing could say which wins [low]

**Symptom.** `HC-PO-009587` is the last of five mislabelled sofa purchase orders
and the only one the repair still refuses. Measured on prod:

```
HC-PO-009587 (PO-009587) 9058-1S <- HOK-5536 SOFA
  — the purchase text decodes to 9058-2A(LHF)+9058-L(RHF)
    where HC-SO-010209 holds 9058-1A(LHF)+9058-1NA+9058-L(RHF)
```

Two pieces against three. The refusal is correct on its own terms: writing one
side's build onto the other on a guess is how a build lands on the wrong line.

**What the drawing says.** Extracted from the live book (DtlKey 872577): three
boxes at 26", each its OWN outline — a hatched arm block on the far left, a plain
box, and a longer box with a hatched arm on its right. **Three outlines is three
pieces**, so the purchase text's "two" is the wrong count and the sales order's
three is right. That much needed no ruling.

The HANDEDNESS did. Read under the mirror rule
(`sofa-handedness-is-mirrored`) the chaise comes out LEFT-handed —
`L(LHF)+1NA+1A(RHF)` — the exact mirror of what the sales order holds. Sent the
photograph, the owner answered: **「销售单的对」**.

**Root cause.** There was no way to say so. `planMislabelledBuild` had one answer
for a disagreement — refuse — and the owner's standing rule has another:
「如果你的答案不准，那你就跟 sales order」 (2026-09-09,
`po-follows-the-sales-order`). The rule existed; the code could not express it.

**Fix.** `followSalesOrder`, and it is deliberately NOT a general licence:

- **required, never inherited by silence** — unset, the disagreement is refused
  exactly as before;
- meant to be paired with `DOC=`, so it reaches the document it was decided for
  and no other;
- it REPORTS what it overrode — `plan.overrode` is set only when the switch
  actually changed the answer, and the runner prints it. A switch that silently
  does something does not belong in a repair that writes production documents.

**Why it must stay per-document, stated plainly: a sales order can itself be
wrong, and one was.** `HC-SO-010955` held the exact MIRROR of the owner's own
answer for the same build (`docs/bugs/0736`), and that document is in this very
batch — it is the sales order behind `HC-PO-009679`. "Follow the sales order"
as a blanket sweep would have copied a mirrored build onto a purchase order.

Four cases pinned in `tests/mislabelledSofaPoPlan.test.mjs`, including that an
AGREEING pair reports no override at all, and that the switch opens no other gate
— a delivered build still refuses with `followSalesOrder: true`. 32 tests pass.

**Ref.** PR for `fix/mislabelled-po-follow-so`, 2026-09-09. Follows
`docs/bugs/0750`, `0753`.
