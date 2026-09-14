## The phone Sales Order filter's field picker rendered its labels at the browser default size [low]

**Symptom.** The owner, 2026-09-14, on the phone Sales Orders filter sheet (Add filter -> field list): 「这个UI 字体为什么全部不一样 太大了」. "Created by", "Salesperson", "Warehouse", "Branding" rendered roughly twice the size of the status rows above them.

**Root cause (traced).** `frontend/src/components/so-list-filter/SoFilterFieldPicker.tsx` draws each field as a `.mcard` button (the mobile skin's `option` class) with a bare `<span style={{ fontWeight: 700 }}>`. `.hz-m .mcard` in `frontend/src/mobile/mobile.css` sets no font size, so the label fell back to the browser default. The status rows and the value lists in the same sheet wrap their text in `<span className="ml">` (12.5px / 700), which is why only the field picker looked different.

**Fix.** On the phone the label now carries `ml`, the same class as the status rows; the hint drops to 10.5px. `MobileSoFilterSheet.test.tsx` asserts the picker label's class equals the status row label's class; failed on main, passes on the fix.

**Ref.** fix/so-filter-mobile-font-sizes, 2026-09-14.
