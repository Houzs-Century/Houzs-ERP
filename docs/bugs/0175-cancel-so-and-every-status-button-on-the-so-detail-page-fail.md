## Cancel SO — and every status button on the SO detail page — failed with "Someone else updated this order" on the first click, with nobody else involved [high]

**Symptom.** Pressing **Cancel SO** on the Sales Order detail page raised
"Status update failed — Someone else updated this order while you were editing.
Your changes are still on this screen. Copy anything you need, then refresh to
review the latest order." No second user, no second tab, no concurrent write.
Reproducible on the first click, every time.

**Root cause (traced, not guessed).** `useUpdateMfgSalesOrderStatus`
(`frontend/src/vendor/scm/lib/sales-order-queries.ts`) built the request body's
`expectedStatus` by reading the status back out of the detail query cache:

```ts
const cached = qc.getQueryData(['mfg-sales-order-detail', docNo]);
body: JSON.stringify({ status, version, expectedStatus: cached?.salesOrder?.status })
```

Its own `onMutate` paints the TARGET status onto that same cache, and
react-query runs `onMutate` **before** `mutationFn`. So the mutation read its
own optimistic write, and `expectedStatus` was always the status being moved
TO. The backend's compare-and-set (`mfg-sales-orders.ts`, `PATCH /:docNo/status`)
is `String(body.expectedStatus).toUpperCase() !== fromNorm -> 409
so_version_conflict`, which `authed-fetch.ts` renders as the sentence above.
`'CANCELLED' !== 'CONFIRMED'` — refused, correctly, against a claim the client
never meant to make.

The `version` half of the CAS was always right; only the status half was
poisoned. That is why the failure looked like a concurrency problem.

**Why the list buttons still worked, and the detail page never did.** On a cold
detail cache `onMutate`'s paint is a no-op (`if (!o.salesOrder) return old`),
and `resolveLoadedSoVersion` then fetches the real row into the cache before
the read — so `expectedStatus` came out correct. The list surface hits that
path; the detail page, which renders FROM that cache, never does. One bug, two
opposite-looking behaviours, which is what kept it read as flaky.

**Evidence.** `frontend/src/vendor/scm/lib/sales-order-status-expected.test.tsx`
mounts the hook against a warm detail cache and asserts the wire body. Before
the fix: `AssertionError: expected 'cancelled' to be 'CONFIRMED'`.

**Fix.** `expectedStatus` is now a REQUIRED mutation variable supplied by the
caller — the surface holds the status the operator was looking at, which is the
only honest source for a CAS — and the hook no longer reads the cache at all.
Per the CLAUDE.md rule on parameters that DECIDE something: making it required
rather than optional is what enumerated the call sites, and `tsc -b` found two
in `SalesOrderDetail.tsx` that a grep for `updateStatus.mutate` had missed.
`null` is accepted and means "this surface does not know the current status" —
the status half of the CAS is then omitted and the version CAS alone guards the
write. Six call sites updated: `SalesOrderDetailV2` (Cancel SO),
`SalesOrderDetail` (Cancel SO, Confirm Order, lock Override),
`MfgSalesOrdersListV2` (Confirm, Reopen), `MobileSODetail` (all transitions).

**Not a defect, checked while here: cancelling does not disturb doc numbering.**
A cancel is an UPDATE of `{ status, version, updated_at }` — `doc_no` is never
written and the row is never deleted (the only two `mfg_sales_orders.delete()`
call sites are the create rollback and the DRAFT discard route). `mintMonthlyDocNo`
counts the month via `fetchMonthlyDocNos`, whose query carries only
`.like(col, '<prefix>-%')` and no status predicate, then takes max+1 — so a
cancelled order keeps its number, still counts toward the max, and the next
order takes the next integer. Numbering stays contiguous and is never reused.

**Ref.** 2026-08-14.
