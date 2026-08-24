## A payment recorded in one company moved the OTHER company's invoice [high]

**Symptom.** None at the keyboard, which is why seven of these survived. An
operator with company A active opens company B's invoice by id and records a
payment. The payment row is filed under **A**. `recomputePaid` then moves **B's**
`paid_centi` and flips B's AR status SENT -> PARTIALLY_PAID -> PAID. Both books
are now wrong and neither shows an error.

**Root cause — A STAMP IS NOT A PREDICATE.** Every one of these handlers read a
document BY ID with no company predicate and then wrote a child row stamped with
the ACTIVE company:

```ts
const { data: si } = await sb.from('sales_invoices').select(...).eq('id', id).maybeSingle();
...
await sb.from('sales_invoice_payments').insert({ company_id: activeCompanyId(c), ... })
//                                               ^ this is a STAMP, not a check
```

The stamp is what makes it silent: the row looks correctly attributed while
sitting on the wrong parent. `sales-invoices.ts:2068` carried a comment reading
*"multi-company: match the SI's company"* directly above a line that never
compared anything.

**Seven sites, all confirmed by reading the source:** `sales-invoices.ts`
`POST /:id/payments` (:2068), `PATCH /:id/payment` (:2555, the Outstanding page's
quick-pay), `DELETE /:id/payments/:paymentId` (:2152 — takes a payment OFF the
other company's invoice; the existing `payment_doc_mismatch` check only proves
the payment belongs to the invoice in the URL, never whose invoice that is),
`GET /:id/payments` (:1971), `POST /:id/items/from-do/:doId` (:1461),
`delivery-orders-mfg.ts` `POST /:id/items` (:4593 — the ADD verb, the only one of
three left unscoped; on an already-shipped DO the resync moves the OTHER
company's stock), and `delivery-returns.ts` `POST /` + `/from-do(s)`.

**Two of them are CONVERTERS, and that is the sharper half.** `companyScope.ts`
names four conversions that each refuse a cross-company source (SO->DO, SO->SI,
DO->SI, PO->GRN). The partial DO->SI form and the whole DO->DR path checked
NOTHING — so a 2990 delivery could be folded into a Houzs invoice and 2990's
revenue posted to Houzs' books, or returned as a HOUZS return with a Houzs
document number, writing the stock back in against the wrong ledger.

**Fix.** `scopeToCompany` on every header read; `isCrossCompanySource` +
`crossCompanyConversionBlocked` on both unguarded converters. 8 new tests in
`tests/companyScopeSalesInvoiceMoney.test.ts`, proved non-vacuous by reverting
the fixes (3 of 8 fail) and restoring them (8 pass).

**Lesson, and it is about the tooling as much as the code.**
`check-company-scope.mjs` reported **0 WRITE findings** while all seven existed,
because `.from('x').insert({ company_id: activeCompanyId(c) })` contains a real
`.from(` query and the helper's name, so its scoped-ness test passed. That is the
FIFTH blind spot found in that script in one day, and like the other four it made
the number too SMALL. The checker now strips an insert payload before testing,
and the honest count went 0 WRITE -> 11 WRITE.

**Ref.** 2026-08-13, audit ledger §A.
