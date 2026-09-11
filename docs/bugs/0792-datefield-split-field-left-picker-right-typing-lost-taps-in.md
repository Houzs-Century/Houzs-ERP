## DateField: split-field left-picker/right-typing lost taps in the wrong half [medium]

**Symptom.** Owner, 2026-09-10 after the 「可以保留手打」 split-field
rollout: 「有时可以有时不行 你让我知道 怎么点开？」 On coarse pointer the
calendar icon and its 44 × 44 tap target sat on the LEFT of the field
(after PR #3546 flipped the row to keep the popup inside the viewport)
and the read-only text box took the right side, so a tap that landed
past the 44 px zone raised the keyboard-style focus instead of opening
the wheel picker — an outcome the operator read as 「calender 有时能
点到，有时点不到」.

Then, on the same page: 「remove 掉可以打字 force 只能用 calender」 +
「calender 点一下开点一下关 就这样简单」 + 「全部 calender 也是全套
系统」. The split field is retired.

**Root cause (traced).** The tap-target split from the 2026-09-09
「可以保留手打」 rollout gave up on 「wherever you tap = opens picker」
in exchange for keeping the keyboard reachable. The confusion between
the two halves is inherent to a split — even a well-drawn one — and the
new ruling supersedes: no keyboard anywhere, tap-anywhere-opens
everywhere.

**Fix.** `frontend/src/vendor/scm/components/DateField.tsx` +
`DateField.module.css`:

- Visible text box is `readOnly` on every pointer. No mask, no
  onChange/onFocus/onBlur draft state, no `draftInvalid` flag, no
  inline error chip. The box exists purely as the DD/MM/YYYY display.
- The wrap has `onClick={openPicker}`, so a click anywhere on the field
  opens the OS date picker via `showPicker()` (Chrome 99+, Edge,
  Firefox 101+; falls back to focus()+click() otherwise).
- On coarse pointer the native `<input type="date">` covers the WHOLE
  field via `.nativeIconTarget { inset: 0 }` — the tap lands on a real,
  hit-testable date control and iOS raises its wheel with no script in
  the path (the `showPicker` no-op WebKit fix that spawned this whole
  arc still applies).
- The calendar icon button stays as a visual affordance and calls
  `openPicker` itself with `e.stopPropagation()` so the wrap's onClick
  does not double-fire.
- CSS on coarse drops the `flex-direction: row-reverse` from PR #3546 —
  the "put icon left so popup opens right into the form" workaround is
  no longer needed once the whole field is the target and the popup can
  anchor from anywhere on it.

Tests rewritten to reflect the new contract: the visible box is
`readOnly` on both pointers; a click on the field opens the picker
(fine); the native input carries `.nativeIconTarget` + `data-touch-target`
+ `aria-label="Choose date"` on coarse; a calendar pick still fires
`onChange` and a next-tick `onBlur` for blur-committing hosts.

**Ref.** `fix/datefield-force-calendar`, 2026-09-10.
