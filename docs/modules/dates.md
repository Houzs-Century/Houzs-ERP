# Dates

Canonical reference for every date/timestamp fact in the system: where each one is actually stored, and every other name it answers to. Read before adding, renaming, or "unifying" any date column.

## Rules that must not break

- Read/write the Processing Date through `SO_PROCESSING_DATE_COLUMN` / `SO_PROCESSING_DATE_PAYLOAD_KEY` (`backend/src/scm/shared/so-processing-date.ts`), never a hand-typed literal — a `.mjs` script must use the mirror `backend/scripts/lib/so-processing-date.mjs`, it cannot import the `.ts`.
- Read supplier ETA on a PO through the shared `effectiveDelivery()` helper (`backend/src/scm/shared/effective-delivery.ts`), never recompute it per caller.
- Keep `public.sales_entries.processing_date` (legacy native Sales module) and `public.sales_orders.ac_udf_pdate` (AutoCount's own field) separate from the SCM SO's `processing_date` — different documents, different write paths; renaming any of them breaks a stored-payload replay.
- A header delivery-date change cascades to every line: on the SO it resets `line_delivery_date_overridden` and overwrites all lines; on the Consignment Order it respects the flag and skips overridden lines. This divergence is deliberate — do not "fix" it by making them match.
- Find the date-coercion helper (`emptyDate` / `dateOrNull`) your own route already imports or declares — there is no shared date-coercion module.

## Gotchas

- The stock allocator (`backend/src/scm/lib/so-stock-allocation.ts`) gates on `proceeded_at`, not `processing_date`. Setting the Processing Date from the normal SO detail screen only writes `processing_date`, so the order is locked, boarded, and pushed to AutoCount but silently skipped by allocation — if an order won't reach READY_TO_SHIP with stock on hand, check `proceeded_at`.
- `amended_delivery_date` (the board's reschedule date) has no CONTROLLED lock, no approval, and no cascade — it can be changed from the delivery-planning board in one click even on a processing-locked, already-PO'd order. Treat any board reschedule as unvalidated.
- Logistics/planning reads `amended_delivery_date ?? customer_delivery_date`; MRP and the stock allocator read `line_delivery_date ?? customer_delivery_date` (or `customer_delivery_date` alone) — a board reschedule does not reach production planning, don't assume MRP saw it.
- `delivery_orders` writes `expected_delivery_at` and `customer_delivery_date` from the same source value but both stay independently editable — they can disagree; don't trust one without checking the other.
- The delivery-planning board's synthetic rows (ASSR, DP jobs, project legs) write one leg date into `customer_delivery_date`, `amended_delivery_date`, `effective_delivery_date`, and `processing_date` at once — a synthetic row's "Processing Date" is not a real proceed signal.
- `sales_exemption_expiry` on `mfg_sales_orders` has zero writers but is still rendered as "Tax Exemption Expiry" in the SO listing — it will always be blank, that's expected.
- AutoCount's field named `SalesExemptionExpiryDate` is where the ERP writes the customer delivery date (not tax exemption) — don't reason from the ERP's dead `sales_exemption_expiry` column to what the AutoCount field of the same name holds.
- `target_date` on `mfg_sales_orders` has no UI writer but is still accepted by four API paths (SO/CO create and PATCH) — treat any value in it as leftover, not intent.
- `eta_arriving_port` is typed `TEXT` while every sibling date column is `DATE`/`TIMESTAMPTZ` — Postgres will not catch a bad value written to it.

## Where the code is

- `backend/src/scm/shared/so-processing-date.ts` — Processing Date naming/alias authority.
- `backend/src/scm/shared/effective-delivery.ts` — shared PO effective-delivery reader.
- `backend/scripts/lib/so-processing-date.mjs` — `.mjs`-safe mirror of the above.
- `backend/src/scm/lib/so-stock-allocation.ts` — stock allocation gate (reads `proceeded_at`).
- `backend/src/scm/shared/so-field-policy.ts` — CONTROLLED header field policy/lock.
- `backend/src/scm/routes/delivery-planning.ts` — board reads/writes `amended_delivery_date`, synthetic row date fan-out.
- `backend/src/scm/routes/mrp.ts` — supply-side effective-date formula.
- `backend/src/scm/routes/delivery-orders-mfg.ts` — DO date fields and per-route coercion.
