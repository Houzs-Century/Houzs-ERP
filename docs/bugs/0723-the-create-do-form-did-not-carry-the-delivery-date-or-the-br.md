## The Create-DO form did not carry the delivery date or the branding from the sales order it was prefilled from [medium]

<!-- area: Delivery, DO, returns -->
<!-- status: fixed -->

**Symptom.** Owner, 2026-09-08, after the migrated-DO repairs (docs/bugs/0714,
0716): 「还有DO是没有显示客户信息的吗？」. The sales-fields backfill run in PLAN
mode with `scope=all` (runs
[`34236822909`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34236822909)
company 1,
[`34236827147`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34236827147)
company 2) found the gap had moved: the customer card was full everywhere, but
**12 company-1 DOs (`HC-DO-2609-001`…`012`) and 35 company-2 DOs**, all raised
this month through the ERP's own Create-DO form, had `branding`, `ref`,
`customer_delivery_date` and `expected_delivery_at` NULL while their sales order
named every one. None was migrated.

**Root cause (traced).** `frontend/src/pages/scm-v2/DeliveryOrderNewV2.tsx`.
The from-SO prefill (`useEffect` on `soSource.data`, `:686-712`) seeded
customer, code, ref, phone, email, type, salesperson, four address fields, sales
location, building type and venue — and stopped there. `customerDelDate` was
never seeded, so the DO's `customer_delivery_date` was whatever the operator
typed, usually nothing; `expected_delivery_at` then fell back to it on the server
(`POST /`, `delivery-orders-mfg.ts`: `dateOrNull(expectedDeliveryAt) ??
dateOrNull(customerDeliveryDate)`) and was NULL too. `branding` had no state, no
input and no key in `buildHeaderBody`, so the server's `(body.branding as
string) ?? null` wrote NULL. The server route accepts all of them; the form
never sent them. `/from-sos` (the mobile wizard's path and the desktop picker's
commit) copies every one server-side, which is why only form-raised documents
show the gap.

`ref` is a different story and is NOT a defect: the form maps the SO's
`customer_so_no ?? ref` into `customerSoNo`, the drawer's Customer ref reads
`po_doc_no || customer_so_no || ref`, so the value shows. The backfill filled
`ref` from the SO as well; both columns now agree.

**Fix.** The form seeds `customerDelDate` from `so.customerDeliveryDate` and
carries `branding` as a hidden header state — set from the source on prefill,
from the document on edit, posted in `buildHeaderBody` — the way `/from-sos`
carries it. Expected-at stays the operator's field: blank posts as null and the
server falls back to the customer date, exactly as `/from-sos` does.
`REPORTED_FIELDS` in `src/scm/lib/so-to-do-fields.ts` gains **Delivery Date**,
so the banner names it when the source order has none
(`backend/tests/soToDoFields.test.ts`, the empty-source case now counts 12).

**Documents already written** were filled by
`backfill-migrated-do-sales-fields.mjs` with `scope=all`: apply runs
[`34237593431`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34237593431)
(company 1: 12 of 12, values not as planned 0) and
[`34237682845`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34237682845)
(company 2: 35 of 35, values not as planned 0). Both runs show red for a
verify defect of their own, docs/bugs/0724 — the data is correct. What is still
NULL is NULL on the sales order: company 1 `branding` 2, `customer_delivery_date`
23; company 2 `agent` 56 and `ref` 59 (2990 orders carry neither), `branding` 2.

**Ref.** `fix/do-sales-fields-form-and-verify-0908`, 2026-09-08. Related:
docs/bugs/0716 (the same six columns on migrated documents), docs/bugs/0714.
