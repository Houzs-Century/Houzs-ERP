## Desktop DateField calendar tap-target had aria-hidden on a focusable input [low]

**Symptom.** Owner, 2026-09-10 (DevTools screenshot on the SO amendment
screen): Chrome console every time a date field was tapped in touch or
responsive mode —

    Blocked aria-hidden on an element because its descendant retained
    focus. The focus must not be hidden from assistive technology users.
    Avoid using aria-hidden on a focused element or its ancestor.
    Consider using the inert attribute instead, which will also prevent
    focus.

Named element: `<input class="_nativeIconTarget_tnntv_65"
data-touch-target="true" tabindex="-1" aria-hidden="true" min="…"
type="date">`.

Chrome IGNORES the offending `aria-hidden` (that is what "Blocked" means
here — the attribute is not respected while a descendant has focus), so
the calendar still opens and the operator can pick a date. But the
warning fires on every tap, clutters the console for anyone diagnosing
something else, and — more materially — the field IS the operator's
affordance for opening the wheel picker on a phone, so telling assistive
technology it is hidden is a lie about what the control does.

**Root cause (traced).** `frontend/src/vendor/scm/components/DateField.tsx:324`
stamped a static `aria-hidden` on the hidden native `<input type="date">`.
That was correct under the old fine-pointer-only geometry — the input sat
20px wide, transparent and `pointer-events: none` behind the calendar
button, so nobody ever focused it and hiding it from assistive tech
matched the fact that it was not an operator affordance. Since PR #3311
and #3317 (2026-09-08/09) the touch geometry is different: on a coarse
primary pointer the same input becomes the tap target — 44 × 44, overlaid
on the calendar icon, `pointer-events: auto` — and the native date
picker's internal shadow content (day/month/year spinners) legitimately
takes focus when the wheel opens. That focus lands INSIDE an aria-hidden
element, which is the exact anti-pattern the WAI-ARIA spec proscribes,
and Chrome now surfaces.

**Fix.** `DateField.tsx:324` — the attribute is now conditional. On
coarse pointer (touch, the layout where the input IS interactive) the
input carries `aria-label={ariaLabel ?? 'Open calendar'}` instead — a
truthful accessible name for the affordance the finger actually reaches.
On fine pointer (mouse, the layout where the input stays hidden behind
the button) the input keeps `aria-hidden` and stays out of the a11y tree
as before.

**Ref.** `fix/so-desktop-photo-and-date`, 2026-09-10.
