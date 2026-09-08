## The approver who just signed could not run the cancel — the document's status route still asked for the area's edit level [high]

<!-- area: Auth, permissions, sessions -->
<!-- status: fixed -->

**Symptom.** Staging, 2026-09-08, driving the SO two-signature cancellation
end to end with the prod cast (#3223 / #3250 / #3258): `purchasing@example.my`
— a Procurement position with `scm.sales.orders` at `view`, holding
`scm.so_cancel.approve_l2` — signed level 2 through the key bypass and the
request landed `APPROVED` with `execute: true`. The card then runs the page's
own cancel, `PATCH /mfg-sales-orders/:docNo/status {status:'CANCELLED'}` — and
that write is not on the bypass list, so for this caller the area guard would
answer `403 Forbidden: needs edit access to scm.sales.orders`. The script had
to hand the execution to a caller with edit. On prod the final approver is the
Purchaser (Operation Executive position, Sales Orders at `view`): Farra or Sim
pressing "Approve & cancel" would sign, then be refused the cancel, and the
card would sit at "Approved — Cancel now" until someone with edit pressed it.

**Root cause (traced).** #3250 admitted the three approver VERBS on the
request (`cancelApproverWriteBypass`: `POST …/cancel-request/{approve,reject,
withdraw}`) and nothing else — deliberately, so an approver could not use the
key to edit the document. But the execution of an approved request IS a write
on the document (`PATCH …/status` / `PATCH …/cancel`), and it was left behind
the area's `edit`. `cancelApprovalGuard` knew the request was `APPROVED` and
could see who was calling, but it ran AFTER the area guard (mounted later on
the same prefix), so by the time it could have said "this one is fine" the
403 had already gone out.

**Fix.** The cancel guard is mounted BEFORE the area guard on both prefixes
(`backend/src/scm/index.ts`) and, when the request is `APPROVED` and the caller
holds one of the document's approve keys, sets `cancelExecutionAdmitted` on
the context (`scm/env.ts`); the area guard's `writeBypass` is now
`cancelExecutionBypass(docType)`, which honours that flag and otherwise defers
to the approver verbs. Because it now runs ahead of the router's auth bridge,
the guard mints its own service client (`getSupabaseService`) when none is
stashed yet, and reads the caller off the intact Houzs `user` when `houzsUser`
is absent. Nothing else widens: a non-cancel transition by the same approver
is never admitted, and a caller with no approve key is left to the area guard
exactly as before. Pinned in `document-cancel-routes.test.ts`: the stand-in
handlers echo the flag — false before approval (the refusal wins), false for a
stranger after approval, TRUE for the level-2 approver executing the cancel,
false for the same approver sending IN_PRODUCTION; plus the predicate itself.
Not proved red on the unfixed tree by a test — the refusal is the real area
guard's, which the route suite stubs out; the evidence is the staging run
above (the L2 approver's signature succeeding, the execution needing another
caller) and prod's `position_page_access` rows for the Purchaser's position.

**Ref.** fix/cancel-executor-area-bypass-0908, 2026-09-08.
