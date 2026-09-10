## MRP sofa-cover pull-in was dead since the per-category tab split [high]

<!-- area: Purchase orders + GRN + PI -->

**Symptom.** The owner's standing rule is that a sofa's leather cover / pillow
(皮套) must be ordered on the SAME purchase order as the sofa — it is packed
inside the sofa. On the MRP Sofa tab, selecting a sofa order and pressing
Proceed PO raised a PO for the sofa modules only; the cover was never pulled in,
so it had to be ordered separately from the Accessories tab and landed on a
different PO. Owner 2026-09-11: 「皮套必须跟沙发同一张 PO」.

**Root cause (traced).** `gatherSofa` (frontend `pages/scm-v2/Mrp.tsx`) pulls a
sofa order's ACCESSORY shortage lines out of `data.skus` and adds them to the
same convert batch, so the server's grouping can co-locate them onto the sofa
PO. But the Sofa tab requests `?category=SOFA` (`useMrp` +
`mrpCategoryOf('sofa')`), and the engine drops every non-SOFA row before it
returns (`backend/src/scm/routes/mrp.ts` section 6, `if (catFilter && cat !==
catFilter) continue`). So `data.skus` on the Sofa tab held ONLY sofa rows, and
`gatherSofa`'s `category === 'ACCESSORY'` filter matched NOTHING — a logical
certainty from the two filters, not a data guess: SOFA ≠ ACCESSORY. The pull-in
worked when it was written (Commander 2026-05-29) and went silently dead at the
per-category tab redesign (2026-06-15), which is when the Sofa tab began
category-scoping its request. The A1 grouping change (per-category Combine/Per-SO,
PR #3602) co-locates a cover onto the sofa PO ONLY once the cover line is in the
convert batch — which this bug meant it never was, from this page.

**Fix.** The Sofa tab now requests the FULL plan (no category filter) instead of
`?category=SOFA`, so accessories are present in `data.skus`; the sofa TABLE is
unaffected (it renders from `data.sofaSets`, which ignores the filter), and the
no-filter view is the DEFAULT view so it is served from the stored snapshot
instantly rather than recomputed live. `gatherSofa`'s `setDocs` was also changed
to derive from the sofa picks actually being ordered, so selecting ONE sofa
order pulls only THAT order's cover (it keyed off all sofa docs before, harmless
only while the pull-in was dead). The covers now also SHOW as read-along rider
rows under their sofa order (owner asked to SEE them ride), with a mode-aware
caption. Pinned by `frontend/src/pages/scm-v2/mrpSearchAndCover.test.tsx`, which
renders an accessory shortage line on a sofa SO and asserts the rider appears;
it fails on the unfixed tree because `?category=SOFA` leaves `data.skus` without
the accessory.

**Ref.** feat/mrp-so-view, 2026-09-11.
