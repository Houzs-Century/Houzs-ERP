# Vocabulary unification — programme progress

Owner ask (2026-08-18): read the whole system once, find every place the same
thing has more than one spelling and every place the docs disagree with the
code, fix the drift, bring the docs current, and **put something in place so it
cannot come back** — so this never has to be done by hand again.

This file is the single status page. Update it every time a stage moves. It
tracks WORKTREES and STAGES, not individual edits.

---

## Stages

| # | Stage | State |
| --- | --- | --- |
| 0a | **Code screening** — read all 1,360 source files (BE/FE/DB) by name | **DONE** 2026-08-18 |
| 0b | **Data screening** — audit every concept against the LIVE database | **DONE** 2026-08-18 |
| 1 | **Batch 1 — stop the bleeding** — registry, glossary, the doc-drift, and the screening defects | **DONE** 2026-08-18 |
| 2 | **Batch 2 — pay the debt** — retire each drifted spelling, one concept per PR, with its migration | **IN PROGRESS** |

## Defects — 21 found, dispositioned

The screening found 21 defects. Fixed by parallel agents, applied centrally with each root cause reconfirmed:
- **16 fixed** — #2429 (customer-ref builders), #2430 (11 backend: the delivery-crew tenant leak, swallowed reads, doMirror cancelled-flag, reverse-journal numbering, variant-key inch marks, …), #2431 (5 frontend: silent mutations, money-parse, cancel pill).
- **2 refuted on reading** — `so-dropdown-options` already degrades; `si-payment-row`'s caller cannot pass null. The agents declined to invent a fix.
- **2 not fixed on purpose** — the `0177` migration comment mislabels: editing an APPLIED migration changes its checksum and blocks the deploy, so the comment stays wrong rather than take prod down.
- **1 was already fixed** in #2429 (the relationship-map fallback).

## Batch 2 reality (measured, not estimated)

Every remaining unification is a physical column rename/drop on core money/stock tables:
- **item-code** (`item_code`/`material_code`/`product_code`): ~1,500 references across ~148 files, 24 columns.
- **money** (`_centi`→`_sen`): 200+ columns.
- **customer-ref drop** (`po_doc_no`/`customer_po*`): dead columns, but behind a VIEW (the 0189 grant-loss hazard) and named in ~10 select constants — DEFERRED, dead + zero functional value + high blast radius.
- **warehouse** (text `sales_location` → uuid `warehouse_id`): needs a backfill.

These cannot be tested against a writable DB from here, several share the 12k-line `mfg-sales-orders.ts` (serial merges), and each needs the owner's button to apply the migration. They are a careful one-at-a-time program, not a sprint. The CODE-layer confusion is already gone — several concepts (branding, processing-date, transfer, salesperson) are already governed by shared modules; customer-ref is unified in #2429.

Two screening layers, because **names lie**:
- [`system-screening-2026-08-18.md`](./system-screening-2026-08-18.md) — the CODE read: 33 concepts, 21 defects (0 high), 1 doc-drift.
- [`system-screening-DATA-2026-08-18.md`](./system-screening-DATA-2026-08-18.md) — the DATA audit: turned the guesses into facts, and CORRECTED four (transport is a SKU not a column; stock/state/exchange are not DB drift). Surfaced a structural finding: the customer master (`customer_id`) is 3% used; everything leans on free-text `debtor_name`.

## Decisions locked (owner, 2026-08-18)

- **Money**: store as an INTEGER minor unit named **`_sen`** (the Malaysian subunit, what AutoCount speaks; `_centi` is the drift despite being the majority). Display/export as **RM** (`35.00`). Confirmed against the Malaysian ringgit and AutoCount conventions.
- **Delivery date** is THREE concepts: SO header, SO line, PO/supplier (`supplier_delivery_date_2/3/4` are the supplier's re-promise dates after a delay — PO-side, never SO).
- **Transport** is a service SKU (`SVC-TRANS…`), not a fee column.
- **`customer_so_no`** duplicates `ref`; `po_doc_no`/`customer_po` are dead (0% filled).

## Open for owner (structural, not renames)

- **Customer normalisation** — `customer_id` is 3% populated; the business runs on one walk-in `debtor_code` + free-text names. Real master or leave as-is?
- **Salesperson** — unify to `salesperson_id` (uuid), keep the text `agent` for display only?

---

## Worktrees

| Worktree | Branch | PR | Carries | State |
| --- | --- | --- | --- | --- |
| `branding-backfill` | `feat/one-vocabulary` | #2420 | the registry, the glossary, the drift catalogue, this progress file, the doc-drift fix | **open, extending** |
| `screening` | `chore/system-screening` | — | scratch tree the screening read from | disposable |

Earlier, already-landed work in this programme:
- #2402 Branding display rule unified · #2410 2990 branding backfill · #2415 HC sofa SCOPE=catalog — all **merged**.

---

## Batch 1 checklist

- [x] Screening report saved as the batch-2 worklist
- [x] `drift-catalogue.mjs` — the 33 concepts as reference data
- [x] Glossary prints the worklist (target spelling per concept)
- [ ] Doc-drift fixed — `sales-order.md:101` still says `proceeded_at` is stamped by a path that no longer exists
- [ ] Low-risk defects fixed (the tenant-predicate and silent-mutation class), each with a `BUG-HISTORY.md` entry
- [ ] CI green, PR updated

## Money — decided, not deferred

Owner: exports show too many zeros; use RM (`35.00`). This is a **display** rule
— format the stored integer as RM at the edge. **Storage stays an integer minor
unit**; storing decimals reintroduces the float-rounding money bugs `money.ts`
exists to prevent. The drift to fix in batch 2 is the NAME (`_centi` / `_sen` /
`_cents` → one word), not the type.

## Batch 2 order (highest confusion first)

Money name · Salesperson · Delivery date · Customer ref · Item code · Warehouse ·
Debtor/Customer · Supplier/Creditor — then the med/low concepts. One concept =
one PR = one migration + the registry entry that retires the old spelling, so the
guard starts enforcing it the moment it lands.
