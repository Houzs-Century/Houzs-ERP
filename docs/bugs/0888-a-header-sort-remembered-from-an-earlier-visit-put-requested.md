## A header sort remembered from an earlier visit put Requested at the bottom of the amendment queues [low]

<!-- area: Sales orders + pricing -->

**Symptom.** Owner, 2026-09-14, the afternoon after #3814 shipped "amendment
queues open Requested-first": 「SO / PO amendment - requested request需要Default在
上面」. His screenshot of the Sales Order Amendment queue shows the Status header
reading "↓" and the REQUESTED chip selected.

**Root cause (traced).** #3814 passed the Requested-first comparator as DataGrid's
`defaultSort`, which DataGrid applies only while `layout.sort` is null
(`frontend/src/vendor/scm/components/DataGrid.tsx`, the `sortedRows` memo). A
header click writes `layout.sort` through `writeDataGridLayout` into the grid's
saved layout, and the next mount reads it back — so anyone who had ever clicked
a header opened the queue in THAT order. Status clicked twice is descending, and
descending bucket rank is Rejected, Approved, Requested: Requested at the bottom
of All. Reproduced in jsdom (click Status twice, unmount, remount — the saved sort
wins). That the owner's own browser held a saved Status sort is LIKELY, from the
"↓" in his screenshot; his localStorage was not read.

**Fix.** DataGrid `sortForSessionOnly`: the header sort lives in component state
for the visit, is stripped from every layout write, and a sort saved before the
prop is ignored. `Amendments.tsx` and `PoAmendments.tsx` pass it; every other grid
is unchanged (a test pins that a plain grid still restores its sort). Pinned by
`frontend/src/pages/scm-v2/amendment-list-order.test.tsx` (the two "left from an
earlier visit" tests) and `frontend/src/vendor/scm/components/DataGridSessionSort.test.tsx`.
Proved RED: with `sortForSessionOnly` removed from both pages, both queue tests fail
and the rest of the file passes. The phone queues were never affected — their chip
state is in memory and they sort every render.

**Ref.** feat/amendment-queue-ref-approver, 2026-09-14.
