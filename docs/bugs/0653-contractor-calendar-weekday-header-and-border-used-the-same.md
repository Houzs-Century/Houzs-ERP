## Contractor calendar weekday header and border used the same green as the event bars [low]

<!-- area: Projects + PMS + fair report -->

**Symptom.** On the no-login contractor calendar (`/c/<token>`), the owner
reported that the day-of-week header row and the grid border were the same green
as the event bars, so a week full of events read as one solid green block with
no visible frame. His words: "color above at day and border need change cannot
same green color".

**Root cause (traced).** `frontend/src/pages/ContractorCalendar.tsx` painted
three unrelated things with the one brand colour `#0F766E`: the weekday header
row (`bg-[#0F766E]`), the outer grid border (`border-[#0F766E]/40`) and every
event bar (`bg-[#0F766E]`). Confirmed by grepping the file for `0F766E` — eleven
uses, three of them on those surfaces — and by rendering the page in Chromium
with mocked schedule data, which reproduced the screenshot.

**Fix.** Header row is now `bg-slate-800` (white text kept), the outer border
`border-slate-400`, cell lines `border-slate-200`, and out-of-month cells
`bg-slate-50`. Event bars keep their green so they are the only green inside
the grid. Re-rendered in Chromium after the change: header dark, frame grey,
bars green. Pure styling, so the existing `ContractorCalendar.test.tsx` (2 tests)
was run and passes; no colour assertion was added because a class-name test
would pin a palette, not a behaviour.

**Ref.** `claude/color-border-styling-64o5a1`, 2026-09-07.
