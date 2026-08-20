## The State dropdown was cut off after two or three states on every address form [medium]

**Symptom** - the owner, on the Sales Order detail address block: "我的 state 的那个
UI 也是被直接斩断了,然后很难、很辛苦". Opening State showed MALAYSIA, Johor, Kedah
and then nothing - the rest of the 16 states existed but were sliced off at the
card's edge, so picking anything past Kedah meant fighting a list you could not
see.

**Root cause (traced to the declaration)** - `StatePicker.module.css` had
`.panel { position: absolute; top: calc(100% + 4px); z-index: 60 }` inside
`.comboWrap { position: relative }`, i.e. the menu was a normal child of the
field. `position: absolute` escapes layout flow, but it does NOT escape an
ancestor's `overflow` clip - any card, drawer or section between the field and
the viewport that sets `overflow: hidden`/`auto` clips the menu at its own box,
and the SO detail's address card is only ~150px tall below the field. z-index
was never the problem, so the earlier bump to 60 could not have helped. The
component had no `createPortal`, no `position: fixed` and no
`getBoundingClientRect` anywhere - every other picker in this codebase
(`SoLineCard`'s SKU/fabric menus, `SearchableSelect`) had already been converted
to a body portal for exactly this reason, and this one was missed.

**Fix** - the panel is `createPortal(..., document.body)` with
`position: fixed`, and its top/bottom/left/width/max-height are measured from
the input's `getBoundingClientRect()`. A `useLayoutEffect` re-measures on
`scroll` in the CAPTURE phase (the field usually sits in a scrolling card or
drawer, and those scroll events never reach `window` on the bubble path) and on
`resize`, removing both listeners when the list closes or the component
unmounts. When the space below the input cannot hold the list and the space
above holds more, the panel anchors by its `bottom` edge and grows upward
instead. Behaviour is untouched: options still commit on `onMouseDown` +
`preventDefault` so the pick lands before the input blurs, `onBlur` still
closes, and Escape/arrows/Enter are unchanged - a portal moves the DOM node but
React events still propagate along the REACT tree, so hosts that close on a
click in their own subtree (the Warehouse drawer's backdrop) behave as before.
Mobile is untouched: it passes `compact`, which is a native `<select>`.

**Verified** - reproduced in an isolated harness (a `overflow: hidden` card,
the shape of the real address block): pre-fix, exactly two states rendered;
post-fix the full 280px scrollable list paints over the card edge, flips above
the input near the viewport bottom, and picking still reports
`("Penang", "Malaysia")`. 13 new tests in `StatePicker.test.tsx`; the 7
placement ones fail on the pre-fix tree.

**Lesson** - **`position: absolute` is not an escape hatch from `overflow`; only
leaving the subtree is.** Three menus in this repo were portalled one at a time,
each as its own bug report, because the fix was applied to the component that
was complained about rather than to the class. When a shared control is
converted, grep for its siblings (`grep -L createPortal` over the components
that render a floating panel) before closing the ticket.

**Ref** - `fix/state-picker-portal`, 2026-08-13
