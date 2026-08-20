## Mobile PMS: "Stock In Transfer Record" stayed pinned full-width after the Defect List split, stranding "Dismantle Image" alone in its row [low]

<!-- area: Projects + PMS + fair report -->

**白话.** 手机版专案的「Setup & Dismantle documents」是两栏排的图砖。之前砖是 7 块，
单数，最后一块「Stock In Transfer Record」落单，所以老板 7 月 23 号叫把它拉成整行。
7 月 29 号「Defect List」被拆成 Setup 和 Dismantle 两块，砖变成 8 块——双数了，
但那条整行的设定没跟着改，结果换成倒数第二块「Dismantle Image」自己占半行、旁边空一格。
现在把整行设定拿掉，8 块刚好排成四行两栏。

**Symptom.** In the mobile project detail's `Setup & Dismantle documents` card
(a `gridTemplateColumns: "1fr 1fr"` grid), `Dismantle Image` sat alone in its row
with an empty half-row gap beside it, and `Stock In Transfer Record` sat below it
as a full-width tile.

**Root cause (traced by counting the array on `origin/main`, not guessed).**
The `mgmtSdTiles` array in `frontend/src/mobile/MobilePMS.tsx` carried
`fullWidth: true, mediaH: 108` on its last entry. That flag was correct when it
was added, and the comment above it said why: *"Owner 2026-07-23: full-width
('make it big') — the odd 7th tile was dangling half-width at the bottom of the
grid."* At that point the array held **7** tiles. The owner's 2026-07-29 Defect
List split (`Defect List` -> `Defect Item Setup` + `Defect Item Dismantle`) added
an eighth. `fullWidth` renders as `gridColumn: "1 / -1"`, so against an EVEN
count it stops curing the dangle and starts causing one — the 7th tile is now the
one left alone. The flag outlived the condition it was written for, and nothing
tied the two changes together.

**Fix.** Drop `fullWidth` / `mediaH` from the `Stock In Transfer Record` entry so
the 8 tiles lay out as four clean rows of two, and replace the stale 2026-07-23
comment with one recording why the earlier decision no longer applies — so the
next reader does not re-add the flag on the strength of a comment describing a
7-tile grid that no longer exists.

**Desktop twin: none needed, checked.** Tile width is not a concept the desktop
surface expresses. `frontend/src/pages/Projects.tsx` renders each checklist
document as one uniform row of its `DocumentTable`. Grepped over
`frontend/src`, the identifiers this change depends on — `DocTile` and `mediaH` —
resolve to a single file, `frontend/src/mobile/MobilePMS.tsx`. `fullWidth` does
occur in `Projects.tsx`, but as the design-system `Button` / `DateField` prop:
same word, unrelated concept. "Stock In Transfer Record" reaches desktop only as
a `REVIEWABLE_TITLES` member and a `PROJECT_STAGES` title, neither carrying
layout.

**Lesson.** A layout flag whose justification is a COUNT is a fact with an expiry
date, exactly as CLAUDE.md says of a number in a comment. It should have been
derived from the array length rather than pinned by hand; left pinned, it
inverted its own purpose the day the count changed.

**Ref.** `fix/pair-stockin-tile`, PR #2347, 2026-08-20.
