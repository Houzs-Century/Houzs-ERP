## The booth number was behind Edit on the project detail strip [low]

<!-- area: Projects + PMS + fair report -->

**Symptom.** Owner, 2026-09-09, on a project page: "pull out booth number at
frontend without click in edit — so frontend will have start date / end date /
size / booth number / rental."

**Root cause (traced).** Not a defect — a deliberate choice made six days
earlier that the owner has now reversed. `0637` slimmed the resting strip to
Start, End, Size, Rental and moved Booth into the edit-only block, on the owner's
instruction that day ("other details keep hidden behind edit"). Booth's
`SpecCell` therefore sat inside the second `{editing && (<>…</>)}` block in
`ProjectSpecStrip` (`frontend/src/pages/Projects.tsx`), alongside Venue, State,
Organizer and Contractor, so it rendered only after clicking Edit.

**Fix.** Booth's `SpecCell` moved out of that block to sit between Size and
Rental, giving a resting set of Start, End, Size, Booth, Rental. The grid is
`lg:grid-cols-5` at rest so all five fit one row, and stays `lg:grid-cols-4`
while editing, where the full field set renders. No read path was added:
`SpecTextField` already renders read-only text (`—` when empty) when `editing`
is false, and still patches `booth_no` from edit mode.

`frontend/src/pages/projectDetailEdit.test.tsx`'s resting-set case moved with
it — Booth joins the shown list, leaves the hidden list, and the fixture's booth
value (`A12`) is asserted to render at rest, which is the half that would catch a
label shown with no value. PROVED RED on the unfixed tree: with Booth still in
the edit-only block the case fails on `Booth must be on the resting strip`.

**Ref.** feat/detail-strip-slim, 2026-09-09. Reverses the Booth half of
`docs/bugs/0637-the-project-detail-strip-showed-venue-organizer-and-contract.md`;
Venue, State, Organizer and Contractor stay behind Edit as that entry left them.
