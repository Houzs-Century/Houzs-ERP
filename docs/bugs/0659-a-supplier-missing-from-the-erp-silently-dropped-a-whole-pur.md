## A supplier missing from the ERP silently dropped a whole purchase order from every import run [high]

**Symptom.** AutoCount PO-010113 (2026-09-02, ZOE HOME SDN BHD, RM 3,550, three
AERO-MP mattress-protector lines) was in the book and absent from the ERP after
every go-live import run, with no failure — the run reported success.

**Root cause (traced).** `backend/scripts/import-ac-outstanding-po.mjs:195`
resolves the supplier by `CreditorCode` against `scm.suppliers.code` and, when
it misses, records an exception and `continue`s past the WHOLE document. That
skip is correct behaviour (#2757 made it a skip rather than a run-killer); what
was wrong was the data behind it. `400-Z003` was not in `scm.suppliers` at all —
measured against production 2026-09-07: `suppliers matching code 400-Z003 or
name ~ ZOE: 0` of 44.

The supplier is not new. The committed 2026-08-11 fidelity export carries 22
purchase orders to `400-Z003` going back to 2024-09-19. It was never in the
"Stock Only" creditor list that seeded the supplier master
(`backfill-suppliers-from-autocount.mjs`, 38 rows, 2026-08-06), so it has been
absent since the beginning and every one of those documents was skipped.

**Fix.** `backend/scripts/open-ac-supplier-400-z003.mjs` opens the supplier from
the book's own creditor row — one single-row indexed lookup,
`SELECT ... FROM Creditor WHERE AccNo='400-Z003'`. Every value is copied; a
column AutoCount holds as NULL stays blank. The one value that is not a copy,
`country`, is named in an `ASSUMED` constant and printed on every run. Plan by
default, a `CONFIRM_SUPPLIER` phrase on the apply path, and a verification that
re-reads on a FRESH connection and asserts the row's SHAPE against the book
rather than its row count.

Applied to production 2026-09-07 (run 34100311954): `APPLIED — rows inserted: 1`,
`VERIFY shape matches the AutoCount row verbatim: YES`. The PO importer dry run
then went from **164 POs / RM 579,277.90** to **165 POs / RM 582,827.90** — a
difference of exactly RM 3,550.00, PO-010113's total — and its exception count
fell from 2 to 1 (run 34100409075).

**Ref.** fix/ac-four-exceptions, 2026-09-07.
