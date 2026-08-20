## The card-style task block showed a dead Approve button on already-approved items [low]

<!-- area: Projects + PMS + fair report -->

**Symptom.** Owner 2026-08-17: "i cant click approve" — on an APPROVED Stock In
Transfer Record (approved by the Owner account that same day), the expanded
task card still showed an enabled Approve button that did nothing when clicked.

**Root cause (traced).** Two rules collided. The 2026-08-08 idempotence guard
makes re-approving an approved item a silent backend no-op (correct). The
2026-08-10 per-decision toggle (hide the button that repeats the current
decision, keep the one that reverses it) was applied to the table DocRow but
NOT to the card-style block with the "Management remark" input — so that block
kept rendering an enabled Approve whose click was swallowed by the guard, which
reads as a broken button. Same class as the 08-10 report, one render site missed.

**Fix.** Same toggle applied to the card block: approved → Reject only,
rejected → Approve only, undecided → both.

**Ref.** 2026-08-17.
