## Delivery orders carried over from AutoCount could not be invoiced, though AutoCount had never invoiced 120 of them [high]

<!-- area: Cutover + migrated data -->

**Symptom.** The owner's screenshot of 2026-09-15: a salesperson raising a
sales invoice from HC-DO-011484 got **Save failed** — *"This delivery or receipt
was carried over from AutoCount, so its invoice has to mirror the AutoCount one
exactly — run the migrated-invoice converter instead of building it by hand."*
Nobody outside IT can run that converter, and for this delivery there was no
AutoCount invoice to mirror anyway.

**Root cause (traced).** `migratedRefusalForDeliveries`
(`backend/src/scm/lib/si-from-do.ts`) refused every delivery flagged
`migrated_no_stock`, on every path that attaches a delivery to an invoice. Its
premise was that AutoCount had already invoiced it — rule 2 of
`lib/migrated-chain.ts`, written on 2026-08-11 while AutoCount still raised the
invoices.

After go-live the ERP raises them, and the premise was measured against the
book on 2026-09-15:

- 172 carried-over deliveries are not cancelled;
- 52 were invoiced in AutoCount, of which 50 already hold their mirrored invoice
  and 2 are old deliveries (HC-DO-000097, HC-DO-003699);
- **120 were never invoiced in AutoCount.** Measured by `DocTransfer` from the
  delivery's lines to any invoice that is not cancelled.

122 carried-over delivered orders had no ERP invoice, and 120 of those could
not be billed at all. 94 of them were delivered in September.

For those 120, none of the harms the refusal names exists: there is no
AutoCount number to keep, no revenue AutoCount booked, and no book invoice for
the `do_to_iv` transfer to duplicate. Two more facts:

- The office stopped raising invoices in AutoCount at go-live. The last two not
  numbered by the ERP, I-2609-0002 and -0003, were created on 2026-09-07 at
  14:41, and none since.
- Of the 120, 113 deliveries carry the AutoCount key on every line, so their
  transfer can name its lines. That includes HC-DO-011484, 8 of 8.

**Fix.**

- **The measurement.** `list-migrated-deliveries.mjs` (ERP, read-only) and
  `export-migrated-deliveries-not-invoiced.py` (book, read-only, NOLOCK) measure
  which carried-over deliveries AutoCount never invoiced. They write
  `src/scm/lib/migrated-deliveries-not-invoiced.generated.ts`, 120 numbers.
- **The rule.** `deliveryMustMirrorAutoCount` (`lib/migrated-chain.ts`) refuses
  a migrated delivery only when it is not on that list. `migratedRefusalForDeliveries`
  applies it, so all four paths change together. A delivery the measurement
  does not name is still refused.
- **What an invoice now gets.** An invoice raised from a listed delivery is an
  ordinary one: `sales_invoices.migrated_no_stock` stays false, so revenue posts
  and the `do_to_iv` transfer is queued. Posting and the AutoCount transfer are
  UNTESTED on production until the first such invoice is raised.

Receipts carried over from AutoCount (goods receipt to purchase invoice) keep
the blanket refusal. On 2026-09-15, 136 of them had no ERP purchase invoice:

- 23 map to a book receipt AutoCount billed;
- 25 map to one it never billed;
- 52 map to no book receipt at all.

A purchase invoice also moves the goods-received-not-invoiced account, which a
carried-over receipt never credited in the ERP. That side needs its own
decision.

Pinned in `src/scm/lib/migrated-chain.test.ts`. Three new tests fail on the
unfixed tree (`deliveryMustMirrorAutoCount is not a function`), and all 36 of
the suite's tests pass after. The new tests cover:

- HC-DO-011484 is not refused;
- HC-DO-000097 still is;
- a delivery missing from the measurement is refused, and an ordinary delivery
  never is;
- the list holds only migrated delivery numbers, and not the two AutoCount
  invoiced.

**Ref.** fix/migrated-do-invoicing, 2026-09-15.
