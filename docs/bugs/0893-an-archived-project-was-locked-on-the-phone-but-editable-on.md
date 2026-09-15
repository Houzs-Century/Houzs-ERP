## An archived project was locked on the phone but editable on the desktop [medium]

<!-- area: Projects + PMS + fair report -->

**Symptom.** Found by the 2026-09-14 phone-vs-desktop permission audit (row
PMS-4). Once a project was archived, the phone locked nearly everything on it:
checklist ticks, document uploads and deletes, the Setup & Dismantle schedule,
crew and phase photos, PIC and Sales-attending assignment, the header Edit, Log
sale and the P&L lines. The desktop kept all of those open and hid only the
status dropdown, and the server refuses none of them. So late costs or a missing
photo on a closed event could be finished at a desk but not from a phone, and
the owner's own account hit the lock like everyone else's.

**Root cause (traced in the source).** `frontend/src/mobile/MobilePMS.tsx` ANDed
`!archived` into 24 capability props and header controls. On the desktop,
`frontend/src/pages/Projects.tsx` gates exactly one control on archive state,
`ProjectStatusSelect`, and nothing on the server checks `archived_at` before an
edit (audit row PMS-4). The phone rule was a July phone design, never a server or
desktop rule.

**Fix.** Owner ruling 2026-09-14 (D4, 「根据最新的version」): archived projects stay
editable on both surfaces. The phone now gates only the status dropdown on
`archived`, the same one control the desktop withholds; every other gate keeps
its permission terms and drops the archive term. Pinned by
`frontend/src/auth/projectActionGates.test.ts` ("an archived project withholds
only its status, on both surfaces"); with `MobilePMS.tsx` restored to `main` it
fails (24 gates found where 1 is allowed).

**Ref.** fix/mobile-pms-archived-editable, 2026-09-14.
