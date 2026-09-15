## MRP shortage rows lost their petrol wash when the report moved onto DataTable [medium]

<!-- area: Frontend + mobile -->

**Symptom.** Owner, 2026-09-15:
「为什么我的 MRP 界面的颜色好像有一点不一样了？我记得之前是有一点看到颜色的。自从我改了那个 data grid 的那一个 columns 那边可以 collapse，好像蛮多东西都不一样去了」

In his screenshot of the Mattress tab, every row was plain white or grey. The
rows still to order showed only a thin left bar and a checkbox.

**Root cause (traced).** Until 2026-09-11 the MRP report was a hand-built table.
A row still to order carried `.skuRowShort`:

- a light petrol wash, `background: rgba(22, 105, 95, 0.08)`
- plus a deep-petrol left bar

(`Mrp.module.css:150` at `1f83d1ce0`; owner rulings 2026-08-03, and no solid
fill per 2026-05-29).

#3696 (`f6b13d4e2`, "migrate Stock Status table onto shared DataTable") moved the
report onto DataTable. That is the change that added Collapse / Expand, which he
remembers. It replaced the class with `.rowShort > td:first-child { box-shadow:
inset 3px 0 0 #08352e; }` (`Mrp.module.css:289` at `31352ebe3`). The bar was
carried over and the wash was not.

The coverage chips (`.tag*`), the SHORT number (`.shortNum`), the drill-down
tints (`.childShort`, `.variantRowShort`) and the header skin were diffed across
#3696 and are unchanged. The row wash is the one colour that went missing.

**Fix.** `.rowShort[data-vrow] > td` paints the same `rgba(22,105,95,0.08)` wash
on every cell of the row, and the bar stays on the first cell. It is painted as
an inset box-shadow rather than a background:

- **Above what DataTable paints.** A shadow sits over the zebra, the hover green
  and a pinned column's inline opaque background.
- **Pinned cells stay solid.** Scrolled content cannot show through them.

`[data-vrow]` keeps the wash off the expanded drill-down row, which DataTable
also gives the row's class. The drill-down keeps its own grey ground. The phone
card (`[data-mobile-card]`) gets the same wash and bar.

Pinned in `frontend/src/pages/scm-v2/mrpShortageRowTint.test.tsx`. It renders
the real `Mrp` page with the real `Mrp.module.css` injected under the hashed
class names, and asserts jsdom's computed style of each cell. On the unfixed CSS
the first cell read `rgba(0, 0, 0, 0) inset 3px 0 0 #08352e` (bar, no wash), so
the test was RED. It is GREEN after the fix.

Observed in Chromium through a local Vite harness rendering the real page (6
Mattress rows, 3 short). The 3 short rows compute `rgb(8, 53, 46) 3px … inset,
rgba(22, 105, 95, 0.08) 0 0 0 9999px inset` on the first cell and the wash on
the others; the 3 covered rows compute `none`.

**Ref.** fix/edit-order-and-mrp-colours, 2026-09-15.
