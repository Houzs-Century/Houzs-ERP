## A goods line written with no warehouse said nothing, three times over [medium]

**Symptom.** None at the moment it happens — which is the defect. Reported only
when someone noticed the downstream effect on 2990-SO-2607-028 (see the entry
above): a line with `warehouse_id = NULL` matches no allocation bucket
(allocation is keyed by warehouse + item + variant), so it never leaves PENDING
and never shows an incoming PO, while its goods may already be received into the
right bucket in the right warehouse.

**Root cause of the BLINDNESS, separate from the causes of the NULLs.** Three
different write paths could produce such a line and not one of them said
anything. So of the 18 found on 2026-08-18, two groups could only be attributed
afterwards by comparing insert timestamps against audit rows — a single
microsecond-identical statement with no audit rows identified
`apply-sofa-compartment-corrections.mjs` — and the third, the reported line,
still cannot be attributed at all: it was inserted 229 ms before an
`UPDATE_LINE` audit row, by the sofa re-split inside the line-update path, whose
`baseRow` DOES carry `warehouse_id: it.warehouseId ?? defaultWarehouseId`.

**Fix.** `lib/null-warehouse-signal.ts`, called from all three SO-line write
paths (create, sofa-split add-line, single-row add-line). It LOGS and never
throws: a NULL warehouse is legitimate on an order with no address yet — 10 of
the 18 are exactly that — and refusing the write would turn a reporting gap into
an outage. What it buys is attribution: the next occurrence names its own route,
document and item under a greppable `[null-warehouse]` tag.

The hourly sentinel gained a matching alarm with a committed baseline of 10 (the
addressless lines nobody can resolve without a human). Raising that number to go
green is called out in the file as the thing not to do, same as the orphan
baseline beside it.

**Service lines are deliberately excluded.** They hold no stock and allocation
skips them by design, so a NULL there means nothing — and a guard that fires on
every delivery-fee line is one somebody turns off.

**What this does NOT do.** It does not explain the third group, and it does not
prevent any of the three. It converts a silent write into a signal, so the next
one is attributable in one grep instead of by forensics.

**A lead recorded rather than acted on.** `lib/so-warehouse.ts` resolves an
order's warehouse as `sales_location` first, then `customer_state`. The WRITE
path derives from `customerState` alone. 2990-SO-2607-028 carries
`sales_location = 'KL WAREHOUSE'`, so a line-update request that does not send
`customerState` would resolve NULL on a document that plainly names its
warehouse. Not proven — the guard is what will prove or kill it.

**Ref.** PR (branch `chore/null-warehouse-guard`), 2026-08-18.
