## Half the MRP demand was hidden by default and the page never said so [high]

<!-- area: Sales orders + pricing -->

**Symptom.** The owner, 2026-08-16: *"明明这个东西没有 ready,可是我的 MRP 却 show
不出来,呈现不出来."* Orders he named — `2990-SO-2608-019 / 020 / 021 / 022` — carry
`stock_state: "shortage"` on every line, genuinely short with no stock and no PO,
and appeared nowhere on the MRP page.

**Root cause, traced against production, not guessed.** Measured from the browser
with a real session, same moment, one query parameter apart:

| | default | `?includeUndated=true` |
|---|---|---|
| SO item ids in the response | **82** | **163** |
| sofa sets | 44 | 104 |
| sofa sets SHORT | **8** | **68** |
| shortage SKUs | 9 | 21 |

`GET /api/scm/mrp` hides demand with no delivery date by default — deliberate,
and still right: an undated line is not orderable yet (Commander 2026-05-29) and
this page is the ordering worklist. Audit D6 (2026-08-01) had already made the
flag DISPLAY-ONLY, so the allocation was never wrong. **What was wrong is that
the page rendered the surviving half and said nothing about the other half**, so
a shortage the operator had never seen read as a shortage that did not exist.
36 of 84 live 2990 orders (43%) have no delivery date at all.

**A second, smaller fault in the same handler:** the parser was
`c.req.query('includeUndated') === 'true'`, so **`?includeUndated=1` was silently
ignored** — verified against production, it returned the default 82/44/8. A
truthy-looking value that does nothing is the **optional-param-noop** class: the
caller believes it asked, and nothing contradicts it.

**Fix.** `computeMrp` now returns `undated { lines, shortageUnits, sofaSets,
sofaShortageUnits, hidden }`, counted on exactly the rows the flag removes and
never feeding the allocation. `Mrp.tsx` renders an unmissable count with a
one-click **Show them**, and `hidden` comes from the SERVER so a request that was
not honoured still reads true. `parseIncludeUndated` accepts
true/1/yes/on / false/0/no/off in either case and **throws on anything else**
(400) instead of collapsing onto false. The DEFAULT is unchanged — flipping it is
the owner's call and one line.

**Allocation deliberately untouched**, and pinned by test: every dated row's
`source / poNumber / poEta / shortageQty / stockQty / qty` and every bucket's
`stock / poOutstanding` are identical under both flag values. The counting test
also fails if anyone re-introduces the flag into the demand filter — the D6
divergence — because the tally would then no longer equal the removed set.

**Ref.** 2026-08-17. Lesson: **a filter the operator cannot see is a lie the
system tells quietly.** The allocation had been audited, corrected and made
provably consistent; none of that mattered while the page removed 81 of 163 lines
without a word. When a view narrows what it shows, the narrowing must be a
visible fact, not a default nobody reviews.
