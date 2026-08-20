## #2110 said every other floating menu was already portalled. Four were not [high]

<!-- area: Frontend + mobile -->

**Symptom.** Owner, after #2110 fixed the State dropdown: *"这个你要全系统看一下,
还有没有同类的问题。如果全部都有这个问题的话,都是要修复掉"*. On production's
**New Sales Order**, opening the **country dial code** next to Phone shows the
search box and **not one country**.

**Root cause, traced.** The same mechanism as #2110, in components that PR's own
body listed as already converted. `position: absolute` escapes layout FLOW but
not an ancestor's OVERFLOW clip, so a menu rendered as a sibling of its trigger
is sliced by the card it sits in. `#2110`'s note — *"Every other floating picker
in this repo … had already been converted"* — was true of the three it named and
false of the rest; this entry is what re-checking it found.

**PROVEN in the browser, on prod, not inferred.** Measured with
`getBoundingClientRect()` + `elementFromPoint()` through the Chrome tooling
against `erp.houzscentury.com`, 2026-08-15:

| site | measurement |
|---|---|
| `PhoneInput`, `/scm/sales-orders/new` | 287px panel, **247px cut** by `SalesOrderNew.module.css .card { overflow: hidden }`; **0 of 25** countries hit-testable |
| `SalesOrderNew` debtor list, same page | panel painted **49px ABOVE** the input (top 314 vs input bottom 363) at **1678px** wide against the input's 1200px, and the card left **130px** of room for a `max-height: 260px` list |
| `SearchableSelect` (City, Postcode), same page | portalled, so no ancestor clip — but the panel ran to y=890 in a **779px** viewport, and `position: fixed` puts that beyond any scroll |

The debtor list's misplacement has its own cause worth recording:
`SalesOrderNew.module.css` never had a `.field { position: relative }` (its
sibling `SalesOrderDetail.module.css` does, at `:208`), so the absolute list
resolved against the card body rather than the field. One bug hid inside the
other — the clip was visible, the wrong anchor read as "the list is just wide".

**Fix.** One shared implementation, `frontend/src/lib/anchoredPanel.ts`
(`measureAnchoredPanel` + `useAnchoredPanel` + `anchoredPanelStyle`): portal to
`<body>`, `position: fixed`, geometry from the trigger's rect, re-measured on
capture-phase `scroll` and on `resize`, flipped above when the room below cannot
hold the list, `max-height` clamped to the room actually available. Lifted out of
`StatePicker`, which now consumes it, so the pattern is shared rather than copied
five times. Converted: `PhoneInput` (≈20 call sites), `SalesOrderNew`,
`ConsignmentOrderNew` and `ConsignmentOrderDetail` debtor lists;
`SearchableSelect` and `SalesOrderDetail`'s already-portalled list gained the
flip and the clamp they were missing.

**The trap a portal introduces, and the guard for it.** A document-level
outside-click handler tests `rootRef.contains(e.target)`. Once the panel is in a
`<body>` portal it is no longer inside `rootRef` **in the DOM**, so a `mousedown`
on an option reads as "outside", closes the list, and the option unmounts before
its `click` can fire — the menu becomes unpickable. `PhoneInput` is the one
converted component with that handler; it now tests the panel too, and
`PhoneInput.test.tsx` asserts a mousedown inside the panel does not close it.

**Two things the hook does that the copies did not.** An unchanged measurement
returns the PREVIOUS object — a scroll gesture fires dozens of events and each
fresh object re-rendered the whole picker. And that same identity check is what
stops a caller with an unstable ref from spinning; both are pinned by tests.

**Verified.** `PhoneInput.test.tsx`'s 4 placement tests fail against
`origin/main`'s component and its 5 behaviour tests pass — the intended split.
In a browser: the pre-fix component in the real `.card` markup reproduced prod's
numbers exactly (`cutBottom: 247`, 0 of 25 countries), and the fixed one is
`parentIsBody: true`, `position: fixed`, no clippers, 8 countries visible and all
25 reachable; near the window bottom it flips above and stays on screen.

**What this did NOT cover.** Native `<select>` is not this bug — the browser
paints those above everything — and the ones on these forms were left alone.
`RowActionsMenu` on Project Maintenance, the eight `SplitDropdown` toolbar menus,
`Inventory`'s warehouse filter and mobile `SoSearchField` all carry the
anti-pattern; each was opened on a real page and measured `cutBottom: 0`, so
they were left alone rather than converted on suspicion. Four more —
`ServiceCases`' QC Result select, `Team`'s "Reports to" autocomplete and
`MailCenter/Inbox`'s bulk-label and label-colour menus — sit inside an ancestor
that a code read shows is `overflow-hidden`, but were **not** reproduced live and
are **not** fixed here. That is the open item.

**Ref.** PR #2223 · 2026-08-15 · follows #2110 (2026-08-13).
