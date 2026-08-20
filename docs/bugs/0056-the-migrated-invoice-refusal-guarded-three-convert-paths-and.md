## The migrated-invoice refusal guarded three convert paths and there are eight [high]

**Symptom** - a goods receipt or delivery order carried over from AutoCount could
still be turned into an invoice by hand, even after `refuseMigratedSources` was
added. Nothing about it would be visible afterwards: the invoice would carry an
ERP number instead of AutoCount's, post a journal entry for money AutoCount had
already booked, and enqueue a write-back that creates a SECOND invoice in the
live AED_HOUZS book. It would also consume the source line's invoiceable
quantity, so the mistake could not be corrected without cancelling the invoice.

**Root cause (traced, not guessed)** - the refusal was written on the three paths
that take a WHOLE document (`POST /from-grn`, `POST /from-grn-items`,
`POST /from-dos`). Five more paths reach the same lines holding only a line id or
a delivery id, and each one bypassed the rule entirely:

```
purchase-invoices.ts  POST /                        lines carry grnItemId
purchase-invoices.ts  POST /:id/items               line carries grnItemId
sales-invoices.ts     POST /                        lines carry doItemId, body carries deliveryOrderId
sales-invoices.ts     POST /:id/items               line carries doItemId
sales-invoices.ts     POST /:id/items/from-do/:doId takes a whole delivery id
```

A fence with an open gate beside it is not a fence.

**Fix** - both routers resolve the source document from the line id first, then
apply the SAME `refuseMigratedSources` rule, so a caller cannot pick a softer
door. A FAILED lookup refuses rather than proceeds (`ok: false` -> 500): a guard
that fails open is not a guard. `backend/tests/migratedConvertGuard.test.mjs`
pins all eight paths, asserts the refusal comes BEFORE the AutoCount enqueue (a
refusal after it is no refusal at all), and asserts the GL suppression lives
inside `postPiAccounting` / `postSiRevenue` rather than at their call sites, so
every caller is covered by construction. It runs in `test:scale-contract`, which
is `pretest`.

Counterfactuals, both numbers: with the fix **4 pass / 0 fail**; strip the SI
guards **1 pass / 3 fail**; strip the PI guards **2 pass / 2 fail**; strip the
`postSiRevenue` suppression **3 pass / 1 fail**.

**Ref** - PR for `feat/migrated-chain-invoices`, 2026-08-11.
