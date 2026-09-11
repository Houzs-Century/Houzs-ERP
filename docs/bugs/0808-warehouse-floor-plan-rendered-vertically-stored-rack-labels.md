## Warehouse floor plan rendered vertically — stored Rack labels never parsed [medium]

**Symptom.** Owner 2026-09-11, on the just-shipped Warehouse → Rack Overview
floor plan (#3619): instead of two banks of rack columns side by side, every
rack drew as its OWN full-width "bank" stacked in one long vertical column —
"太长了, 右边留空太多" (too long, too much empty space on the right). The KPI
counts were right (76 slots); only the layout was wrong.

**Root cause (traced).** The parser assumed the rack id was bare ("L1.1"), but
the stored `warehouse_racks.rack` value carries a leading word — the KL racks
are "Rack L1.1", "Rack R17.2". `parseRackLabel`'s regex in
`frontend/src/vendor/scm/lib/warehouse-floorplan.ts` was `^`-anchored
(`/^\s*([A-Za-z]*)\s*(\d+)…/`), so "Rack L1.1" matched nothing → `parsed:false`,
`rackNo: NaN`. `buildBanks` then grouped by prefix, and every unparsed label
became its own prefix ("RACK L1.1"), so each rack was a one-rack bank and the
range label fell to its "N rack" branch ("1 rack"). The #3619 handoff screenshot
already showed "Rack L1.1" on the cards; the parser was built for the owner's
shorthand ("L1.1") and never re-checked against the real value. Confirmed by the
live screenshot: each block captioned "RACK L1.1 · 1 rack · 0/1 used", the exact
shape of the unparsed path.

**Fix.** Drop the `^` anchor so the regex reads the TRAILING
`<letters><number>[.<number>]` token — "Rack L1.1" → prefix L, rackNo 1, level 1
(`RACK_LABEL_RE` in `warehouse-floorplan.ts`). Pinned by
`warehouse-floorplan.test.ts` ("reads the real 'Rack L1.1' label"), which is RED
on the `^`-anchored regex (the label returns `parsed:false`). The same PR
re-lays the plan into the owner's zones (ZONE A / ZONE B) with loading-bay and
main-entrance side strips.

**Ref.** feat/warehouse-floorplan-zones (PR #3652), 2026-09-11. Regression from
PR #3619.
