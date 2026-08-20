## A PV reversal of a line-less entry posted a zero-line reversal header [medium]

<!-- area: Accounting + GL -->

**Symptom.** Cancelling a Payment Voucher whose journal entry somehow had no
lines wrote a REVERSAL header carrying the full total against zero lines —
posted, flagged, standing in the ledger as the record of a reversal that
reversed nothing. The old code documented the defect against itself ("worst
of the three copies") but still shipped it.

**Root cause (traced).** reversePvAccounting built the swapped contra lines
from the original's lines with no fallback (a PV's legs are dynamic, so none
exists), then guarded only the lines INSERT behind a length check — the
posted flip and the reversed flag ran unconditionally after it.

**Fix.** All reversals now run through acc/engine reverseJournal, which
deletes the contra header and returns reversal_lines_failed when the original
has no lines and no fallback — fail loud, post nothing (brief §2.14).

**Ref.** feat/accounting phase 0, 2026-08-16.
