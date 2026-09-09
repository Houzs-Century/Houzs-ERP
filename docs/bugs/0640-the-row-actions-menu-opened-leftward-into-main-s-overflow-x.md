## The row actions menu opened leftward into main's overflow-x-hidden and was cut in half [medium]

<!-- area: Projects + PMS + fair report -->

**Symptom.** Owner, 2026-09-04, screenshot of Project Maintenance -> Brands:
*"once i click three dot it will open on left side and cant see fully"*. The
panel showed only its right-hand sliver — "…ker ON" and "…mently" — so the two
choices ("Show in picker", "Delete permanently") were unreadable and the
destructive one was the harder to identify.

**Root cause (traced).** `RowActionsMenu`'s panel is `absolute right-0`, i.e. it
grows LEFTWARD from the trigger, and it was `w-48` (192px). `Layout` renders
every page inside `<main class="… overflow-x-auto overflow-x-hidden">`, so
anything crossing main's left edge is CLIPPED rather than merely overflowing.
The picker rows in Project Maintenance put the trigger roughly 85px inside that
edge, which is less than the panel is wide — so ~110px of it was cut off. Not a
z-index problem and not the sidebar painting over it: the pixels were never
drawn.

**Fix.** The panel now measures at OPEN and picks the side with room. It walks
to the nearest ancestor that actually clips (`overflowX` hidden/auto/scroll/
overlay — the same ancestor-walk `PullToRefresh.findScrollAncestor` uses) rather
than assuming the viewport, because the viewport is NOT the boundary here: the
sidebar owns everything left of `<main>`. When `trigger.right - MENU_W` falls
short of that edge it renders `left-0` (opening rightward) and marks itself
`data-flipped="right"`. Width also trimmed 192 -> 176px and rows 8 -> 6px of
vertical padding, per the owner's "make it compact".

Measured at open, not at render, because a row can be scrolled or the sidebar
collapsed between mounts and a stale side is exactly the defect.

**Verified.** `RowActionsMenu.test.tsx` pins both directions and was proved RED
on the unfixed tree (`expected null to be 'right'`, 1 failed / 2 passed). In a
real browser, with the trigger placed inside a clipping ancestor at the same
geometry: `data-flipped="right"`, panel `[779, 955]` inside clip `[693, 1313]`,
`fullyVisible: true`, and the panel read back its complete text —
`"Show in picker | ON | Delete permanently"`.

Note for the next reader: the first version of that test passed for the WRONG
reason. jsdom reports every rect as zeroes, and zeroes flip, so a mis-targeted
rect stub made the flip case green regardless. The stub now targets the wrapper
by structure and the no-flip case is what catches it.

**Ref.** fix/row-menu-clipped-by-main, 2026-09-04.
