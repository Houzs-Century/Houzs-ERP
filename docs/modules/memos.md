# Document Register (memos, SOPs, warnings, notices)

A department register for documents created outside the ERP (Word/PDF) that need an official reference number — a memo, SOP, warning letter or notice. One row per document: type, title, department, date, the file, who registered it. Numbered AT CREATION through the same shared mint an approved announcement uses (`docs/modules/document-refs.md`), so a registered document and a notice of the same type composed in the ERP count on ONE sequence per department, type and month. The register is the **Register** mode of the Announcements page — it has no route or sidebar entry of its own; the API keeps the name it shipped with, `/api/memos`.

## Statuses and flow

A registered document is ACTIVE or VOID — there is no draft and no delete. Voiding requires a reason; the number goes VOID in the registry and is never re-issued.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/memos` | `?departmentId=`, `?docType=`, `?includeVoided=1` (voided hidden by default); newest first, 500 max |
| PUT | `/api/memos/upload?ext=` | the file → `{r2Key, mime, size}`, stored under `memos/` |
| POST | `/api/memos` | `{title, docType?, departmentId?, memoDate?, notes?, file?}` — mints the number, inserts, audits `memo.create` |
| GET | `/api/memos/:id/file` | streams the file (inline for PDF/images) |
| POST | `/api/memos/:id/void` | `{reason}` required, idempotent |

`docType` defaults to MEMO and must be an ACTIVE registry type other than ANN (announcements are composed in Announcements, not registered here — 400 if attempted). The "Next number" shown in the create panel is a preview only, read from `GET /api/document-refs/next?typeCode=&deptCode=`, and claims nothing until the document is actually registered.

## Permissions

- Any signed-in user may open Register mode, read the register and any file, register a document for their OWN department, and void a document THEY registered.
- `memos.manage` (or `*`) may register for any department and void anyone's document.

## Rules that must not break

- There is no DELETE route, and the database refuses one underneath (a `BEFORE DELETE` trigger) — a registered, numbered document can only ever be voided.
- Registering is refused (before any write) when the department has no code, the date is invalid, the uploaded file's key is outside `memos/`, or the picked type's policy requires a file and none was uploaded.
- The number's shape, sequence and preview logic live only in `services/documentRefs.ts`, shared with the announcement approval mint — never fork a second minting path for this register.
- A document family (add/retire/rename a type) is managed once, in Settings → Documents — the register and the announcement composer both read the same active-type list from there.

## Gotchas

- There is no phone screen for this module — the register is an office-desk tool.
- `ANN` is not a selectable type here — an announcement is numbered only through the approval workflow, not through this register.
- The department code snapshotted onto a row (`dept_code`) is the code AT THE TIME OF NUMBERING — don't assume a row reflects a department's current code after a rename.

## Where the code is

- `backend/src/routes/memos.ts` — API surface.
- `backend/src/services/documentRefs.ts` — shared mint/void/peek (with announcements).
- `backend/src/services/announcementFiles.ts` — type resolution and attachment policy (shared with notices).
- `frontend/src/pages/announcements/RegisterView.tsx` — the Register mode UI, mounted by `frontend/src/pages/Announcements.tsx`.
- `backend/src/db/migrations-pg/20260909T0500_memos.sql`, `20260909T0800_document_register_types.sql` — schema.
