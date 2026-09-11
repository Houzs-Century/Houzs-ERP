## The touch date picker called showPicker on an untappable input, so nothing opened on iOS [high]

**Symptom.** The owner, 2026-09-08, hours after PR #3300 deployed: 「尝试了 手机
还是看不到」 — on his iPhone, tapping a date field still did nothing. No calendar,
no wheel. On desktop Chrome the same build worked and he sent a screenshot of the
calendar open, which is what made it look shipped.

**Root cause (traced).** PR #3300 (`f4a98580f`) made the whole touch path a
scripted `showPicker()` call, fired from the visible text box's `onClick` when
`matchMedia('(pointer: coarse)')` matched. The element it fires that call at is
the native `<input type="date">`, which `DateField.module.css` renders as a
20-pixel-wide, `opacity: 0`, `pointer-events: none` strip behind the calendar
button. A picker that only ever opens because a script asked it to is a picker
that does not exist on an engine that declines the request.

Traced against the DEPLOYED artifacts, not the source, because the question was
what the owner's phone actually loaded. `assets3/DateField-SZqhYkY9.css` on
`erp.houzscentury.com` carries
`._nativeHidden_ql1dq_65{opacity:0;pointer-events:none;...width:20px...}`, and
`assets3/DateField-S6SazxoH.js` carries `onClick:()=>{l()&&I()}` where `I` is
`showPicker()`-then-`focus()+click()` and `l` is the coarse-pointer test. Both
match the tree at `f4a98580f`.

Then MEASURED on a real WebKit engine — Playwright `webkit 26.5`, iPhone 15
device profile, the actual `DateField` component built by Vite and driven with
`page.touchscreen.tap()` (a browser-dispatched tap, not a synthetic click). On
the shipped build:

```
nativeBox      : 20 x 28   (field is 122 x 28)   coversField: false
pointerEvents  : none
hit test at the left / middle of the field : INPUT[text]
after a real tap, document.activeElement   : INPUT[text]
```

The finger never reaches a date control at all; it lands on the numeric text
box, which is why the owner gets a keypad and no picker.

**One belief this refuted, recorded because it was the obvious story.** The
expected mechanism was "iOS has no `showPicker`, or it throws". On WebKit 26.5
`typeof native.showPicker === 'function'` is TRUE and calling it does not throw.
It simply does not engage the control — focus stays on the text input. So the
fault is not a missing API; it is that the entire touch path was delegated to an
API whose effect on this engine is nothing, against an element a user could not
have reached anyway.

**Fix.** Stop scripting the picker on touch and make the native control the tap
target itself. On a coarse pointer the native `<input type="date">` is given
`.nativeOverlay` — `inset: 0`, full width and height, `opacity: 0`,
`pointer-events: auto`, `z-index: 3`, `appearance: none` (load-bearing on iOS,
which otherwise keeps the input's intrinsic width) — so a real finger tap lands
on a real date input and the OS opens its own picker with no script in the path.
The `onClick` handler on the text box is gone. The masked day-first text stays
visible underneath, so the display is still ours and the OS-locale bug PR #2390
fixed does not return. Fine pointers keep `.nativeHidden` unchanged: the 20px
strip, the calendar button, `showPicker()`.

Measured on the same WebKit engine after the change, iPhone 15 profile:

```
nativeBox      : 122 x 28  (field is 122 x 28)   coversField: true
pointerEvents  : auto      data-touch-target: "true"
hit test at the left / middle / icon of the field : INPUT[date]
after a real tap, document.activeElement          : INPUT[date]
displayed text : 07/09/2026   (still the day-first mask)
```

And on the fine-pointer profile the two builds are IDENTICAL apart from the
build-generated CSS-module hash — same `.nativeHidden` class, same 20x28 box,
same `pointer-events: none`, same hit tests returning `INPUT[text]`, same
`showPicker()` route from the button. The desktop behaviour the owner confirmed
is untouched.

**What is still UNVERIFIED, and must not be read as verified.** Nobody ran this
on an iPhone. Playwright's WebKit is the WebKit engine but not the iOS port, and
it has no iOS date wheel to render, so no tool available here can observe the
wheel appearing. What was observed is the mechanism: the tap now reaches a
genuine, hit-testable, focusable `<input type="date">` instead of a transparent
strip that takes no pointer events, and the fix no longer depends on an API
whose effect on WebKit was measured to be nothing.

**Capability removed on purpose — SUPERSEDED the next day, 2026-09-09, by
`docs/bugs/0726-pr-3311-took-hand-typing-away-on-a-phone-the-date-input-cove.md`.**
The paragraph below reads the owner's complaint as "typing is the only way in,
so replace it". He meant "add the calendar, keep the typing" — 「可以保留手打」.
The full-field overlay is now a 44 by 44 target over the calendar icon only
(`.nativeIconTarget`): the icon opens the OS picker, the rest of the field
focuses the text box, and a phone has both. Read the rest of this paragraph as
what the trade WAS, not as current behaviour.

With the overlay covering the field, a phone
user can no longer tap into the text box to hand-type a date. Typing on a phone
was the thing the owner complained about (2026-09-08: 「是要 manual type 的」) and
it is the path that produced the `79/20/26` data loss in
`docs/bugs/0723-date-fields-had-no-reachable-calendar-on-a-phone-and-a-date.md`,
so the OS picker replacing it is the intent, not a side effect. Typing survives
everywhere it was already good: every fine pointer (mouse, trackpad, an iPad
with a keyboard case — `pointer: coarse` is the PRIMARY pointer, so none of
those match), a hardware keyboard tabbing into the box on any device, and a
VoiceOver activation, which targets the labelled text input directly rather than
hit-testing the overlay.

**Fix, pinned.** `DateField.touch.test.tsx` now asserts the RENDER rather than a
call: a coarse pointer puts an enabled native date input carrying
`data-touch-target` and `.nativeOverlay` over the field, a fine pointer gets
`.nativeHidden` and no marker, no `matchMedia` falls back to the fine-pointer
field, and `showPicker` is never called on a coarse pointer by any handler.
Proved RED against `f4a98580f`'s `DateField.tsx` + `DateField.module.css`:
`AssertionError: expected undefined to be 'true'` and `AssertionError: expected
"vi.fn()" to not be called at all, but actually been called 1 times`. The mask,
parse and blur-error tests from #3300 are unchanged and still pass.

**Reproducing the WebKit measurement.** `npx playwright install webkit` in
`frontend/`, build a one-file Vite page importing `DateField`, serve it, and
drive it with `webkit.launch()` + `devices['iPhone 15']`, reading
`document.elementFromPoint` at the field's centre and `document.activeElement`
after `page.touchscreen.tap()`. The probe was not committed — it is 40 lines and
needs no fixtures.

**Ref.** `fix/date-field-ios-picker`, 2026-09-08.
