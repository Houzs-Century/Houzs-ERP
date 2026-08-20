## Tenant scope: eight helpers left `companyId` optional, so a future caller could leak across companies [medium]

**Symptom.** No live leak — every current caller passes the company. But eight
scope-deciding helpers typed `companyId` as OPTIONAL (`companyId?: number`), and
each "degrades open" (`if (companyId != null) q = q.eq('company_id', companyId)`).
A future caller that simply forgot the argument would read/write the OTHER
company's rows in the merged DB, with no compile error and no runtime signal —
the exact `optional-param-noop` class at the top of this file (the same shape the
`replaceItems`/`replacePayments` fix closed on 2026-08-18).

**Root cause (traced).** `companyId?: T` means every caller that says nothing keeps
the permissive default. Found by the recurring-class hunt: `resolveDoSofaBatchMap`
+ two others in `delivery-orders-mfg.ts`, `reallocateGrnCharges` /
`computeAndStoreGrnAllocation` (`grns.ts`, landed-cost money), `mfg-products.ts`
`syncAnchorBindingFromProduct`, `customer-credits.ts`, `fabric-tracking.ts`,
`mfg-purchase-orders.ts`. All current call sites were verified to pass
`activeCompanyId(c)` / the doc's company, so nothing leaks today.

**Fix.** Flip all eight signatures to REQUIRED `companyId: number | null`, so the
compiler enumerates every call site. Three `resolveDoSofaBatchMap` calls that
passed nothing now pass the DO header's `company_id` (a correct tightening); the
rest pass `activeCompanyId(c) ?? null` (behaviour-preserving); the deliberate
UNRESOLVED sentinel in `procurement-execute.ts` moves `undefined` -> `null` (the
consumers gate on `!= null`, which is identical for both). Backend typecheck 0.

**Ref.** fix/company-scope-optional-params, 2026-08-19.
