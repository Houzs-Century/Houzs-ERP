## Mobile SO date picker did not open on iOS Safari — appearance:none stripped the tap-to-open [high]

**Symptom.** Owner, 2026-09-10, on the mobile New/Edit Sales Order form
(`MobileNewSO`): *"mobile version 很多人 complain 那个 calendar 点不出来，要
manually typing"*. Users tapping the date fields (Processing Date, Delivery
Date, per-line Delivery date, payment Date) got focus and, in some cases, the
alphanumeric keyboard — but no OS wheel picker. The date could only be entered
by typing `dd/mm/yyyy` by hand, which is slow on a phone and easy to get wrong.
Present since 2026-07-03 on iPhone / iOS Safari; the fields on desktop and on
Chromium mobile emulation still opened a calendar, which is why routine
developer testing never surfaced it.

**Root cause (traced).** All four date fields on the mobile SO form are raw
`<input type="date">` under the class `fld-i` (`frontend/src/mobile/MobileNewSO.tsx`
lines 2272, 2275, 2998, 3574). Two rules in `frontend/src/mobile/mobile.css`
were stamping `-webkit-appearance: none` on them:

- `.hz-m input[type="date"].fld-i` — added 2026-08-03 to fix an empty-input
  visual collapse (owner sighting: line 1 dated and line 2 blank rendered as
  visibly different controls on the same row);
- `.hz-m input[type="date"], input[type="datetime-local"], input[type="time"]`
  — added 2026-07-03 (`63b7cbab3c`) to normalise oversized native controls to
  the `.fld-i` height.

Both rules trade appearance for consistent sizing. On WebKit that trade breaks
the picker: with `-webkit-appearance: none` on `input[type="date"]`, iOS Safari
takes focus on tap but no longer opens the wheel picker, and `showPicker()` on
the same element is defined in the DOM but a no-op (a WebKit limitation this
memory has recorded before). So the field appears interactive and does nothing
useful. Chromium mobile emulation still shows the picker (Blink honours a click
on an appearance-stripped date input), which is exactly the false-positive path
the `touch-behaviour-needs-webkit-not-chromium` note calls out.

Two other date surfaces are NOT affected and were not touched by this fix:

- Desktop-wide `DateField` (`frontend/src/vendor/scm/components/DateField.tsx`)
  wraps a visible text input plus a hidden native `<input type=date>` and drives
  the picker via `showPicker()` on the hidden input. That opens on Chromium
  desktop and is separately broken on iOS Safari for the same underlying
  `showPicker` limitation; MobileNewSO does not use it, so the mobile complaint
  is fully resolved by the CSS-only change here. Filed as a follow-up.
- The mobile app's other date inputs (SO detail, calendar, service case) share
  the same `.fld-i` class and inherit the fix automatically.

**Fix.** `frontend/src/mobile/mobile.css` — drop `-webkit-appearance: none` /
`appearance: none` from the two date-input rules (kept every other property so
the sizing/padding/pseudo-element normalisation still applies). The empty-input
collapse fix from 2026-08-03 stays: `::-webkit-date-and-time-value` and
`::-webkit-calendar-picker-indicator` respond to CSS regardless of the
appearance value, so pinning `min-height: 1.3em` on the shadow value still keeps
an empty date input the same height as its filled sibling. Comments beside both
rules now record why appearance is deliberately NOT stripped, so the next
sighting of a slightly-taller empty date input does not re-introduce the
regression. UNTESTED on real iOS Safari from this session (no iPhone to hand);
proven RED on the unfixed tree by observation of the code path + the recorded
WebKit behaviour, and proven GREEN in Chromium mobile emulation. Owner needs to
confirm on his own iPhone before we call it closed.

**Ref.** `fix/mobile-so-date-tap`, 2026-09-10.
