## The redesigned Team profile could not issue a 2990 POS PIN [high]

**Symptom.** Owner, 2026-08-24, with two screenshots: a Houzs salesperson
(EMP-0026, Sales Executive, companies `Houzs Century` + `2990's Home`) had been
given 2990 access, and the 2990 showroom tablet was sitting on its PIN keypad
with his name already picked — but nowhere on his Team profile was there any way
to give him a PIN. The tablet is the only door a showroom salesperson has, and it
takes a 6-digit PIN, not a password. So the account existed, the company access
existed, and the person still could not start a shift.

**Root cause (traced).** Two separate faults, both observed rather than reasoned.

1. **The redesigned Team screens shipped without the control the classic ones
   had.** The Team redesign (2026-08-22) moved the member surface to
   `frontend/src/pages/team/`. The classic screen carried both halves — a
   "Set PIN" action on `MemberDetail` and a 6-digit field on the invite modal
   (`frontend/src/pages/Team.tsx`, the `onSetPin` wiring and the
   `isSalesPosition` block). Neither was carried across:
   `grep -i pin frontend/src/pages/team/*.tsx` returned nothing but unrelated
   words (`pinned`, `mapping`). The backend was never the problem —
   `POST /api/pos/admin-set-pin/:userId` and `admin-reset-pin/:userId` were live
   the whole time — so this is a UI regression that left a working endpoint with
   no caller.

2. **`admin-set-pin` could store a credential that can never sign in, silently.**
   The invite door refused a `pos_pin` on a non-sales position with a message
   (`backend/src/routes/users.ts`, the `isPosPinPosition` guard). The admin door
   did not: it checked only that the PIN was six digits and that an `scm.staff`
   row existed. `/pin-login` then rejects the session with `not_pos_role` (403),
   which the tablet renders as a bad PIN — so the member reads as forgetful while
   the real fault is their title, and nobody is looking at the title.

   There was also no way to READ whether someone already had a PIN. The only
   place that fact surfaced was `has_pin` inside the tablet's own pre-auth picker
   (`GET /api/pos/sales-staff`), which an admin cannot see. "Does he have a PIN?"
   could only be answered by sending someone to a tablet to try one.

**Fix.**

* `frontend/src/pages/team/PosPinCard.tsx` — a POS Access card on the member
  profile that appears exactly when the assignment on screen is 2990's Home + a
  Sales title. It shows *PIN set* / *No PIN yet*, sets, replaces and removes, and
  opens its own entry box straight after the save that first made the member
  eligible — the classic screen's failure was a button nobody knew to press.
  A FAILED status read renders as "could not check", never as "no PIN": reading
  a network error as an empty credential would invite an admin to overwrite a
  working one.
* `frontend/src/pages/team/posPinEligibility.ts` — the one copy of the rule,
  shared by the profile and the invite modal so the two cannot drift. The company
  is matched on the `2990` CODE from mig 0083, never on a hard-coded id.
* `frontend/src/pages/team/TeamInviteModal.tsx` — the 6-digit field is back, so
  the credential can go out with the account.
* `backend/src/routes/pos.ts` — `admin-set-pin` now refuses a non-sales title
  with `not_pos_role` and a message naming the field to change, matching the
  invite door; new `GET /admin-pin-status/:userId` (`users.manage`, read-only,
  never returns the hash) answers has-PIN plus tablet readiness.
* `backend/src/services/posPin.ts` — `readPosPinStatus` and the pure
  `posPinWriteRefusal`, exported so the test EXECUTES the decision rather than
  matching the handler's spelling (the precedent is `canTargetSalesperson` in
  this same router, whose two predecessors both died in ways a source-text pin
  could not see).

Pinned by `backend/tests/posPinAdminGuard.test.ts` (12) —
**proved RED on the unfixed tree**: deleting the `positionEligible` branch gives
`AssertionError: expected undefined to be 'not_pos_role'`, 1 failed | 11 passed —
plus `frontend/src/pages/team/PosPinCard.test.tsx` (15) and
`posPinEligibility.test.ts` (11). The UI half cannot be proved red the same way,
because the regression was an ABSENCE: the evidence is the grep above returning
nothing on the pre-fix tree.

**Ref.** `fix/team-profile-pos-pin`, 2026-08-24.
