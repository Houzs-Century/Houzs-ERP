## Date fields had no reachable calendar on a phone, and a date typed with unpadded day or month was silently lost [high]

**Symptom.** The owner, 2026-09-08, on his phone: 「我看我的 mobile version
processing date delivery date 或者全部 date 为什么没有 dropdown calender 是要
manual type 的」 — no date field on any screen offered a calendar, so every date
had to be typed. And typing was the trap: entering `7/9/2026` one character at a
time left `79/20/26` in the box, nothing was committed, and blur restored the
previous date with no border, no message and nothing announced. The operator
reads a lost entry as his own typo.

**Root cause (traced).** Two independent faults in
`frontend/src/vendor/scm/components/DateField.tsx`, both introduced by
`c4b51cbe5` (PR #2390, 2026-08-18, "One date format, one place that writes it"),
which correctly replaced native `<input type=date>` with a controlled day-first
text box.

1. *Unreachable picker.* The visible control is `type="text"` with
   `inputMode="numeric"`, so a tap raises the numeric keypad and no browser
   picker exists on it. The real native input is still rendered but
   `DateField.module.css` gives it `opacity: 0; pointer-events: none`, leaving
   the calendar ICON BUTTON as the only opener — 20 by 20 pixels, `tabIndex={-1}`.
   Apple and Google both specify a 44 pixel minimum touch target. Fine on a
   mouse; unusable with a finger.

2. *The mask ate the operator's separators.* `onChange` rebuilt the whole string
   from `raw.replace(/\D/g, '')` on every keystroke and re-inserted `/` at fixed
   index 2 and index 5. An unpadded day or month therefore shifted into the wrong
   slot. Traced per keystroke: `7` -> `7`, `7/` -> `7` (slash stripped), `7/9` ->
   `79`, and by the eighth keystroke `79/20/26`. `parseDmy` refuses that, so
   `onChange` never fired; `aria-invalid` was set only from the `invalid` PROP,
   so nothing painted and nothing announced; `onBlur` did `setEditing(null)`,
   which restored the old value. Padded input hid it, because `07/09/2026`
   re-lands on the mask's own slots — which is exactly why
   `DateField.mask.test.tsx` never saw it: it fires WHOLE padded strings, never a
   change event per character.

**Fix.**

- `separatorsAreMaskOwn()` — the mask now runs only when every `/` already sits
  where the mask itself would have written one. A separator the operator placed
  is left alone and handed to `parseDmy`, which already read `7/9/2026`
  correctly. `-` and `.` were never touched by the mask and still are not.
- `onBlur` no longer discards an unparseable draft. It keeps the text on screen,
  sets `aria-invalid`, and renders a `role="alert"` message ("Not a date — use
  dd/mm/yyyy") absolutely positioned so a field in error does not re-flow its
  row. Focus and a calendar pick both clear it.
- A tap on the text box calls the existing `openPicker()` when
  `matchMedia('(pointer: coarse)').matches`. Hung on CLICK, not FOCUS, so Tab
  and programmatic focus behave exactly as before — mouse and keyboard are
  untouched.
- The calendar button gets a 44 by 44 pixel hit area under
  `@media (pointer: coarse)`, grown with a transparent `::after` overlay rather
  than by setting width/height: a 44px-tall child would push the wrapper from
  ~30px to ~52px and re-flow every form row on every phone. The icon keeps its
  20px appearance.

**One fault the tests could not have found.** The error message shipped first as
plain red text on a transparent ground, floated below the field so it would not
re-flow the row. Loaded in Chromium it rendered directly ON TOP of the next
line's own text and neither was readable — the message that exists to stop a
silent failure was itself silent. It is now an opaque chip (paper background,
red border, small shadow) in the same position, still at zero layout cost. Found
by loading the component in a browser, which is the only thing that could have
found it.

**Proved RED on the unfixed tree.** The five per-keystroke cases in
`DateField.mask.test.tsx` were run against `HEAD`'s `DateField.tsx` and failed
with the reported string: `AssertionError: expected '79/20/26' to be '7/9/2026'`,
plus `'11/20/26'` for `1/1/2026`, `'31/32/026'` for `31/3/2026`, `'79/26'` for
`7/9/26`, and `''` for the half-typed `7/9`. `7-9-2026` passed before and after —
a dash was never eaten. Touch and blur-error behaviour is pinned by
`DateField.touch.test.tsx`.

**Still open, deliberately NOT fixed here.** `min` / `max` are wired only to the
hidden native input, so a date TYPED out of range bypasses them entirely and is
caught only server-side. Fixing it means deciding what an out-of-range typed date
should do — refuse, clamp, or warn — which is a product judgement, not a defect
with one right answer.

**Ref.** `fix/date-field-touch-picker`, 2026-09-08.
