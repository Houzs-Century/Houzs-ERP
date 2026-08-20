## A fourth is-this-me staff ladder on the SO detail had no user_id rung [medium]

<!-- area: Sales orders + pricing -->

**Symptom.** On the Sales Order detail, Add-Payment's "Collected By" defaulted to
"—" for people who plainly do have a staff row — including the IT Admin, whose
row is `user_id 4, email NULL`.

**Root cause (traced).** `self-staff.ts` was created to end exactly this: three
surfaces each wrote their own ladder for "which staff row is the signed-in
person?", so the answer depended on which screen you stood on. A **fourth** copy
survived that consolidation in `SalesOrderDetail.tsx`, and it was the weakest
one — bridge-staff-id, then lower-cased email, then lower-cased name, with **no
`user_id` rung at all**.

`user_id` is the only link that reliably exists on this data and it is what the
backend itself joins on (`resolveOwnerStaffId`). Measured on production
2026-08-12: **102 of 140 `scm.staff` rows carry `user_id`; 18 carry an email.**
So the page was matching on the sparse keys and ignoring the dense one.

**Fix.** The page now calls the shared `resolveSelfStaff`.

**THIS IS A BEHAVIOUR CHANGE, NOT A PURE REFACTOR — flagged for the owner, not
buried.** Who the picker's default changes for:

  - **Newly matched.** Anyone linked by `user_id` whose bridge staff id is null
    and whose email/name did not line up. The IT Admin above is the worked case:
    all three old rungs missed, so the field showed "—".
  - **Differently matched.** Anyone whose `user_id` points at one roster row
    while their email or name matches another. `user_id` now wins. That is the
    correct authority — it is what the server uses — but it is a change in what
    the field pre-fills with, and someone could have been relying on the old
    answer.

**Blast radius, stated plainly:** this only sets the DEFAULT of a picker the
operator can still change before saving. It writes nothing on its own, and the
payment is recorded against whatever the operator confirms.

Pinned by `frontend/src/vendor/scm/lib/self-staff.one-home.test.ts`, proved RED
on the unfixed tree:

```
expected [ …(2) ] to deeply equal [ 'vendor/scm/lib/self-staff.ts' ]
+   "pages/scm-v2/SalesOrderDetail.tsx",
```

The guard is deliberately narrow: it does NOT forbid searching the roster — a
page resolving the salesperson the operator PICKED does that legitimately, by id
(`staffList.find((s) => s.id === form.salespersonId)`, in SalesOrderNew,
MobileNewSO and ConsignmentOrderNew). It forbids matching a staff row by
lower-cased **email or name**, which nothing needs to do except a
self-resolution ladder, and self-resolution has one home. Verified against those
three files so the guard discriminates rather than merely fires.

**Ref.** fix/mark-all-read-and-self-staff, 2026-08-21.
