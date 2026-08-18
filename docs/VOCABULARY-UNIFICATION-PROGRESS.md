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
| 1 | **Batch 1 — stop the bleeding** — register every concept, generate the glossary, fix the doc-drift, fix the low-risk defects | **IN PROGRESS** |
| 2 | **Batch 2 — pay the debt** — retire each drifted spelling, one concept per PR, with its migration | NOT STARTED |

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
