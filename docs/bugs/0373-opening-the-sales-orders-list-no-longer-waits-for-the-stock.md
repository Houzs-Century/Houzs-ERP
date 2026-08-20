## Opening the Sales Orders list no longer waits for the stock-planning engine — the purchase-order and readiness columns fill in a moment later [medium]

<!-- area: Sales orders + pricing -->

**Symptom (what it cost).** Every open of the Sales Orders list ran the full
stock-planning engine (`computeMrp`) before the page could return. That engine
scans the company's whole product / stock-balance / purchase-order /
sales-order-line tables on every single list open — the dominant remaining delay
on the most-used screen in the system.

**Root cause traced.** The list handler
(`backend/src/scm/routes/mfg-sales-orders.ts`) fired one `computeMrp` per load.
It was believed to exist ONLY to fill the READY side of the "PO No." column, but
its result (`mrpLineCoverage`) also feeds the readiness verdict the list rolls up
(`readinessLinesByDoc` → `effectiveLineStockStatus`, the 2026-08-17 stored-vs-live
union). That verdict drives FOUR visible fields, not one: the desktop Stock Remark
pill (`stock_remark`), the mobile readiness badge (`is_main_ready`), the mobile
planning badge (`planning_state`, via `derivePlanningState`'s `isShipReady`), and
the READY arm of the "PO No." chips (`source_po_union`). So the engine could not
just be deleted without reverting those.

**Fix.** The list now returns immediately with the SHIPPED-only chips and the
stored-status readiness placeholders each of those fields had before the
2026-08-17 live union. A new read-only endpoint —
`GET /mfg-sales-orders/list-mrp-enrichment?docNos=…`
(`backend/src/scm/routes/mfg-sales-orders-list-enrichment.ts` +
`backend/src/scm/lib/so-list-mrp-enrichment.ts`) — runs the SAME company-wide
`computeMrp` OFF the critical path and returns the four MRP-derived fields for the
page's docs. Desktop (`MfgSalesOrdersListV2`) and mobile (`MobileSalesOrders`)
fetch it once for the visible rows (chunked at 100 so mobile's infinite scroll
stays bounded) through one shared hook (`useSoListMrpEnrichmentMap`) and one shared
overlay (`applySoListMrpEnrichment`, `frontend/src/lib/soListEnrichment.ts`), and
heal the four fields. Union(shipped-only, ready-only) per doc equals the old
combined union (set union is associative), so the FINAL displayed values are
byte-identical — they arrive a beat later.

**Behaviour change, stated plainly.** On first paint the READY "PO No." chips, the
Stock Remark pill, and the mobile readiness / planning badges show their
stored-status value, then heal within one follow-up request. This is the same
"arrive a beat later" trade the READY chips were already understood to make,
extended to the three sibling fields the same engine fed. A production stopwatch
(the exact ms removed from the list's time-to-first-byte) needs a probe the owner
sets up and is deferred.

**C16 guard (Hookka rule — pin the projection's whole key set in the same
commit as the split).** The four MRP-derived fields are pinned as ONE named set,
`MRP_DERIVED_LIST_FIELD_MAP` (`frontend/src/lib/soListEnrichment.ts`) with its
backend twin `SO_LIST_MRP_ENRICHMENT_KEYS`
(`backend/src/scm/lib/so-list-mrp-enrichment.ts`). Parity tests assert the client
overlay heals EXACTLY that set and the endpoint returns EXACTLY that shape, so a
future field added to the list projection but not routed through the enrichment
overlay (or the reverse) fails CI with the drifting key named — the C16 failure
mode (a field that heals on one surface but stays stored-only on another) cannot
ship silently. Proven red by making the overlay write an unpinned field.

**Ref.** 2026-08-18, branch `perf/mrp-off-list-load`. Tests:
`backend/tests/soListMrpEnrichment.test.ts`,
`frontend/src/lib/soListEnrichment.test.ts`.
