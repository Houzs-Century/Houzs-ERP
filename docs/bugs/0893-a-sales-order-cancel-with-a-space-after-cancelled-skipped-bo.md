## A sales order cancel with a space after CANCELLED skipped both approvals [medium]

<!-- area: Sales orders + pricing -->

**Symptom.** Nobody saw it happen — it was found while extending the same guard
to the delivery order (owner 2026-09-14, 「DO cancel need pop out window for
reason」). A `PATCH /api/scm/mfg-sales-orders/:docNo/status` whose body said
`"status": "CANCELLED "` (trailing space), `" cancelled"`, or anything else that
only differs by surrounding whitespace was let through the two-signature
cancellation approval, and the order was cancelled with no request and no
signature. No screen sends such a body; a script, a devtools edit or a client
that pads its values would. Production had NOT seen it: 0 non-draft sales order
cancels in `scm.mfg_so_status_changes` since the approval guard shipped
(2026-09-08T08:50Z), counted read-only on `anogrigyjbduyzclzjgn` at
2026-09-14T09:27Z.

**Root cause (traced).** The guard and the handler disagreed on what a cancel IS.
`cancelApprovalGuard('SO')` (`backend/src/scm/routes/document-cancel-routes.ts`)
decided "is this a cancel?" with `String(body.status ?? '').toUpperCase() !==
'CANCELLED'` — upper-cased, NOT trimmed — and waved every other value through as
some other transition. `patchMfgSalesOrderStatusHandler`
(`backend/src/scm/routes/mfg-sales-orders.ts`) normalises with
`String(body.status).trim().toUpperCase()`, so `"CANCELLED "` reached it as
`CANCELLED` and ran the cancel path. Observed with a route test over the guard:
`PATCH { status: 'CANCELLED ' }` by a level-2 approver with no request on the
order answered **200** (the stand-in handler was reached) instead of 403.

**Fix.** One rule for both sides: `asksToCancel` in
`backend/src/scm/shared/document-cancel.ts` reads the status exactly the way the
status handlers do — `String(status ?? '').trim().toUpperCase() === 'CANCELLED'`
(coercing, so `["CANCELLED"]`, which both handlers also accept, is a cancel too)
— and the guard uses it for every status-route document (the SO, and the DO from
the same PR). Pinned by `document-cancel-routes.test.ts` "reads the status the
way the handler does — whitespace does not dodge the approvals" (`'CANCELLED '`,
`' cancelled'`, `'\tCancelled\n'`, `['CANCELLED']` must all be 403 and never reach
the handler) — proved RED on the unfixed tree (`expected 200 to be 403`) — and by
`document-cancel.test.ts` "reads the status exactly the way the handlers do".

**Ref.** `feat/do-cancel-reason`, 2026-09-14. Module guide:
`docs/modules/document-cancel-approval.md` §3.
