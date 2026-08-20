## R8 shipped with a route, hooks and a UI control, and without its table [medium]

Not a defect fixed so much as a defect FINISHED. The 500 half is the entry
below ("Combo Pricing 500'd on every load"); this records completing the
feature, because the next person will otherwise re-derive why a table appeared
for code that already existed.

**What was missing** - only `scm.sofa_combo_anchor`. The route
(`GET /anchors`, `PUT /anchors/:baseModel`, `loadComboAnchor`,
`mirrorAnchoredCombo`), the query hooks (`useSofaComboAnchors`,
`useSetSofaComboAnchor`) and the UI control
(`vendor/scm/components/SofaComboTab.tsx:245-253`) all came across from 2990 when
the module was vendored. The table did not. Verified on production 2026-08-12:
`to_regclass('scm.sofa_combo_anchor')` = NULL.

**Fix** - migration `0283_scm_sofa_combo_anchor.sql`, per-company from the start
rather than retrofitted the way 0087 had to convert four masters.

**Why applying it to a live business was safe** - an EMPTY table means no model
is anchored, `mirrorAnchoredCombo` is never reached, and every combo write
behaves exactly as before. Creating it is inert; behaviour changes only when a
human sets an anchor. That is what made this a migration rather than a rollout.

**The trap the migration header exists to prevent** - `sofa-combos.ts:452`
upserts with `onConflict: 'company_id,base_model'`, so the unique constraint must
be exactly that pair. Anything else and every `PUT` fails with `42P10`, not 404.
This is the SAME failure that shipped in `special_addons` earlier the same day:
0087 replaced a single-column unique with a per-company one, `/save` kept
upserting `onConflict: 'code'`, and every Save returned 500 for weeks. Writing
the constraint to match the caller was the whole lesson of that bug, applied
here before it could happen again.

**Lesson** - **when a module is vendored, the schema is part of the module.**
Code, hooks and UI crossed the boundary; one table did not, and nothing noticed
because the only symptom was a console line on a page that otherwise worked.

**Ref** - `feat/sofa-combo-anchor-table`, 2026-08-12

---
