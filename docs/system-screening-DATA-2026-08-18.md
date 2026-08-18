# System screening — the DATA layer (production, read-only)

<!-- The CODE screening (system-screening-2026-08-18.md) read 1,360 files and
     clustered concepts by NAME. Names lie. This is the second layer: every
     concept audited against the live database — real columns, fill rate,
     distinct count, sample/garbage values, cross-field duplication. It turns
     the code screening's guesses into facts, and corrects the ones that were
     wrong. Owner rule 2026-08-18: reading code is not evidence about
     production; the running system is the fact. -->

Audited 2026-08-18 with the read-only replica. Three layers must agree before a
concept is acted on: **code** (names/wiring) → **database** (what is stored) →
**owner** (what it should mean). This is the database layer.

## Confirmed drift (code guess held up against the data)

| Concept | Verified fact |
| --- | --- |
| **Item / material / product code** | ONE SKU under three names by table family: SO/DO/SI lines → `item_code`, PO/GRN/PI/consignment → `material_code`, inventory/price-history/stock → `product_code`. Consistent within each family; the same SKU (`CODY-(Q)`) appears under all three. |
| **Salesperson** | `mfg_sales_orders` stores BOTH `agent` (text name, e.g. `KINGSLEY`, 96% fill) AND `salesperson_id` (uuid, 99%). `delivery_orders.agent` is garbage — a mix of uuids and names in one column. `scan_*` tables use `salesperson` (text). |
| **Warehouse** | `warehouse_id` (uuid) everywhere EXCEPT the SO header + DO header + SI, which use `sales_location` (text, `KL WAREHOUSE`). PO header uses `purchase_location_id` (uuid). The uuid values reconcile across tables; the text `sales_location` is the odd one out. |
| **Customer's ref** | `customer_so_no` (96% fill, 2705 distinct) ≈ `ref` (95%, 2701 distinct) — near-identical duplicates of a brand-prefixed reference (`HC…`, `ZNT…`), NOT the customer's PO and NOT the AutoCount doc no. `po_doc_no` and `customer_po` are 0% filled — DEAD columns. Garbage present: `testing`, `-`, `HC4673+HC4674`. |
| **Venue** | `venue` (text) is authoritative (`PJ Showroom`, `2990s PJ`); `venue_id` (uuid) is ~1% filled — a dead FK. |
| **Batch / dye-lot** | `batch_no` (inventory) and `allocated_batch_no` (SO items) both hold PO numbers (`2990-PO-2606-024`). Batch is overloaded onto the PO number. |
| **Delivery date — THREE concepts, not one** | SO header: `customer_delivery_date` (20%) + `amended_delivery_date`. SO line: `line_delivery_date` (16%). PO: `expected_at` (90%) + `supplier_delivery_date_2/3/4` (the supplier's re-promise dates after a delay — 7/2/0 rows). The agent wrongly merged the PO supplier dates with the SO date. |
| **Note / remark** | Scattered: `note`, `notes`, `remark`, `narration` across ~25 tables (GL uses `narration`, SO header `note`, SO line `remark`, most else `notes`). Free text, low harm, real drift. |
| **Money minor unit** | `_centi` (majority, all documents) vs `_sen` (GL engine, inventory costing, product master pricing) — both mean 1/100 RM. Line tables carry BOTH: `unit_price_centi` and the sofa-build `divan_price_sen`/`leg_price_sen`/`special_order_price_sen` on the same row; `mfg_sales_orders` has `subtotal_sen` next to `local_total_centi`. **Target under review: `_sen` is the Malaysian subunit and what AutoCount speaks — domain-correct beats majority. Owner deciding.** |

## The data audit CORRECTED the code guess (agent was wrong)

| Concept | Code guess | Data fact |
| --- | --- | --- |
| **Transport fee** | a drifted column (`transport_fee`/`transport_pct`) | **No such column exists.** Transport is a SERVICE SKU (`SVC-TRANS.CHARGES`, `TRANSPORTATION CHARGES`). The `transport_*` names are code-only rate-card slugs. |
| **Stock readiness** | 3 names (`stock_status`/`stock_state`/`stock_remark`) | DB has ONLY `stock_status` (`PENDING`/`READY`/`PARTIAL`). The other two are derived in code, not stored — not DB drift. |
| **Customer state** | drift | **Clean** — 16 standard Malaysian states, no spelling drift. |
| **Exchange rate** | drift | Two names (`rate_to_myr`, `exchange_rate`) but every value is `1.000000` (single-currency). Harmless. |

## Data-quality problems the audit surfaced (not naming — the data itself)

| Problem | Evidence | Owner decision |
| --- | --- | --- |
| **The customer master is barely used** | `mfg_sales_orders.customer_id` (the proper uuid FK) is **3% filled**; `debtor_code` is one value `300-C002` for 2,722 rows (a generic walk-in code, plus a trailing-space variant `300-C002 `); everything leans on free-text `debtor_name` (2,587 distinct names). | Normalise customers into a real master? (structural, not a rename) |
| **`customer_so_no` duplicates `ref`** | 2705 vs 2701 near-identical distinct values | Keep one, retire the other; decide what the field should hold |
| **Garbage in `customer_so_no`** | `testing`, `-`, `HC4673+HC4674` | clean on next backfill |

## What stays out of scope (verified NOT DB drift)

The sofa-axis names (`seatHeight`/`legHeight`/etc.), payment-method enums, and
document-number suffixes are code-level, not stored-data drift. They are handled
in the code layer, not by a data migration.
