## Legacy 'cancel' status rendered a neutral pill instead of cancelled [sev: low]

Symptom: an SCM list row whose status is the legacy bare verb 'cancel' (SO/DO legacy rows) showed the muted cancelled-row background (dt-row-cancelled) but a NEUTRAL grey status pill — the row and its own pill disagreed on whether it was cancelled.

Root cause traced: frontend/src/lib/scm.ts has two helpers that must agree. isCancelledDocStatus() returns true for both 'CANCELLED' and legacy 'CANCEL' (uppercased). scmStatusClasses() only listed `case \"CANCELLED\":` on the err branch, so an uppercased 'CANCEL' matched no case and hit the neutral `default:`. The two helpers drifted: one counted 'CANCEL' as cancelled, the other did not.

Fix: added `case \"CANCEL\":` to scmStatusClasses()'s err branch alongside 'CANCELLED', so a legacy-cancelled status gets the err pill that matches its cancelled row treatment. Added a drift-guard test asserting scmStatusClasses returns the err class for every status isCancelledDocStatus classifies as cancelled.
