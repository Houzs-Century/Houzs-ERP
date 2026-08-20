## Three cross-tenant leaks: grant escalation, foreign-warehouse stock, pooled customer credit [high]

<!-- area: Auth, permissions, sessions -->

**Symptom.** None observed; found by audit. Two companies share one database and
one service-role connection, so Postgres RLS never runs — tenancy holds only
where application code remembers a predicate.

**Root cause (traced).** (1) `PUT /api/users/:id/companies` validated requested
grants against the whole `companies` master rather than the caller's allow-list
and carried no self-guard, so a holder of the flat global `users.manage` scoped
to one company could grant themselves the other on their own id and
`companyContext` would honour it on the next request. (2) `POST
/scm/stock-transfers` took both warehouse ids from the body checked only for
presence and inequality, and `fn_stock_transfer_apply`'s FIFO consumer keys on
`(warehouse_id, product_code, variant_key)` with no company argument — it
consumed the other tenant's lots at their cost; `GET /scm/inventory/` returned
the foreign uuids that made it practical. (3) Customer credit summed by
`debtor_code` alone while `customer_credits.company_id` is NOT NULL and
`customers.customer_code` is unique per `(code, company_id)` — the same code
names a different customer in each company, and the debit was stamped with the
SI's company, which kept it silent.

**Fix.** Grants validated against `allowedCompanyIds(c)`; both warehouse ids
proven in-company and the inventory read scoped; credit balance takes a required
`companyId`. Measured against production while assessing severity: of 96 users,
**0** have an empty grant list — nobody stands on the middleware's documented
fail-open path — 79 hold one company, 17 hold both.

**NOT COMPLETE.** The atomic credit RPC carries the same unscoped SUM in its own
body. The SQL is fixed here but that function is applied by hand:
`scripts/scm-schema/apply-customer-credit-atomic.mjs` must be re-run or the
preferred path still pools. Separately, `rename_sofa_compartment`
(`port-missing-functions-triggers.sql:170`) is SECURITY DEFINER with 25 UPDATE
statements and no `company_id` anywhere — one call rewrites both tenants' item
codes including `grn_items.supplier_sku`, the AutoCount write-back key. Neither
is fixed here.

Ref: PR #2382, 2026-08-18.
