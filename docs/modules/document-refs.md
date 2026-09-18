# Document Reference Numbers

Company-wide reference numbering for NEW document families (memos, SOPs, warnings, notices, announcements) — not a replacement for SCM's own document numbers (`HC-SO-2609-001` etc.), which keep their existing scheme since they're already in AutoCount and on paper.

## Statuses and flow

The number is `[DEPT]-[TYPE]-[YYMM]-[NNNN]` (e.g. `OPS-ANN-2609-0001`): `DEPT` from `departments.code`, `TYPE` from `document_types.code`, `YYMM` the Malaysia-time month at mint, `NNNN` a running number per `(DEPT, TYPE, YYMM)` starting at `0001` each month.

Minting is not a route — the module that owns a record calls `mintDocumentRef(env, {deptCode, typeCode, entityType, entityId, createdBy})` when the record reaches the state that deserves a number:
- **Announcement approval** mints on the `PENDING_APPROVAL -> APPROVED` transition (`typeCode: "ANN"`) and stores the number on the announcement; a submitter with no department, or a department with no code, BLOCKS the approval (409) rather than publish an unnumbered notice.
- **The document register** (`docs/modules/memos.md`) mints AT CREATION with whatever type the registrar picked (MEMO/SOP/WARN/NTC) — on the SAME `<DEPT>-<TYPE>-<YYMM>` series a notice of that type would get on approval, so a registered document and an approved notice of the same type count together.

A record that already holds a number gets it back rather than minting twice (`document_refs` is unique on `(entity_type, entity_id)`). `voidDocumentRef` sets the row `VOID` and stamps who/when/why — the number keeps its place in the sequence and is never re-issued. `peekNextRefNo` (`GET /api/document-refs/next?typeCode=&deptCode=`) answers what the NEXT mint on a series would produce, claiming nothing — this is what feeds both the announcement composer's "Number on approval" line and the register's "Next number".

## Permissions

- `GET /api/document-refs/:refNo`, `GET /api/document-types` — any signed-in user; the resolved record itself stays behind its own module's gate.
- `POST`/`PATCH /api/document-types` — `settings.manage`.

## Rules that must not break

- The atomic number allocation goes through the SAME counter function the SCM documents use (`scm.next_doc_no_n`) — one `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` per series, so two simultaneous mints on the same series serialise on the row lock and can never share a number.
- The counter only ever rises — a voided number is never re-issued, and a gap in the sequence is expected, not a bug.
- When the counter function is unavailable (test environment, or the window between a merge and running the migration), the fallback is `floor + 1` guarded by the registry's primary key, retried up to 8 times on a unique violation — any OTHER counter error must throw rather than silently falling back, since a fallback taken on a real error would mint against a database that just refused the atomic path.
- A department without a code, or a document type that is not ACTIVE, must block minting rather than produce a malformed or silently-defaulted number.
- Adding or changing an active document type is a real change to what a department can number — every consumer (the register, the announcement composer) lists whatever is currently active.

## Gotchas

- `attachment_required` is a per-type policy edited once in Settings → Documents and read by every consumer (`announcementFiles.ts`) — don't hardcode an attachment requirement per document family elsewhere.
- The department code on a minted reference (`dept_code`) is a snapshot taken at mint time — a later department rename does not retroactively change numbers already issued.
- `findRef`/`findRefForEntity` resolve a reference either direction (number → entity, entity → number) — use these rather than querying `document_refs` directly from a new consumer.

## Where the code is

- `backend/src/services/documentRefs.ts` — mint, void, resolve, peek.
- `backend/src/routes/documentRefs.ts` — API surface.
- `backend/src/db/migrations-pg/20260906T1417_departments_code_document_refs.sql` — schema.
- `frontend/src/pages/settings/DocumentTypesTab.tsx` — the document-type registry editor.
