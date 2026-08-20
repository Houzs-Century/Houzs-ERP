## A console was reported missing a seat height, which it cannot have [low]

**Symptom** - owner, 2026-08-11: *"divan only 没有 gap 的 你也可以看有些 sku 是没
有的"*. Three lines (`HC-PO-009553`, `HC-PO-000596`, `HC-SO-012736`) reported
`missing Seat Height` on a `-Console` piece.

**Root cause** - `missingVariantAxes` already exempts `gap` for DIVAN ONLY and
the whole base block for a divanless frame, but had no notion of a sofa piece
with no seat. A console is the table BETWEEN two seats. The AutoCount sketch
proves it rather than assuming it: on `PO-009553` both seat boxes carry a figure
(26" and 32") and the console box is deliberately blank.

**Fix** - `isSeatlessPiece`, matching `CONSOLE`/`CT` on the compartment suffix,
exempts `seatHeight`. Deliberately narrow: **STOOL is not exempt**, because a
stool is something you sit on and no line reports one missing - exempting it
would be a guess with no case behind it.

**Not changed, and worth a follow-up:** the app's own confirm gate
(`src/scm/shared/so-variant-rule.ts`) still asks an operator for a console's
seat height. Pre-existing, but it is the same rule and should move together.

**Lesson** - "the field is empty" and "the field does not apply" look identical
in a completeness count. Three of the remaining gaps this week were the check
asking for something the product does not have: a STOOL's compartment, and now a
console's seat.

**Ref** - fix/console-has-no-seat, 2026-08-11.
