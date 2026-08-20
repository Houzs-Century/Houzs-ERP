## The Resolution Method dropdown was the only place on the screen still speaking slugs [low]

**Symptom** - on one ASSR screen the same field read two ways. The solution
summary said `Supplier Service`, the status card said `Supplier Service`, the
printed document said `Supplier Service` - and the dropdown you actually pick
from said `supplier_repair`.

**Root cause (traced)** - `InlineEdit` rendered each option's slug as its own
label. Mobile already mapped its options through the shared `resolutionLabel`
formatter, so only the desktop control leaked the raw value.

**Fix** - `InlineEdit` takes an optional `optionLabel`; the resolution dropdown
passes `resolutionLabel`, so picker, summary, card and paper are one
vocabulary. The unknown-value fallback option goes through the same formatter,
so a legacy slug is worded rather than shown raw. The default is the identity
function, so every other `InlineEdit` dropdown is untouched.

**Lesson** - a display formatter applied on three surfaces out of four is not a
formatter, it is a convention waiting to be broken. The one surface that skipped
it was the only one users type into.

**Ref** - PR #2040, 2026-08-11. Entry written 2026-08-13 during a documentation
audit, not at merge time.

---
