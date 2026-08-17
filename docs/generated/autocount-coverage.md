# AutoCount coverage — GENERATED, do not hand-edit

`npm --prefix backend run gen:ac-coverage` writes this file and
`audit:ac-coverage` fails CI when it drifts.

**Do not write a coverage table anywhere else.** Four documents each held
their own and they contradicted each other; that is what this file replaces.
Three of the four columns are read out of source on every run. The fourth
cannot be, and lives in `backend/scripts/data/ac-live-proof.json` — one place,
and an entry needs a document number.

| operation | route | service implements it | ERP triggers it from | run against the live book |
|---|---|---|---|---|
| `create_so` | `/create-so` | yes | mfg-sales-orders.ts x2 | **yes** — HC-SO-2608-001, HC-SO-2608-002 (2026-08-14) |
| `create_po` | `/create-po` | yes | mfg-purchase-orders.ts x3 | no |
| `so_to_do` | `/so-to-do` | yes | delivery-orders-mfg.ts x3 | **yes** — DO-011260, HC-DO-2608-001, HC-DO-2608-002 (2026-08-17) |
| `so_to_po` | `/so-to-po` | yes | _not queued — the drain calls it inline_ | **yes** — PO-009968, HC-PO-2608-001 (2026-08-17) |
| `po_to_gr` | `/po-to-gr` | yes | grns.ts x4 | **yes** — HC-GR-2608-001 (2026-08-17) |
| `do_to_iv` | `/do-to-iv` | yes | sales-invoices.ts x2, lib/si-autocount-source.ts x2 | **yes** — HC-SI-2608-001 (2026-08-17) |
| `gr_to_pi` | `/gr-to-pi` | yes | purchase-invoices.ts x3 | **yes** — HC-PI-2608-001 (2026-08-17) |
| `cancel` | `/cancel` | yes | delivery-orders-mfg.ts x1, grns.ts x1, mfg-purchase-orders.ts x1, mfg-sales-orders.ts x1, purchase-invoices.ts x1, sales-invoices.ts x1 | **yes** — DO-011260, PO-009968 (2026-08-17) |
| `edit` | `/edit` | yes | delivery-orders-mfg.ts x5, grns.ts x5, mfg-purchase-orders.ts x7, mfg-sales-orders.ts x13, po-amendments.ts x1, purchase-invoices.ts x5, sales-invoices.ts x6, so-amendments.ts x1, so-handover.ts x1, lib/so-payment-row.ts x1 | no |
| `ensure_masters` | `/ensure-masters` | yes | _not queued — the drain calls it inline_ | no |

## What "run against the live book" means here

A document number in `AED_HOUZS`, or a query that can be re-run. Nothing else
counts. Note that the queue is NOT the whole record: `so_to_do` was driven
directly on the host and `scm.autocount_outbox` has no row for it, so a reader
who checks only the queue concludes it never happened. It did.

- **`create_po`** — FK_PO_PurchaseAgent blocked it on 2026-08-12. The cause is fixed in source (readPoHeader sends the constant AC_PURCHASE_AGENT, autocount-outbox.ts) but no purchase order has reached the book through the CREATE arm since. HC-PO-2608-001 does not count for this row: it came from a sales order and therefore took so_to_po.
- **`edit`** — Exercised against the live book as the four refusal guards (a passing guard writes nothing, which is what makes it safe there). No edit has been demonstrated to CHANGE a document in the book.

## The payload contract is checked separately, and by source

`src/services/autocount-writeback.contract.test.ts` reads `AcSyncService.cs`
itself and asserts the bytes the ERP would POST against the keys that file
actually parses, for every route. So "the service implements it" above and
"the two sides agree on the fields" are two different checks, and both run.
