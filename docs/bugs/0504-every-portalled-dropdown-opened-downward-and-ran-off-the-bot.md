## Every portalled dropdown opened downward and ran off the bottom of the window [high]

<!-- area: Frontend + mobile -->

**白话.** 老板在 Sales Order 打 SKU 的时候，选单永远往**下**开。field 本身在画面
偏下的时候，选单最后几行、还有那条绿色的「Add N」按钮，就整条掉到窗口外面，点不
到，也拉不到。全系统有七个选单是同一个写法。现在改成：先量一量 field 上面和下面
哪一边空间大，就往那一边开；而且选单再高也不会超过那一边的空间，footer 一定在画
面里。

**Symptom.** Owner 2026-08-21, on the Sales Order line SKU picker: he typed a
code, the option list opened below the input, and the last rows plus the green
"Add N" footer bar were off the bottom of the window — unreachable by clicking
or scrolling.

**Root cause (traced).** Seven call sites each portalled their menu to
`document.body` with `position: fixed` and placed it as `top: rect.bottom + 4`
with no check of the room below and no flip upward, while the menu's height was
a hard-coded `max-height` that knew nothing about the viewport. The heights
disagreed per component as well: `SoLineCard.module.css` `.suggestList` 460px,
`max-h-72` (288) on the two Service Case typeaheads, `max-h-64` (256) on
`UserMultiSelect`, an inline 280 on `MultiSupplierPicker`. So the taller the
list, the further past the fold it went.

The shared geometry to do this correctly ALREADY existed —
`frontend/src/lib/anchoredPanel.ts`, written for the Sales Order State picker
(#2110) and used by `StatePicker`, `SearchableSelect`, `PhoneInput` and
`DebtorSuggestList`. It measures both sides from the live rect, flips to the
side with more room, clamps `maxHeight` to `min(cap, room − margin)` with a
120px floor, and re-measures on capture-phase scroll + resize. These seven were
simply never converted to it, which is the duplicated-rule bug class CLAUDE.md
names: one house rule, four adopters and seven private copies.

**Fix.** All seven converted to `useAnchoredPanel` / `anchoredPanelStyle` /
`measureAnchoredPanel`, each passing its OWN previous max-height as the cap so
nothing is shorter than before when there IS room:

| file | menu | cap |
| --- | --- | --- |
| `frontend/src/vendor/scm/components/SoLineCard.tsx` | SKU picker (the reported one) | 460 |
| `frontend/src/vendor/scm/components/SoLineCard.tsx` | fabric colour combobox | 460 |
| `frontend/src/vendor/scm/components/MultiSupplierPicker.tsx` | supplier multi-select | 280 |
| `frontend/src/components/UserMultiSelect.tsx` | people multi-select | 256 |
| `frontend/src/pages/ServiceCases.tsx` | SO search (detail panel) | 288 |
| `frontend/src/pages/ServiceCases.tsx` | SO search (intake form) | 288 |
| `frontend/src/components/DataTable.tsx` | column filter popover | viewport − 16 |

The DataTable popover is the one that is anchored to a POINT and has its own
fixed width, so it uses the pure `measureAnchoredPanel` for the vertical
decision and keeps its horizontal clamp; the other six use the hook. No
component's z-index changed.

**Fix (test).** `frontend/src/lib/anchoredPanel.test.ts` gains the tight-space
cases the seven sites needed and the four earlier adopters never exercised: a
downward panel whose height is SHORTENED so its footer lands inside the
viewport, a flipped panel whose top edge stays on screen, and the
neither-side-fits choice. **Proved RED**: `measureAnchoredPanel` was reduced to
the seven sites' old arithmetic (`top: anchor.bottom + 4`, `maxHeight` = the
caller's cap, no flip) and the suite went `6 failed | 14 passed` — the three new
cases among them. Restored, `20 passed`.

**Ref.** fix/one-dropdown-positioner, 2026-08-21.
