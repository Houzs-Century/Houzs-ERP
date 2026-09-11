## An arm measurement was read as the seat height, so three purchase lines said a 12-inch sofa [medium]

**Symptom.** The whole-flow audit (run 34607649126) reported seven axis values
where a sales order and its purchase order disagree. Five are one document's
`32 vs 30`; the other two are `HC-SO-012046` → `HC-PO-009630`, **seat height 32
on the sales order against 12 on the purchase order**. A sofa seat in this
catalogue is 24-35 inches. Twelve is not a seat.

**Root cause (traced to the character).** The supplier states the arm on its own
segment:

    leg:1inch / Nylon Fabric; OTHER: ARM 12"

`parseSofa`'s size reader takes ANY two-digit number carrying an inch mark,
anywhere in the text — `/(\d{2})\s*(?:['"]{1,2}\s*inch(?:es)?\b|"|''|…)/` — with
no regard for the word in front of it. So the 12 in `ARM 12"` became the SEAT on
all three lines of that purchase order. Reproduced directly:
`parseSofa('OTHER: ARM 10"', '5535')` returned `size: '10'`.

**Blast radius, measured rather than feared.** Of the 2026-09-11 supplier export,
**3 sofa rows state an arm measurement and all 3 are on PO-009630**; and across
company 1, **exactly 3 sofa purchase lines carry a seat height under 20 inches** —
the same three. Nothing else in the system was affected.

**Fix.** The arm measurement is blanked before the size is read, in the same shape
and the same place as the `NNN x NNN` blanking directly above it, which exists for
the same class of mistake. `d2raw` still carries the text, so the specials sweep
keeps the arm instruction — the information is not lost, it just stops being
mistaken for the seat. Four cases are pinned in `tests/parseSofaGrammar.test.ts`,
including the one that must still work: a real seat stated BESIDE an arm
(`ARM 12" / 32 inch` reads 32).

**The three data rows are NOT repaired here, deliberately.** They sit on
`HC-PO-009630`, whose goods are received and whose sales order `HC-SO-012046` is
one of the two documents already waiting on the owner's stock-adjustment decision
(handoff §10e). Changing a seat height moves the line's inventory bucket, so it
belongs to that decision and that tool, not to a decoder fix.

**A note on how this was nearly missed twice.** The first two attempts to write
the blanking line put a literal BACKSPACE into the source: `\b` in a Python
replacement string is a control character, not the regex word-boundary, so the
pattern silently required a byte that never appears and the fix "landed" while
changing nothing. The tell was that the unit check passed in isolation and failed
in the module — the same shape as `docs/bugs/0818`'s matcher. Both times the file
was re-read and the bytes inspected (`JSON.stringify` of the line) rather than the
rendered text.

**Ref.** fix/arm-not-seat, 2026-09-11.
