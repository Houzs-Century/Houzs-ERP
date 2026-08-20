## PUT /:id/crew overwrote another company's delivery-order driver and crew [high]

**Symptom.** None at the keyboard. `PUT /delivery-orders-mfg/:id/crew` accepted a DO uuid from either company and wrote the crew assignment — and the DO header's driver/vehicle quick-fields — against whichever company that DO belonged to.

**Root cause traced.** The handler loaded the DO with `.eq('id', id).maybeSingle()` and no company predicate; it read `doRow.company_id` into `doCompanyId` but only used it to stamp the crew row and the audit, never to compare against the active company. Both writes then carried no predicate: the header `update({driver_id, driver_name, vehicle}).eq('id', id)` and the `delivery_order_crew` upsert keyed on the cross-company `do_id`. The SCM client is the service-role client (mig 0061 enabled RLS with no policies, so RLS is bypassed), making the path id the entire tenant boundary. So a company-A staffer with a known company-B DO uuid overwrote B's driver/crew. The sibling `PATCH /:id` in the same file was already correct — this write path is the same door, left unlocked.

**Fix.** `requireActiveCompanyId` (refuse 409 on unresolved) + `scopeToCompanyId` on the DO read, returning the shared `NOT_THIS_COMPANY` 404 on a miss, plus `scopeToCompanyId` on the header write itself (predicate on the write, not only the read). The crew upsert needs no extra predicate — a gated read proves `do_id` is in-company.

**Ref.** 2026-08-18, branch `vocab-custref-mig`. Same class and same fix as the payment-voucher post leak above.
