# Change Log

Company-wide, read-only feed of what changed and who changed it, across Sales Orders, Purchase Orders, Delivery Orders and GRNs — plus a per-document History drawer for the same trails one document at a time. Both underlying audit tables are append-only.

## Statuses and flow

- `GET /api/scm/change-log?hours=&author=&docType=` merges two audit tables — `scm.mfg_so_audit_log` (Sales Orders, keyed `so_doc_no`) and `scm.entity_audit_log` (everything else, keyed `entity_type`+`entity_id`) — into one reading, since their column sets are identical by design.
- `hours` defaults to 168 (7 days, max 2880); `author` defaults to `person` (`person`/`machine`/`all`); `docType` defaults to every type. An unrecognised `docType` returns EVERYTHING rather than nothing — an empty list would misleadingly read as "nobody changed anything".
- The response always includes both `changesByPerson` and `changesBySystem`, computed BEFORE the `author` filter narrows what's shown, so a filtered view can never be mistaken for the whole count.
- `totals.truncated` reports when either underlying read came back short of the server's own exact row count — both surfaces then say every count is a floor, not a total.
- The per-document History drawer (`DocumentHistoryDrawer.tsx`) is the other half of this feature — it covers Sales Order, Purchase Order, Purchase Invoice, Sales Invoice and Delivery Order (Purchase Return and Inventory Adjustment are recorded but have no drawer/vocabulary yet).

## Permissions

- `scm.changelog.read` **or** `settings.manage` (or `*`) — its own permission key, not tied to any single SCM area (the log spans every area at once, so there is no `scmAreaGuard` on the route).

## Rules that must not break

- Person-vs-machine authorship has exactly one rule, in one file (`audit-author.ts`): a row is MACHINE when `actor_name_snapshot` starts with `system` (case-insensitive); everything else — including a row with no name at all — is PERSON. Never infer authorship from `actor_id` (pinned to one constant for every authenticated caller), `version` (bumped by automated paths too), or `source` (a free-form column with 30+ spellings) — those are reported, not decisive.
- `totals.truncated` must be measured against each read's own exact server-reported count (Content-Range), OR'd across both tables — never against a client-side row cap.
- `stripAuditFinance` must run on the merged rows here exactly as it does on `/entity-audit-log` — otherwise this endpoint becomes a second door to the financial detail the per-document drawer already hides.
- The per-document drawer must be mounted with the document's UUID, never its document number — the number resolves to an empty history that looks real rather than erroring.
- A failed history read must render a distinct failure state, never the same empty state as "no history yet" — collapsing the two hides genuine load failures as clean history.

## Gotchas

- Don't treat a high `changesByPerson` count as proof of staff activity without checking the rows — an automated sweep writes audit rows in exactly the shape a person's edit produces if it fails to stamp a `system`-prefixed actor name.
- All timestamps render in Malaysia local time through one shared formatter (`clWhen`/`fmtDateTime`) — never add a second date formatter or leave a value in raw UTC.
- An unrecognised verb or field name renders as itself rather than being silently dropped — a "cleaner" renderer that swallows unfamiliar values makes a new kind of change invisible.
- This page does not paginate — a time window plus the doc-type filter is the only narrowing; rely on `totals.truncated` rather than assuming a wide window returns everything.
- Adding a document type to either the company-wide log or the per-document drawer means updating both the route-side map and the frontend label dictionary — the frontend list is drift-checked against the backend by a test, so a hand-copy that falls behind fails CI rather than silently omitting a document.

## Where the code is

- `backend/src/scm/routes/change-log.ts` — the company-wide endpoint.
- `backend/src/scm/shared/audit-author.ts` — the person-vs-machine rule.
- `frontend/src/lib/changeLog.ts` — shared hook, vocabulary, formatting for desktop and phone.
- `frontend/src/pages/ChangeLog.tsx`, `frontend/src/mobile/MobileChangeLog.tsx` — the two surfaces.
- `frontend/src/pages/scm-v2/DocumentHistoryDrawer.tsx` — the per-document drawer registry.
- `frontend/src/vendor/scm/lib/entity-audit-queries.ts` — the frontend's document-type list, drift-checked against the backend.
