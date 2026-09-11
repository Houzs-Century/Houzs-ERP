## The MRP table was the one list whose header never froze [low]
<!-- area: Frontend + mobile -->
<!-- status: fixed -->

**Symptom.** Owner, 2026-09-09: "MRP 需要freeze row title". Scrolling the Stock
Status Report lost the column header, so past the first screen a row's numbers
(Qty Needed / Stock / PO Outstanding / Shortage — four adjacent right-aligned
columns) had nothing naming them.

**Root cause (traced).** Not a broken rule — an unapplied one. The freeze was
built on 2026-07-24 to the owner's "每个table的header都要freeze", and it lives
inside `DataTable.tsx`. MRP is the one list page that does NOT use `<DataTable>`:
it keeps a hand-built Model -> Variant -> SO tree table (the CSS says so —
"MRP keeps its hand-built tree"), so it never inherited the behaviour and
nothing flagged the omission.

`position: sticky` on the header alone would not have worked either. `.tableWrap`
carried `overflow-x: auto` (added 2026-05-29 for "右边卡到了"), and a box that
is not `overflow: visible` on one axis computes `auto` on the other — so the
wrapper captured the vertical sticky context while never scrolling vertically,
and the header just scrolled away with the page. That is the exact trap
`DataTable`'s comment describes, which is why the fix is its geometry and not a
one-line CSS addition.

**Fix.** The geometry moved out of `DataTable.tsx` into
`frontend/src/components/useFrozenTableHeader.ts` UNCHANGED, and both surfaces
now drive it. MRP wires the four elements the hook expects: `.tableWrap` becomes
the bordered box that carries the sticky offset, a new `.tableScroll` inside it
is the vertical scrollport, `.stickyHead th` freezes to that scrollport's top,
and a runway spacer gives back the page scroll the height cap removes.

Two details specific to this page's hand-built table:

- The sticky selector is `.stickyHead th`, not `.table thead th`. The drilldown
  `.childTable` renders inside a `<td>` of the parent table, so the broad
  selector would stick those nested headers too and float them over their own
  rows.
- The rule under the header is `box-shadow: inset 0 -2px 0`, not `border-bottom`.
  `.table` is `border-collapse: collapse`, where a sticky cell's collapsed border
  belongs to the table's border grid and stops painting once the cell leaves its
  resting place.

**Verification.** jsdom cannot lay out, so the mechanism was measured in a real
browser against a harness carrying the shipped declarations verbatim (the same
DOM shape: pinned page header, pre-table strip, capped scroller, nested child
table). With the page scrolled 300px and the inner scroller at 600px:

```
boxStuckUnderPageHeader   true    (box top === 64, the page-header offset)
headerFrozenToScrollport  true    (header top === scrollport top)
childHeaderNotSticky      true    (drilldown header at -396, scrolled away)
horizontal scroll         1412 wide in 1216 — header tracks scrollLeft exactly
```

The existing suites are the regression net for the extraction:
`DataTable.test.tsx`, `DataTableLayoutSync.test.tsx`, `mrpUndated.test.tsx`,
`mrpSofaSupplier.test.tsx` — 66 tests, all passing. **Stated plainly: no test
asserts the freeze itself.** It is pure layout measurement, and jsdom returns
zero for every rect it depends on; a test written against that would pass on a
tree where the freeze does not work.

**Lesson.** A rule that lives inside one component is only a rule for that
component's users. "Every table's header freezes" held for every table that had
been converted, and the one that had not was invisible to it for six weeks.

**Ref.** `fix/mrp-sticky-header`, 2026-09-09.
