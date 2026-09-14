## The phone said the whole sales order was Locked when only its lines were [low]

**Symptom.** On HC-SO-013466 a salesperson raised amendment A1 with the reason
"pay balance" (production read-only run 34799754659: lane LINES, no payment
change, only four no-op spec rows, approved 2026-09-14). A balance payment never
needs an amendment — a new payment can be added on any non-cancelled order.

**Root cause (traced).** `frontend/src/mobile/MobileSODetail.tsx` showed
"Locked — downstream documents exist." beside the LINE Edit button once a DO or
invoice existed. The lock it describes covers the line items only; payments have
their own Add inside the Payments card. The sentence read as the whole order
being locked (flagged in the 2026-09-12 notes, not changed then).

**Fix.** The label now reads "Items locked" (owner asked for it short). No rule
changed. The no-op spec rows the amendment carried are the separate
amendment-diff defect being fixed by another owner.

**Ref.** fix/mobile-so-items-locked-label, 2026-09-14.
