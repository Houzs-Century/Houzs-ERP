## Rack stock-in/out + rack create/update refusals were silent [medium]

Symptom: In the Warehouse (Rack/REC) desktop page, a refused stock-in, stock-out, rack create, or rack update produced no toast, no inline message, no console line — the classic "the button does nothing". The sibling rack transfer surfaced its failures correctly.

Root cause traced: In frontend/src/vendor/scm/lib/warehouse-queries.ts, useCreateRack, useUpdateRack, useStockIn and useStockOut each carried only `onSuccess` and no `onError`, while useTransfer already used `onError: writeFailedAs('Rack transfer not saved')`. Because authedFetch rejects with the server's own sentence and nothing on these four mutations (nor a consumer) caught it, a backend refusal — area-guard wanting `edit`, a 404 on the other company's row, a 409 before the active company resolves — was dropped on the floor. This is the exact shape documented in mutation-error.ts and swept by frontend/scripts/check-silent-mutations.mjs.

Fix: Added `onError: writeFailedAs(...)` to the four mutations (titles 'Rack not created', 'Rack not updated', 'Stock-in not saved', 'Stock-out not saved'), matching the already-correct useTransfer pattern; writeFailedAs was already imported. Behaviour-preserving except that failures now notify. useDeleteRack has the same silent shape and was left for a scoped follow-up. Ref: <PR>/2026-08-18.
