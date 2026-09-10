## MobileSkuPicker footer button overflowed past the sheet [medium]

**Symptom.** Owner, 2026-09-11 (mobile SO line editor): tapped **Pick a
product** on a Sales Order line; the CATALOG bottom sheet opened correctly,
but its footer read *"0 selected"* squished to a strip on the left and a huge
green **Add product** button that ran off the sheet's right edge — the button
was visibly wider than the sheet itself, half-obscured by the phone's screen
edge / any bottom-right overlay. Not just cosmetic: the counter is unreadable
and it looks broken.

**Root cause (traced).** In `mobile.css` the primary mobile button carries
`.hz-m .btn { width: 100%; ... }` (line 141) — every full-width primary CTA
in the mobile app relies on it. In `MobileSkuPicker.tsx:238-250` the footer
lays out with `.sheet-foot { display: flex; align-items: center; gap: 8px; }`
(mobile.css:183): a `<span style={flex: 1}>N selected</span>` and the
`<button className="btn">`. The inline style only added `flex: "none"` and
`padding: "10px 16px"` — it did NOT override the `.btn` class's `width: 100%`.
`flex: none` = `0 0 auto`, but the explicit `width: 100%` wins as the flex
basis, so the button demands 100% of the flex container's inline size. The
`flex: 1` span cannot shrink the neighbour below its basis, so total item
size exceeds the container, and since `flex: none` also refuses to shrink
the button, the row overflows past the sheet's right padding — the exact
shape in the screenshot.

**Fix.** One inline style property in `MobileSkuPicker.tsx`: add
`width: "auto"` alongside `flex: "none"` on the footer button. The button
now sizes to its label + `padding: "10px 16px"`, the span keeps its
`flex: 1` room to display `"0 selected"` / `"N selected"`, and the row
stays inside the sheet.

Not touching `.hz-m .btn` — every other mobile screen still needs its
`width: 100%` primary. The override is confined to this one flex-row use.

**Verification.** The change is CSS-adjacent (one inline style property).
Verified by DOM inspection: with `width: auto` the button's computed width
is `label + padding = ~136px`, not `100%` of the sheet — so it cannot
overflow. Full browser QA at coarse-pointer emulation to follow after the
force-calendar overlay PR (#3592) lands, since both changes touch the mobile
SO surface.

**Ref.** `fix/shrink-sku-dropdown`, 2026-09-11.
