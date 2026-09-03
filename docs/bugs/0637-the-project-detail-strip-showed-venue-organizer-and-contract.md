## The project detail strip showed venue, organizer and contractor at rest but hid size and rental [low]

<!-- area: Projects + PMS + fair report -->

**Symptom.** Owner, 2026-09-03, on a project page: "change frontend without click
in edit — frontend only should have: start date / end date / rental / size.
other details keep hidden behind edit."

**Root cause (traced).** `ProjectSpecStrip` (frontend/src/pages/Projects.tsx)
splits its cells with `{editing && (<>…</>)}` blocks, and the split had drifted
from what the owner reads. At rest it rendered **Start, End, Booth, Venue,
Organizer and Contractor** — six cells in a five-column grid, State being the
only one already gated — while **Size · sqm** and **Rental · RM** sat INSIDE the
edit-only block. So the strip spent its whole width on text the owner does not
check and hid the two numbers they do, behind a click.

The comment above the grid still described the old intent ("View mode shows only
the key fields (Organizer, Start, End, Booth, Venue)"), which is how the drift
survived: the code matched its comment, and neither matched the owner.

**Fix.** The resting strip is now exactly **Start, End, Size, Rental**, in a
4-column grid. Booth, Venue, State, Organizer and Contractor moved into the
edit-only block, and Size and Rental moved out of it; Name and Add-to-Calendar
stay edit-only. Nothing was removed — Edit still reveals every field, and the
five moved cells lost their `editing ? … : …` branches because the block they
now live in only renders while editing.

`frontend/src/pages/projectDetailEdit.test.tsx` gained a third case that asserts
both halves (the four are present and the six are absent at rest; all of them
present after one click). PROVED RED on the unfixed tree.

**Ref.** feat/detail-strip-slim, 2026-09-03.
