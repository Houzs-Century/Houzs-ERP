# Module: Memos — the department memo register

> **Written with the code, 2026-09-09 (PR "memo register").** Owner 2026-09-08:
> "每个部门自动生成 memo reference number", the register half of "两个都要"
> (the other half is the MEMO document type on a notice —
> `docs/modules/announcements.md` §3 "Document type").

## 0. The one sentence

A department writes a memo outside the ERP (Word / PDF) and needs the
official number for it. The register is that: one row per memo — title,
department, date, the file, who registered it — numbered **at creation**
through the same mint the announcement approval uses
(`docs/modules/document-refs.md`), so a memo registered here and a memo
composed as a notice count on ONE sequence per department and month:
`OPS-MEMO-2609-0001`, `OPS-MEMO-2609-0002`, … A memo is numbered, so it is
never deleted — it is voided with a reason and its number goes VOID in the
registry, never re-issued.

## 1. Frontend

| Screen | File | What it does |
|---|---|---|
| Memos (desktop) | `frontend/src/pages/Memos.tsx` (route `/memos`, lazy in `frontend/src/App.tsx`; sidebar row under Operations in `frontend/src/components/Sidebar.tsx`, ungated like Announcements) | The register table (ref no, title + notes, department, memo date, file as a download through `api.downloadFile`, registered by / when, Void…); a department filter and "Show voided"; the **New memo** panel — Title, Department (a plain user's own department, locked; a `memos.manage` holder or the owner wildcard picks any), Memo date (defaults to today), Notes, File (two-step upload to `PUT /api/memos/upload`, then the manifest entry rides the POST). Register & number is held while the title is empty, the department has no code (the message names Team → Departments), or the MEMO type demands a file and none is uploaded (Settings → Documents). The success toast carries the minted number. Void… asks the reason through the app dialog. |

No phone screen yet — the register is an office desk.

## 2. API surface — `backend/src/routes/memos.ts` (mounted at `/api/memos`)

| Method | Path | Gate | Notes |
|---|---|---|---|
| GET | `/api/memos` | signed-in | `?departmentId=`, `?includeVoided=1` (voided rows are hidden by default); newest first, 500 max; joined to the department and the people's names |
| PUT | `/api/memos/upload?ext=` | signed-in | the file (pdf / doc / docx / xls / xlsx / jpg / png / webp, 25MB) → `{ r2Key, mime, size }`, stored under `memos/` in `POD_BUCKET` |
| POST | `/api/memos` | signed-in — own department; any department for `memos.manage` / `*` | `{ title, departmentId?, memoDate?, notes?, file? }`; refuses a department without a code (409, names the fix), a bad date (400), a key outside `memos/` (400), no file while the MEMO type demands one (400); mints the number, inserts, audits `memo.create`, answers 201 with the row |
| GET | `/api/memos/:id/file` | signed-in | streams the memo's own file (inline for PDF / images, attachment otherwise; nosniff) |
| POST | `/api/memos/:id/void` | the registrar, or `memos.manage` / `*` | `{ reason }` required; marks the number VOID (`voidDocumentRef`), writes `voided_by/at` + `void_reason`, audits `memo.void`; idempotent |

There is **no DELETE route**, and the database refuses one underneath (§4).

## 3. Backend

`backend/src/routes/memos.ts` is self-contained: the mint and the void come
from `services/documentRefs.ts` (`mintDocumentRef` with `entityType: "memo"`,
`typeCode: "MEMO"`, the submitter's department code; `voidDocumentRef`), the
attachment policy from `services/announcementFiles.ts`
(`attachmentRequiredForType(env, "MEMO")` — the same reader the notices use),
the audit from `services/audit.ts`. `memos.manage` is declared in
`services/permissions.ts` (resource Memos, verb manage); the owner wildcard
passes it like any key. Regression suite: `backend/tests/memos.test.ts`.

## 4. Database

`public.memos` (mig `backend/src/db/migrations-pg/20260909T0500_memos.sql`):
`id` PK, `title`, `department_id`, `dept_code` (the code at the time of
numbering), `memo_date` (YYYY-MM-DD), `notes`, `file_key` / `file_name` /
`file_mime` / `file_size`, `ref_no` UNIQUE, `created_by/at`, `voided_by/at`,
`void_reason`; index `(department_id, created_at DESC)`. BEFORE DELETE
trigger `trg_memos_no_hard_delete` refuses any delete — there is no draft
state to discard. The registry row lives in `document_refs`
(`entity_type = 'memo'`).

## 5. Who can do what

| Actor | Can |
|---|---|
| Any signed-in user | read the register and any memo's file; register a memo for their OWN department; void a memo they registered |
| `memos.manage` / `*` | register for any department; void anyone's memo |

## 6. Files that must change together

| Change | Where |
|---|---|
| The number's shape / the sequence | `services/documentRefs.ts` (shared with the notices — do not fork) |
| The attachment policy | Settings → Documents (`pages/settings/DocumentTypesTab.tsx`), read by `services/announcementFiles.ts` |
| The department code | Team → Departments (`departments.code`) |
