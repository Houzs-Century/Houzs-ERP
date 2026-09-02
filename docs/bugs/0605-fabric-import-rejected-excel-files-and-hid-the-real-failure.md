## Fabric import rejected Excel files and hid the real failure reason [medium]

**Symptom.** The owner keeps the fabric list in Excel. The Fabric Converter's
Import button only accepted `.csv`, so every import first meant hand-saving the
workbook as CSV ("任何文档进去都可以 import"). And when an import was refused, the
result said only a COUNT of rejected rows or the generic "That clashes with
something already in the system" — never WHICH codes clashed or WHY
("可不可以显示失败的原因").

**Root cause (traced).**
- The file input was `accept=".csv,text/csv"` and `onFileChosen` read the file
  as text and called `parseCsv` unconditionally
  (`frontend/src/pages/scm-v2/FabricTracking.tsx`), so an `.xlsx`/`.xls` binary
  was never parseable.
- On a whole-request refusal the dialog showed `err.message`, which is
  `humanApiError`'s output. That helper drops the `ids` list entirely and keeps
  the server `reason` only when it is a plain sentence
  (`frontend/src/vendor/scm/lib/authed-fetch.ts`), so the conflicting codes never
  reached the operator. On a partial (200-OK) result the dialog rendered only
  `res.errors.length`, discarding each row's `reason`.

**Fix.** Frontend-only, backend write path untouched.
- `fabric-csv.ts` now shares one grid mapper (`parseGridRows`) between CSV
  (`parseCsv`) and Excel (`parseWorkbook`, lazy-loading the SheetJS runtime that
  the SKU/Products import already ships). `parseImportFile` dispatches by
  extension; header matching is tolerant of case and space-vs-underscore, so a
  hand-made "Fabric Code" column maps like the exported "fabric_code". The input
  accepts `.xlsx,.xls,.csv`.
- `importErrorDetail` reads the server's `reason` and `ids` off the raw error
  `body` and the Import dialog now shows them; a partial result lists each
  rejected row's reason instead of a bare count.
- Tests in `frontend/src/vendor/scm/lib/fabric-csv.test.ts` build a real `.xlsx`
  buffer and assert it parses to the expected rows (blank cells → null, tolerant
  headers, unknown-column warning, missing-`fabric_code` error), and assert a
  server `reason` + `ids` reach the UI. Proved RED first: the Excel row-shape
  assertion failed against a tree whose only import path was CSV (the workbook
  never reached `parseGridRows`).

**Ref.** feat/fabric-import-any-file, 2026-09-02.
