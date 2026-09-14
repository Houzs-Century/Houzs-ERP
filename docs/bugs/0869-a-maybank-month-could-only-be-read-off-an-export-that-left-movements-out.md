## A Maybank month could only be read off an export that left movements out [medium]

<!-- area: Accounting + GL -->

**Symptom.** Maybank's Account Activity export for June 2026 carried nine
movements; the bank's own monthly statement printed eleven — the two 08/06
card credits (RM 1,666.17 and RM 3,230.40) were on the statement and not in
the export, and the owner's fresh download, and the bank's own Account
Activity page, showed the same nine. The month came out RM 4,896.57 short of
the typed month-end figure. The ERP took only the CSV export. Owner
2026-09-14: 我觉得可以 pdf，就也支持 csv，也支持 pdf.

**Root cause (traced).** The statement reader (`acc/bank-parse.ts`) reads a
delimited text file through a per-account column map; the bank's monthly
statement is a PDF, which prints every movement and both balances but has no
columns to map. So the only Maybank source the ERP could read was the one
that turned out to be incomplete, and the month-end figure had to be typed
(docs/bugs/0858) because the export prints no balance.

**Fix.**
- `frontend/src/vendor/scm/lib/pdf-text.ts` (new): pdf.js reads a picked
  `.pdf` in the browser — every piece of text with its x/y, grouped into
  lines by y and ordered by x — loaded on the press, never for a CSV. The
  upload sends it as `content` with `format: 'PDF'`.
- `backend/src/acc/bank-parse-pdf.ts` (new): the bank's LAYOUT is read on
  the server into the same shape the CSV reader hands over. Maybank's SME
  statement: rows dd/mm with the year off the header's statement date, the
  amount with a +/- suffix, the running balance at the right, continuation
  lines folded into the row above, pages until ENDING BALANCE; BEGINNING and
  ENDING BALANCE become the file's opening and closing balances. The rows
  must walk from the one balance to the other or the file is refused. A bank
  with no layout is refused by name.
- `routes/accounting-bank.ts`: the upload door takes `format: 'PDF'`, checks
  the account number against the PDF's text, reads it through the PDF
  reader, and refuses ONE SOURCE PER MONTH (`mixed_sources`): a PDF where the
  account already holds CSV movements on its days, and a CSV where it holds
  PDF ones — the fingerprint that keeps two CSV exports from doubling a
  movement cannot tell the two formats' words apart.
- The screen accepts `.pdf` and says so; everything after the reader —
  recognition, matching, the month, the lock — is unchanged, and a Maybank
  month read off its PDF is covered end to end with nothing typed.

Pinned by `backend/src/acc/bank-parse-pdf.test.ts` (the rows, the year, the
continuation lines, the paging, the walk check, the quiet month, the
January rollover, the unknown bank, the wire shape),
`backend/tests/bankRoutes.test.ts` (the upload end to end, the month covered
with nothing typed, the three refusals, one source per month both ways) and
`frontend/src/pages/scm-v2/BankStatementTab.test.tsx` (a .pdf goes as its
extracted text marked PDF, a .csv as before).

**Ref.** acc/bank-statement-pdf, 2026-09-14.
