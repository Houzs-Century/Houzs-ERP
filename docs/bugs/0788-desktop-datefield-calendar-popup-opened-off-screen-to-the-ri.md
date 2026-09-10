## Desktop DateField calendar popup opened off-screen to the right on narrow viewports [medium]

**Symptom.** Owner, 2026-09-10 (DevTools responsive mode at 344 × 704 on the
SO amendment page): 「会不会是 calender 已经在 screen 的外面了的问题？」 The
screenshot showed the browser's September 2026 calendar dropdown DID open
when the calendar icon was tapped, but Chromium anchored it to the right
edge of the field and the panel spilled OUTSIDE the form column — half of
the calendar sat over the DevTools sidebar and was un-reachable. Read as
"点了 calender 没反应" by anyone who could not see the popup was landing
past the visible viewport.

**Root cause (traced).** On coarse pointer, the DateField's tap target for
the native `<input type="date">` is `.nativeIconTarget` positioned at
`right: 0; width: 44px` inside `.wrap`
(`frontend/src/vendor/scm/components/DateField.module.css:113-134`). Chrome
positions the OS calendar popup relative to the trigger element's viewport
rect — anchored to that 44 px strip on the RIGHT of the field, the panel
extends further right and down. In a 344 px window there is no room to
the right, and Chromium does not auto-flip a date-input popup the way it
flips select dropdowns, so the panel renders past the viewport instead.
iOS Safari is unaffected because its date input opens a bottom-sheet
wheel picker rather than an anchored popup — the bite is Chromium
(Android Chrome + desktop DevTools mobile emulation), which is the QA
path this repo uses to check narrow layouts.

**Fix.** `DateField.module.css` — on `@media (pointer: coarse)` only, flip
the field's flex direction to `row-reverse` and move `.nativeIconTarget`
from `right: 0` to `left: 0`. The icon and native tap-target both sit on
the LEFT of the field; taps still open the OS picker; Chromium now
anchors the popup from the left edge of the field and opens rightward
into the form column. Fine pointer (mouse) layout is untouched — the
icon stays on the right where the design puts it, and desktop popups
have never had a room problem there. The text box on touch is now on the
right side of the wrap and still hand-typable — the split-field trade-off
from PR #3317 (「可以保留手打」) is preserved, just mirrored.

**Ref.** `fix/so-desktop-photo-and-date`, 2026-09-10.
