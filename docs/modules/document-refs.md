# Document reference numbers

> Owner decision 2026-09-06 (「标准化编号与文档管理」, plan A): a company-wide
> reference number for **new document families only**. SCM documents keep
> their `HC-SO-2609-001` numbers — those are in AutoCount and on paper and a
> document number cannot change once it exists (`docs/doc-number-reissue-coe.md`).

## 1. The number

`[DEPT]-[TYPE]-[YYMM]-[NNNN]`, e.g. `OPS-ANN-2609-0001`.

| Segment | Source |
|---|---|
| `DEPT` | `departments.code` — 2–4 capital letters, set by an admin on the Team → Departments card (Team module guide, `docs/modules/team-members.md`). A department without a code cannot mint. |
| `TYPE` | `document_types.code` — 2–4 capital letters; the registry seeds `ANN` (Announcement). Managed through `POST` / `PATCH /api/document-types` (`settings.manage`). |
| `YYMM` | The month **in Malaysia time** (`yymmFor`, UTC+8) the number was minted. |
| `NNNN` | Running number per `(DEPT, TYPE, YYMM)`, 4 digits, starts at `0001` each month. |

## 2. How it is minted — `backend/src/services/documentRefs.ts`

`mintDocumentRef(env, { deptCode, typeCode, entityType, entityId, createdBy })`:

1. A record that already holds a number gets it back (`document_refs` is
   unique on `(entity_type, entity_id)`), so a retried save never mints twice.
2. The series key is `DEPT-TYPE-YYMM`. The floor is the registry's highest
   `seq` for that series.
3. The number comes from **the same counter the SCM documents use** —
   `scm.next_doc_no_n(series, floor)` on `scm.doc_number_counters` (mig
   `0316`): one `INSERT … ON CONFLICT DO UPDATE … RETURNING` per series, so
   two simultaneous saves serialise on the row lock and can never share a
   number; the counter only ever rises, so a voided number is never re-issued
   and a gap is expected. Because the month is inside the series, a new month
   starts at `0001` by construction.
4. When the counter function is **absent** (the D1 test mirror; the window
   between a merge and `pg-migrate`) the mint falls back to `floor + 1`
   guarded by the registry's primary key, retrying up to 8 times on a unique
   violation. Any other counter error throws — a fallback taken on a real
   error would mint against a database that just refused the atomic path.
5. The registry row is written: `ref_no, series, dept_code, type_code, yymm,
   seq, entity_type, entity_id, status ACTIVE, created_by, created_at`.

`voidDocumentRef(env, refNo, by, reason)` sets `status VOID` + `voided_by /
voided_at / void_reason`; the number keeps its place. `findRef(env, refNo)` and
`findRefForEntity(env, type, id)` resolve either way round.

Minting is not a route: the module that owns the record mints when the
record reaches the state that deserves a number (the announcement approval is
the first consumer).

## 3. API — `backend/src/routes/documentRefs.ts` (mounted at `/api`)

| Method | Path | Gate | Notes |
|---|---|---|---|
| GET | `/api/document-refs/:refNo` | signed-in | resolves a number to `{ entityType, entityId, status, … }`; the record itself stays behind its own module's gate |
| GET | `/api/document-types` | signed-in | active types; `?all=1` includes inactive |
| POST | `/api/document-types` | `settings.manage` | `{ code, label, attachmentRequired? }` → 201; 409 on a duplicate code |
| PATCH | `/api/document-types/:code` | `settings.manage` | `{ label?, attachmentRequired?, isActive? }` |

`attachment_required` is the per-type policy the "attachment required before
submit" rule reads (follow-up PR); the flag exists now so the policy has one
home.

## 4. Database — mig `backend/src/db/migrations-pg/20260906T1417_departments_code_document_refs.sql`

| Object | Shape |
|---|---|
| `departments.code` | text, nullable; `idx_departments_code_upper` unique on `upper(code)` where set |
| `document_types` | `code` PK, `label`, `attachment_required` int 0/1, `is_active` int 0/1, `created_at`, `updated_at`; seeded `ANN` |
| `document_refs` | `ref_no` PK, `series`, `dept_code`, `type_code`, `yymm`, `seq`, `entity_type`, `entity_id` (unique pair), `status` ACTIVE/VOID, `created_by`, `created_at`, `voided_by`, `voided_at`, `void_reason`; index `(series, seq)` |

Reversal is in the migration header. Prepared SQL only — no `--` comments
inside a statement (d1-compat).

## 5. Files that change together

| Concern | File |
|---|---|
| Mint / void / resolve | `backend/src/services/documentRefs.ts` |
| Routes | `backend/src/routes/documentRefs.ts` (+ regenerate the route-capability matrix) |
| Department code | `backend/src/routes/departments.ts`, `backend/src/db/schema.pg.ts`, `frontend/src/pages/team/TeamDepartmentsV2.tsx`, `frontend/src/types.ts` |
| Tests | `backend/tests/documentRefs.test.ts` (fallback path on the D1 mirror; the counter path is pinned by the SCM suites) |
