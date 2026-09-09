# Module: Document register — memos, SOPs, warnings, notices

> **Written with the code, 2026-09-09 (PR "memo register"); re-shaped the same
> day (PR "register in Announcements").** Owner 2026-09-08: "每个部门自动生成
> memo reference number", the register half of "两个都要" (the other half is the
> document type on a notice — `docs/modules/announcements.md` §3 "Document
> type"). Owner 2026-09-09, on seeing it: "memo — 放在 Announcement 里面; 每个
> memo, SOP, warning, notice 都需要按部门编号; 需要显示目前档案号码".

## 0. The one sentence

A department writes a memo, an SOP, a warning letter or a notice outside the
ERP (Word / PDF) and needs the official number for it. The register is that:
one row per document — type, title, department, date, the file, who
registered it — numbered **at creation** through the same mint the
announcement approval uses (`docs/modules/document-refs.md`), so a document
registered here and a notice of the same type composed in the ERP count on
ONE sequence per department, type and month: `OPS-MEMO-2609-0001`,
`OPS-SOP-2609-0001`, `OPS-WARN-2609-0001`, `OPS-NTC-2609-0001`. A registered
document is numbered, so it is never deleted — it is voided with a reason and
its number goes VOID in the registry, never re-issued. The register is the
**Register** mode of the Announcements page; it has no route or sidebar row
of its own. The API keeps the name it shipped with: `/api/memos`.

## 1. Frontend

| Screen | File | What it does |
|---|---|---|
| Register mode of Announcements (desktop) | `frontend/src/pages/announcements/RegisterView.tsx`, mounted by `frontend/src/pages/Announcements.tsx` as the third entry of the mode toggle (Reading · Manage · Register — Register is open to every signed-in user like Reading; deep link `/announcements?view=register`). Nothing in `frontend/src/App.tsx`, `frontend/src/components/Sidebar.tsx` or `frontend/src/routing/routeManifest.ts` names it any more (the `/memos` route lived for a few hours on 2026-09-09) | The register table (ref no, type chip, title + notes, department, document date, file as a download through `api.downloadFile`, registered by / when, Void…); a type filter, a department filter and "Show voided"; the **Register a document** panel — Type (every ACTIVE registry type but ANN, from the page's own `/api/document-types` read; MEMO by default), Title, Department (a plain user's own department, locked; a `memos.manage` holder or the owner wildcard picks any), Document date (defaults to today, `DateField` so it reads DD/MM/YYYY on every machine), Notes, File (two-step upload to `PUT /api/memos/upload`, then the manifest entry rides the POST). **Next number** (owner 2026-09-09): once a department and a type are picked the panel shows the number Register would mint right now, read from `GET /api/document-refs/next?typeCode=&deptCode=` — a preview, nothing claimed. Register & number is held while the title is empty, the department has no code (the message names Team → Departments), or the picked type's policy demands a file and none is uploaded (Settings → Documents). The success toast carries the minted number. Void… asks the reason through the app dialog. |

No phone screen — the register is an office desk. The composer's own
"Number on approval" line (the same peek, for a notice composed in the ERP)
is documented in `docs/modules/announcements.md` §1.

## 2. API surface — `backend/src/routes/memos.ts` (mounted at `/api/memos`)

| Method | Path | Gate | Notes |
|---|---|---|---|
| GET | `/api/memos` | signed-in | `?departmentId=`, `?docType=`, `?includeVoided=1` (voided rows are hidden by default); newest first, 500 max; joined to the department and the people's names |
| PUT | `/api/memos/upload?ext=` | signed-in | the file (pdf / doc / docx / xls / xlsx / jpg / png / webp, 25MB) → `{ r2Key, mime, size }`, stored under `memos/` in `POD_BUCKET` |
| POST | `/api/memos` | signed-in — own department; any department for `memos.manage` / `*` | `{ title, docType?, departmentId?, memoDate?, notes?, file? }`; `docType` defaults to MEMO and must be an ACTIVE registry type other than ANN (`resolveDocType`; ANN → 400 "composed in Announcements, not registered here"); refuses a department without a code (409, names the fix), a bad date (400), a key outside `memos/` (400), no file while the type's policy demands one (400); mints the number on `<DEPT>-<TYPE>-<YYMM>`, inserts, audits `memo.create`, answers 201 with the row |
| GET | `/api/memos/:id/file` | signed-in | streams the document's own file (inline for PDF / images, attachment otherwise; nosniff) |
| POST | `/api/memos/:id/void` | the registrar, or `memos.manage` / `*` | `{ reason }` required; marks the number VOID (`voidDocumentRef`), writes `voided_by/at` + `void_reason`, audits `memo.void`; idempotent |

There is **no DELETE route**, and the database refuses one underneath (§4).
The next-number preview both screens read is `GET /api/document-refs/next`
(`docs/modules/document-refs.md`).

## 3. Backend

`backend/src/routes/memos.ts` is self-contained: the mint and the void come
from `services/documentRefs.ts` (`mintDocumentRef` with `entityType: "memo"`,
`typeCode` = the registered type, the department's code; `voidDocumentRef`),
the type check and the attachment policy from
`services/announcementFiles.ts` (`resolveDocType`,
`attachmentRequiredForType(env, code)` — the same readers the notices use),
the audit from `services/audit.ts`. `memos.manage` is declared in
`services/permissions.ts` (resource Memos, verb manage); the owner wildcard
passes it like any key. Regression suite: `backend/tests/memos.test.ts`.

## 4. Database

`public.memos` (mig `backend/src/db/migrations-pg/20260909T0500_memos.sql`,
`doc_type` added by `backend/src/db/migrations-pg/20260909T0800_document_register_types.sql`): `id` PK,
`title`, `department_id`, `dept_code` (the code at the time of numbering),
`doc_type` (NOT NULL DEFAULT 'MEMO' — the [TYPE] segment), `memo_date`
(YYYY-MM-DD), `notes`, `file_key` / `file_name` / `file_mime` / `file_size`,
`ref_no` UNIQUE, `created_by/at`, `voided_by/at`, `void_reason`; index
`(department_id, created_at DESC)`. BEFORE DELETE trigger
`trg_memos_no_hard_delete` refuses any delete — there is no draft state to
discard. The registry row lives in `document_refs` (`entity_type = 'memo'`,
`type_code` = the registered type). The 0800 migration also seeds `SOP`
(Standard operating procedure), `WARN` (Warning) and `NTC` (Notice) into
`document_types` beside ANN and MEMO — codes are 2–4 letters by the shared
number shape, hence the short forms.

## 5. Who can do what

| Actor | Can |
|---|---|
| Any signed-in user | open Register mode, read the register and any document's file; register a document for their OWN department; void a document they registered |
| `memos.manage` / `*` | register for any department; void anyone's document |

## 6. Files that must change together

| Change | Where |
|---|---|
| The number's shape / the sequence / the peek | `services/documentRefs.ts` (shared with the notices — do not fork) |
| A document family (add / retire / rename) | Settings → Documents (`pages/settings/DocumentTypesTab.tsx`, `document_types`); the register and the composer both list whatever is active |
| The attachment policy | Settings → Documents, read by `services/announcementFiles.ts` |
| The department code | Team → Departments (`departments.code`) |
| The mode toggle / the deep link | `frontend/src/pages/Announcements.tsx` |
