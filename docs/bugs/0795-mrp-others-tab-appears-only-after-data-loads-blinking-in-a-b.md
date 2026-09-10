## MRP Others tab appears only after data loads, blinking in a beat after the other four [low]

<!-- area: MRP + planning -->

**Symptom.** The owner, 2026-09-11, with two screenshots side by side: while the
MRP page shows "Loading MRP..." the tab bar has FOUR tabs (Sofa, Bedframe,
Mattress, Accessories); once the data lands a FIFTH tab, Others, pops into
existence. His words: 「loading 的时候它就不见了，没有 loading 的时候就有，为什么
那么奇怪呢？它的那个组件不是跟正常的 Matrix、Serena 是一样的吗？」 — why does it
vanish during loading and only appear after.

**Root cause (traced).** The four core tabs are a hard-coded constant in
`mrpViews` (`frontend/src/pages/scm-v2/mrp-views.ts`), so they render on the
first frame regardless of load state. Others, by contrast, was DERIVED from the
server's `MrpResponse.categories` list, which only arrives with the data — so
during loading `categories` was absent/empty and `mrpViews` emitted only the
four. A tab that is a constant and a tab that is derived from the response cannot
appear at the same time; that difference IS the flicker.

**Fix.** `mrpViews` now returns Others as a PERMANENT fifth tab alongside the
four, painted from the first frame and no longer derived from `categories` (the
argument is kept only so callers need not change). `rowBelongsToView` still
routes rows to Others by EXCLUSION, so nothing about which rows land there
changes — only when the tab itself is painted. This supersedes bug 0782's "show
Others only when the catalogue holds a non-core category"; an occasional empty
Others (a company selling only the four) is the accepted price for a tab bar
whose shape never changes mid-load. Pinned by `mrp-views.test.ts` ("Others is a
permanent tab even when the catalogue has only the four"; "the five tabs stand
even when the server says nothing") and `mrpCategoryTabs.test.tsx` ("a response
that carries no category list still renders all five tabs") — all three assert
the five-tab shape and were RED on the pre-fix tree (the old tests asserted the
four-tab shape).

**Ref.** fix/others-tab-always, 2026-09-11.
