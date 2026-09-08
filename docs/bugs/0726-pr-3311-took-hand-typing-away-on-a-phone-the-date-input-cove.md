## PR 3311 took hand-typing away on a phone: the date input covered the whole field [high]

**Symptom.** The owner, 2026-09-09, after PR #3311 shipped: 「可以保留手打」 —
keep hand-typing. On a phone there was no longer any way to type a date. Tapping
anywhere in a date field opened the OS picker and nothing else; the masked text
box was visible, showed the right day-first date, and could not be reached by a
finger at all.

**Root cause (traced).** #3311 fixed a real fault — #3300 had scripted
`showPicker()` at a 20px `pointer-events: none` strip, which Chrome honours and
iOS Safari ignores, so the picker opened on the owner's desktop and did nothing
on his iPhone
(`docs/bugs/0725-the-touch-date-picker-called-showpicker-on-an-untappable-inp.md`).
Its fix was to make the native `<input type="date">` the element the finger
actually lands on. The spelling chosen was `.nativeOverlay { inset: 0 }` in
`frontend/src/vendor/scm/components/DateField.module.css` — the date input
stretched over the ENTIRE field at `z-index: 3` with `pointer-events: auto`.
That is one element too many: the text box underneath was then unreachable at
every point of the field, so the keyboard could never be raised.

Measured, not inferred. Playwright WebKit 26.5, iPhone 15 device profile, the
real component served by Vite and driven with `page.touchscreen.tap()`, on
`origin/main` at `c245211b3`:

```
nativeBox 122 x 28  (field 124 x 30)   class .nativeOverlay   pointer-events auto
elementFromPoint  field centre / left edge / icon  -> INPUT[type=date] .nativeOverlay
activeElement after a real tap, all three points   -> INPUT[type=date] .nativeOverlay
typing a date after tapping the field body         -> NOT POSSIBLE, the tap never focuses the text box
```

The entry was written down as a deliberate trade at the time ("Capability removed
on purpose", in 0725) on the reading that the owner's complaint was about typing
being the ONLY way in. He wanted the calendar ADDED, not the keyboard removed.

**Fix.** Split the field rather than choosing between the two.
`.nativeOverlay` is replaced by `.nativeIconTarget`: the same transparent,
`pointer-events: auto`, `z-index: 3` native date input, confined to a 44 by 44
box at the right-hand end of the field, over the calendar icon
(`right: 0; top: 50%; transform: translateY(-50%)`). Everything left of it is
the masked text input again.

- The picker path still does NOT script anything. `showPicker()` stays the
  mouse-only route from the calendar button; on a coarse pointer the finger
  lands on the date input itself, which is the whole reason #3311 existed. That
  constraint is load-bearing: on WebKit 26.5 `showPicker` EXISTS and does not
  throw and engages nothing (measured in 0725), so a scripted picker is not a
  picker.
- 44 by 44 is reached by overflowing the ~30px field vertically, exactly as the
  `.iconBtn::after` hit area from #3300 already does, so the field height does
  not move: measured 30px before and 30px after, on both pointers. `right: 0`
  keeps the horizontal overflow at zero, so the target cannot steal a tap from
  the control beside it.
- `min-width: 0` joins `appearance: none` as load-bearing on iOS. Without them
  Safari keeps a date input's intrinsic width, and here that would spill the
  target back leftwards across the text box and re-create the bug being fixed.
- The separator fix from #3300 (`separatorsAreMaskOwn`) is untouched, and is now
  exercised on a phone again rather than only on a desktop.

Measured on the same engine and profile after the change:

```
nativeBox 44 x 44  (field 124 x 30)    class .nativeIconTarget   pointer-events auto
elementFromPoint  field centre / left edge  -> INPUT[type=text]  .textInput
elementFromPoint  calendar icon             -> INPUT[type=date]  .nativeIconTarget
activeElement after a real tap, centre/left -> INPUT[type=text]  .textInput
activeElement after a real tap, icon        -> INPUT[type=date]  .nativeIconTarget
typing 7/9/2026 per keystroke after a tap on the field body
                 -> box shows "7/9/2026", committed ISO "2026-09-07"
```

Desktop non-regression proved the way #3311 proved it: the whole fine-pointer
probe block, before and after, is byte-identical once the build-generated
CSS-module hash is normalised — same `.nativeHidden`, same 20 x 28 box, same
`pointer-events: none`, same hit tests, same `showPicker()` route from the
button, same typing result.

**A measurement trap this probe walked into first, recorded because it would
have passed a broken build.** Playwright's WebKit does NOT implement
`<input type="date">`: `document.createElement('input').type = 'date'` reads
back as `"text"` there. An element identified by `input.type` therefore labels
the native date input "INPUT[text]", which is indistinguishable from the masked
text box — the first run of this probe reported the icon hit as `INPUT[text]`
and looked like a failure of the fix when the fix was working. Elements are now
identified by the `type` ATTRIBUTE plus the CSS-module class. Anyone re-running
this must do the same.

**Pinned.** `DateField.touch.test.tsx` gains "and leaves the text box on a
coarse pointer — hand-typing survives": a coarse render must carry
`.nativeIconTarget` and NOT `.nativeOverlay`, the masked box must still be an
enabled, non-readonly `type="text"` input, and `7/9/2026` typed into it one
keystroke at a time must commit `2026-09-07`. Its class assertions are RED
against `c245211b3` by construction (the class did not exist). Its TYPING half
is deliberately not claimed as red: jsdom computes no layout, so the overlay
that made typing impossible in a browser is invisible to it and the same
keystrokes pass on the unfixed tree. The layout half of this bug is only
observable in a real engine, which is what the WebKit table above is for — the
unit test guards the render contract, not the geometry.

**What is UNVERIFIED, and must not be read as verified.** Nobody ran this on an
iPhone. Playwright's WebKit is the WebKit engine but not the iOS port, and (see
the trap above) it does not implement `type="date"` at all, so it renders no
date wheel and no tool available here can observe one appearing. What IS
observed is the mechanism: on a coarse pointer a real tap on the icon reaches a
hit-testable, focusable element carrying `type="date"`, a real tap on the field
body reaches and focuses the masked text box, and a date typed there commits.

**Ref.** `feat/date-field-touch-typing`, 2026-09-09.
