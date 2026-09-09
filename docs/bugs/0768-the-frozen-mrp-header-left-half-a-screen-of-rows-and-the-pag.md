## The frozen MRP header left half a screen of rows and the page could not scroll [high]
<!-- area: Frontend + mobile -->
<!-- status: fixed -->

**Symptom.** Owner, 2026-09-09, hours after `#3430` shipped: *"为什么我的界面看得
到那么小而已呢？怎么会只有那么小的界面？"* — with a screenshot of the Stock Status
Report showing a short band of rows and a large empty area beneath it.

**Root cause (traced, measured on the live page).** `#3430` gave this page the
`useFrozenTableHeader` geometry. That geometry reserves everything from the
frozen composition's top down to the table under the pinned page header, caps the
row scroller at what is left of the viewport, and relies on PAGE SCROLL to carry
the composition up so the pre-table strip scrolls away first — its own comments
say so, and the earlier rounds it survived (*"看的list就很少了"*) are the same
failure.

On MRP the page cannot scroll, because the capped table is the only thing that
made it taller than the viewport. Measured on `erp.houzscentury.com/scm/mrp`,
sofa tab, in a 879px window, read out of the live DOM:

```
--page-header-offset      151px
box sticks at top         388px    (151 page header + 244px title / tabs / filters)
scroller max-height       443px    <- the rows the operator can see
content height          5,090px
main.scrollHeight           879    === main.clientHeight   -> no page scroll at all
dead space below the box  ~98px
```

So 388px is reserved permanently, the list is 443px of an 879px window, and the
runway spacer the design depends on cannot help: there is no deficit to give
back, the page simply never grows.

**Nothing caught it, and that is the second half of the cause.** `#3430`'s own
entry (`docs/bugs/0753`) states plainly that **no test asserts the freeze** — it
is layout measurement, jsdom returns zero for every rect it needs, and the
mechanism was verified against a HARNESS carrying the shipped declarations, not
against this page. The harness had page scroll. This page does not.

**Fix.** `useFrozenTableHeader(false)` in `Mrp.tsx` — the hook disarms, sets no
cap, renders no runway spacer, and `.tableScroll` is inert uncapped (its CSS
already says so), so the page returns to the plain flow it had this morning. The
owner was shown the four numbers above and asked with a picker; he chose
「先把 MRP 的表头固定关掉」.

The wiring, the `.tableScroll` box and `.stickyHead` are LEFT IN PLACE
deliberately. Re-freezing this page is a geometry fix — give the composition real
scroll runway, or mark a `data-freeze-anchor` below the filter row so only the
header strip is reserved — not a re-integration. `DataTable`'s own use of the
hook is untouched; every converted table keeps its frozen header.

**Verification.** The measurement above is the live page BEFORE this change, read
with the browser's own DOM (`getBoundingClientRect`, `getComputedStyle`,
`main.scrollHeight`), not from a harness. After the change the page renders in
plain flow: the hook returns `freezeBox === null`, so `boxStyle` and
`scrollStyle` are `undefined`, the spacer is not rendered, and the table takes
its content height — the state this page was in before `#3430`, which is what the
owner asked for. `npm --prefix frontend run test -- mrpUndated mrpSofaSupplier`
and the typecheck/build gates are the regression net for the wiring; **no test
asserts the freeze in either direction**, for the reason `0753` gives.

**Ref.** `fix/mrp-unfreeze-header`, 2026-09-09. Supersedes the MRP half of
`docs/bugs/0753`; the full measurement in context is the cutover audit
landing in PR #3476 (three owner questions, measured), section 2.
