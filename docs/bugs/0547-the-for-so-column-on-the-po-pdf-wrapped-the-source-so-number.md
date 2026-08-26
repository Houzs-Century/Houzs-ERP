## The For SO column on the PO PDF wrapped the source SO number onto two lines [low]

<!-- area: SCM, PO, procurement -->

**Symptom.** On the printed Purchase Order, the first column ("For SO") broke the
source Sales-Order number across two lines — `HC-SO-2608-008` rendered as
`HC-SO-2608-00` then `8` on the next row. Owner-reported from a live PO PDF.

**Root cause (traced).** `frontend/src/vendor/scm/lib/purchase-order-pdf.ts` set
the "For SO" column to `cellWidth: 25` (mm), with a comment stating it "fits
SO-2606-001 on one line" — 11 characters. But doc numbers now carry a company
prefix and are longer: `HC-SO-2608-008` is 14 chars and `2990-SO-2608-026` is 16.
autoTable's default overflow is line-break, so a value wider than 25mm wraps. The
25mm width was correct for the pre-prefix format and was never widened when the
prefix was added.

**Fix.** `fix/po-pdf-forso-wrap` — widen column 0 to `cellWidth: 34` (fits 16
chars at the table's 8.5pt on one line); the Description column is `cellWidth:
'auto'` so it absorbs the extra 9mm. No other column changes. Comment updated to
name the real worst case (`2990-SO-2608-026`).

NOTE — not proven by a rendered PDF in CI (jsPDF text-width is not measured
here): 34mm is sized from the 25mm→11ch ratio the old comment recorded (≈2mm/ch +
padding → 16ch ≈ 35mm), erring generous. **UNTESTED against an actual render** —
verify by generating one PO PDF with a 2990-prefixed source SO before trusting
the width is exact.

**Ref.** fix/po-pdf-forso-wrap, 2026-08-21.
