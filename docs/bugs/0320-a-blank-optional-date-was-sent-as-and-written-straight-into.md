## A blank optional date was sent as "" and written straight into a DATE column [high]

<!-- area: Purchase orders + GRN + PI -->

**Symptom.** "Save failed — The system hit a problem." on any Purchase Order
that left Supplier Date 2/3/4 empty, which is most of them.

**Root cause (traced).** `PATCH /api/scm/mfg-purchase-orders/:id` with
`supplierDeliveryDate2: ""` → 500 `invalid input syntax for type date: ""`.
The same request with `null` → 200; with the key omitted → 200. The frontend
maps a null column to `''` for the input element and sends it back verbatim;
every backend write guarded `undefined` with `?? null`, which does not catch
`''`. One file in the whole backend had a guard — `delivery-orders-mfg.ts` had a
local `emptyDate()`. Sales Orders escaped only because one frontend line
happened to use `|| null`. Not an AutoCount fault: `queueAcPoEdit` runs after the
update and is never reached.

**Fix.** `lib/date-coerce.ts` `dateOrNull` / `coerceEmptyDates`, applied to every
request-body date write across 17 route files including `routes/projects.ts` and
`dp-orders.ts`, and to the generic `updates[to] = body[from]` field-map loops
that the column-name sweeps miss. `tests/dateWriteCoercion.test.ts` parses every
`.ts` under `backend/src` with the TypeScript compiler API and fails on any
request-supplied value reaching a DATE/TIMESTAMPTZ column uncoerced — no
allowlist. It reports 0 here and **89 on an unpatched origin/main**, including
the exact PATCH above. `tests/fixtures/date-write-probe.ts` is the detector's own
self-test, so a scanner that stops matching fails there rather than reporting a
clean backend.

Ref: PR #2382, 2026-08-18.
