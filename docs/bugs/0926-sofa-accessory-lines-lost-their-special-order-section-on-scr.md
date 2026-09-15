## Sofa Accessory lines lost their Special Order section on screen and printed as FABRIC_ACCESSORY [high]

<!-- area: Sales orders + pricing -->

**Symptom.** Owner, 2026-09-15, on HC-SO-2609-071 (a sofa plus five pillow / back-cushion /
arm-rest lines): 「为什么是 show fabric accessory 呢？不是 sofa accessory？」 and
「为什么 special order 都没有了？可是 PDF 出来会有呢」. The printed order headed the five lines
FABRIC_ACCESSORY; on the edit screen each of them wore an OTHERS pill and had no Special Order
section, while the PDF and the detail table still printed "SPECIAL: Special Fabric-GD526-16
(BEETEX Chenille)".

**Root cause (traced).** The Sofa Accessory category (`fabric_accessory`, owner 2026-09-14) was
added to the variant rule, the stock key, MRP and the category picker, and not to three
readers that each keep their own list:

1. `frontend/src/vendor/scm/lib/special-order-surface.ts` — `STANDALONE` (which categories get
   the Special Order section) held `mattress`, `accessory`, `others`. These lines were
   `accessory` until the 2026-09-14 recategorisation, and keep their special order as free
   text in `variants.extraAddonNote`; the Sofa Accessory panel holds only the fabric picker,
   so after the move neither panel rendered the note, on desktop (`SoLineCard.tsx`) or phone
   (`MobileNewSO.tsx`, same function). Nothing was lost: the draft carries every variant key
   through a save, and HC-SO-2609-071 itself logged at least nine web `UPDATE_LINE` edits on
   2026-09-15 (06:55-08:23Z) with all five notes still stored at 08:31Z — which is why the PDF
   (`buildVariantSummary` → `SPECIAL:`) kept printing them.
2. `frontend/src/vendor/scm/lib/category-badges.tsx` — `CATEGORY_BADGE` had no
   `fabric_accessory`, so the line card and the lists fell back to OTHERS.
3. `frontend/src/vendor/scm/lib/sales-order-pdf.ts` — the section heading printed the raw
   group, `(it.item_group || 'OTHER').toUpperCase()`, instead of the category's name from
   `vendor/shared/product-categories.ts` (`FABRIC_ACCESSORY: 'Sofa Accessory'`). The phone line
   card had the same gap in `LINE_CATS` and read "General item".

Read from production, read-only, 2026-09-15: HC-SO-2609-071's five `fabric_accessory` lines each
carry `extraAddonNote` (e.g. `Special Fabric-GD526-16 (BEETEX Chenille)`) and no `specials`;
across all 268 live `fabric_accessory` SO lines, 160 carry a note and 0 carry a ticked add-on;
no active add-on in `scm.special_addons` is offered to `FABRIC_ACCESSORY`.

**Fix.** `fabric_accessory` joins `STANDALONE` (not `POOLED` — it keys stock by colour and binds
per order, like its sofa), `CATEGORY_BADGE` (label from the shared name, sofa swatch), the SO
PDF heading (`mfgCategoryLabel`), and the phone's `LINE_CATS`. Pinned by
`special-order-surface.test.ts`, `category-badges.test.ts`,
`sales-order-pdf-category-heading.test.ts` (asserts what the generator draws) and
`frontend/src/vendor/scm/components/SoLineCard.sofaAccessory.test.tsx`, which renders the real
line card for HC-SO-2609-071's ARM REST 01 and finds the SPECIAL ORDER section, the note in an
editable box and the SOFA ACCESSORY pill. Proved RED: with each fix reverted, its tests fail
(STANDALONE: 3 of 4 in the rendered test and the surface case; badge: the pill cases; PDF
heading: the FABRIC_ACCESSORY case).

**Ref.** fix/sofa-accessory-label-and-special-order, 2026-09-15.
