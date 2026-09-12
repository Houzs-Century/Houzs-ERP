## A change log that could not load said "No history yet" [high]

**Symptom.** Found on STAGING, 2026-09-13, opening the History drawer on
`HC-GRN-2609-067`. The drawer read **"No history yet."**

Asked directly with the same signed-in session, the endpoint behind that drawer
answered:

```
GET /api/scm/entity-audit-log/GRN/<id>
500 {"error":"load_failed","reason":"permission denied for table entity_audit_log"}
```

The server refused and the screen reported emptiness. On an audit trail that is
the worst wrong answer available: "nobody has touched this document" is exactly
what a person opens a change log to find out, and it was produced by a `?? []`.

**Root cause (traced).** `AuditHistoryPanel` had `isLoading` and no error input
at all, and every binding fed it `q.data ?? []`. react-query leaves `data`
undefined and `isLoading` false on a failed read, so a refusal fell straight
through the loading branch into the empty branch.

All three bindings had it: `EntityHistoryPanel.tsx` (which serves the payment
voucher, goods receipt, stock take, stock transfer and, since
`docs/bugs/0847-four-documents-kept-a-change-log-nobody-could-read.md`, the four
documents), `SalesOrderDetail.tsx:3897` and `SalesOrderDetailV2.tsx:749`. So the
silence covered every change log in the system, not one screen.

The backend already refuses to make this exact mistake, in these words
(`routes/entity-audit-log.ts`): an unknown entity type is rejected with a 400
rather than an empty list, because answering with `{ entries: [] }` *"reads as
'this document has no history' — the single most misleading answer an audit
endpoint can give."* The frontend then produced that answer one layer up.

It is also the third time these same host files have paid for the same `?? []`.
`SalesOrderDetail.tsx:1749` and `SalesOrderDetailV2.tsx:757` each carry a
written-up comment about a FAILED payments read leaving `isLoading` false and
`data` undefined, so the guard fell through and painted an empty panel. The
lesson was recorded next to the payments query and never reached the audit one —
which is the repo's own rule that a ledger entry with no test attached is
unfixed.

**Why it was found now, and what it says about staging.** The refusal itself is
NOT this bug — it is `docs/bugs/0824-the-staging-sales-orders-list-said-permission-denied-on-the.md`,
still open: the staging Worker's `SUPABASE_SERVICE_ROLE_KEY` holds the staging
project's **anon** key. Re-confirmed 2026-09-13 from the Workers themselves:
staging `/health` reports `rest_role: anon`, production reports
`rest_role: service_role`. Production is unaffected. Staging surfaced this
because a broken backend is what makes a swallowed error visible.

**Fix.** `AuditHistoryPanel` takes `error` and renders a distinct, deliberately
louder failure state that says the log could not be loaded, says plainly that
this is not proof nothing was changed, and prints the reason the server gave. It
is checked BEFORE `isLoading`, because react-query keeps the last error while
retrying and reading loading first makes a permanent refusal read as a flicker.
All three bindings pass `q.error`.

Proved RED on the unfixed tree: 3 of 5 assertions failed, the first reporting
`expected <p class="_historyEmpty_...."> to be null`.

The prop is optional in the TYPE so the panel still renders for a caller with
nothing to report, which means the compiler cannot enforce the wiring — so
`auditHistoryPanelError.test.tsx` also SCANS every `<AuditHistoryPanel …/>` under
`pages`, `mobile` and `components` and fails on any mount without `error=`, with
a second assertion that the scan found at least three mounts so a dead matcher
cannot report a pass.

**Ref.** feat/change-log-six-docs, 2026-09-13.
