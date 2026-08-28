## A sofa built in the ERP listed its modules in whatever order somebody typed [medium]

**Symptom.** A printed Purchase Order drew the right-hand chaise on the LEFT.
The owner, 2026-08-28: 「排版都要从L开始啊 Left to right」.

**Root cause, and the drawing was not at fault.** `buildDefaultSofaCells` tiles
modules LEFT→RIGHT **in the given order** and says so in its own header. The
order it is given is the order the LINES happen to sit on the document — whatever
the conversion or the typist produced. A PO listing `L(RHF)` before `2A(LHF)`
drew exactly that. The drawing was faithful to its input; the input was wrong
about the sofa.

**Why the existing sorter could not help.** `orderSofaCellsLeftToRight` sorts by
real x/y and DELIBERATELY keeps the stored order when there are no coordinates —
it refuses to guess. That is correct for a POS build, where a customer placed the
furniture. It leaves one case unanswered: **a sofa built in the ERP (SO New /
Maintenance) never had geometry at all**, so it always took the give-up branch.

**The owner named the rule, and corrected my first version of it.** I built it
geometry-first, handedness as a fallback. He replied: 「我们是看后面的 LHF RHF 啊
这才是方向」 — the suffix IS the direction. So handedness decides first and
geometry only breaks ties WITHIN one hand, where the codes say nothing.

They normally agree — the configurator decomposes a sofa as `2A(LHF) + L(RHF)`
laid out in that order — so nothing changes for an ordinary POS build. Where they
can disagree is a customer who deliberately placed an `(RHF)` piece on the left:
the LINES then list by handedness while the PLAN still draws the real placement,
because the plan is drawn from x/y. That mismatch is the owner's call, made
knowingly, and is written down here rather than discovered later.

**Fix = `orderSofaCellsForNewLines`, and it is a SEPARATE function on purpose.**
`orderSofaCellsLeftToRight` is called at DISPLAY time as well (`so-line-display`,
the label builder), so teaching it to reorder would silently re-sequence every
EXISTING order's lines the next time anyone opened one. The owner drew that line
himself: 「只针对新的order生效 旧的就不理了」. The new order is used at LINE
CREATION only (`so-sofa-split`), and a test asserts the display path never
imports it.

**Also: the plan's heading was a note to ourselves.** It read `Sofa layout —
front faces TV (orientation / LHF·RHF)`; the owner flagged it (「这个字眼也是奇
怪？」). A supplier reads this document, and needs the two facts the picture
depends on: it is a plan view, and the front faces the TV. LHF/RHF still print in
every line's own description, where they identify a part rather than explain a
convention.

**Checked RED:** pointing the split back at the geometry-only sorter fails the
boundary test.

**Ref.** fix/new-sofa-lines-are-ordered-left-to-right, 2026-08-28.
