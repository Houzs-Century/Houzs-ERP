## The AP Payment hid its prepay box behind an empty invoice list, and a date typed without slashes never landed [low]

<!-- area: Accounting + GL -->

**Symptom.** The owner (2026-09-06, screenshots): on New AP Payment for a
freshly created other-creditor (405-H001 HOUZS VENTURE HOLDING SDN BHD) the
Apply-to-PI card said "This supplier has no outstanding purchase invoices."
and offered nothing else — AP payment 时如何 advance pay? And typing
`06092026` into Voucher Date left the field showing the raw digits; on blur
it snapped back to the old date, so the date could only be picked from the
calendar.

**Root cause (traced).** `frontend/src/pages/scm-v2/PaymentVoucherNew.tsx`:
the Apply-to-PI body was a four-way ternary — no supplier / loading /
`allocations.length === 0` → the empty sentence / else a fragment holding
the table AND the Prepay (advance) block AND the Books line. The prepay box
therefore rendered only when at least one invoice was open — exactly the
case where a prepay is least needed. `frontend/src/vendor/scm/components/
DateField.tsx` `parseDmy` accepted only `d/m/yyyy` with a separator
(`/`, `-`, `.`); eight bare digits never matched, `onChange` never fired,
and the blur handler restored the canonical value. Both observed on the
live screen, then reproduced in the component tests below (RED before the
change, GREEN after).

**Fix.** The empty-list sentence and the table are now the two arms of ONE
inner ternary; the Prepay block, the unspent-advance banner and the Books
line sit beside them for any chosen supplier, and a prepay-only voucher
composes the same single AP line with no allocation. `parseDmy` reads
DDMMYYYY and DDMMYY day-first (the way the field displays) with the same
real-calendar check. Pinned by `PaymentVoucherNew.test.tsx` ("a supplier
with NO outstanding invoice still gets the prepay box") and the new
`DateField.test.tsx` (`06092026` → `2026-09-06`; `0609202` and `31022026`
stay null).

**Ref.** feat/pv-prepay-date, 2026-09-06.
