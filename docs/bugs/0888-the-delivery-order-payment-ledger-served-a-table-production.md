## The delivery order payment ledger served a table production never had [low]

<!-- area: Delivery, DO, returns -->

**Symptom.** Nothing a person saw, and that is why it lasted. Two ledger entries
described this ledger as live: `docs/bugs/0704` says money taken at the door "is
taken by a reachable screen and stops at our database", and `docs/bugs/0850` opens
its root cause with "`scm.delivery_order_payments` exists". Both were written from
the source. Neither was checked against the database.

**Root cause (traced).**

- **PROVEN — the table is not there.** A read-only probe against production
  (Supabase `anogrigyjbduyzclzjgn`, one SELECT, 2026-09-14 07:53 UTC):
  `to_regclass('scm.delivery_order_payments')` = `NULL`, and the only relation of
  that name in `information_schema.tables` is `public.delivery_order_payments`
  (BASE TABLE) — the legacy copy, still on `amount_centi`, which the scm-scoped
  client (`db.schema = 'scm'`) never reads. The same absence was first recorded
  2026-09-12 in `docs/migrated-so-lock-lifted-coe.md`. No file in
  `backend/src/db/migrations-pg/` or `backend/src/db/migrations/` creates it.
- **PROVEN from source — nothing could write to it.** `useAddDeliveryOrderPayment`
  and `useDeleteDeliveryOrderPayment` had zero call sites (0850 measured it), and
  no mobile screen calls `/delivery-orders-mfg/:id/payments` (`MobilePOD.tsx`
  never mentions a payment). So no payment was ever recorded on a delivery order
  and none was lost. 0704's gap — door money that AutoCount never hears about —
  had no money in it.
- **LIKELY — one read fired and failed on every invoice raised from a DO.**
  `SalesInvoiceNew.tsx` called `useDeliveryOrderPayments(fromDo)` on every mount
  with `?fromDo=`, and the only way there (`SalesInvoiceFromDo.tsx`) passes
  `fromPicks=1`, which then threw the result away. Against a missing relation the
  GET handler's `if (error) return … 500` is the only exit, and
  `retryUnlessClientError` retries a 500 once. Read from the source against the
  proven absence; not observed in a log.

**Fix.** The owner's rule since 2026-09-12 is that the sales order is the one
place a payment is taken — 「SO 的付款要带去 DO 跟 SI」 — and the delivery order
and the invoice SHOW that ledger (0850, #3757). A second ledger on the delivery
order that cannot store anything contradicts that rule, so it is removed rather
than given a table:

- `backend/src/scm/routes/delivery-orders-mfg.ts`: `GET` / `POST` / `DELETE
  /:id/payments`, `PAYMENT_COLS`, the zod body schema and the two imports only they
  used. A short comment stands where they were, so the next reader who wants a
  delivery-order payment meets the ruling before rebuilding it.
- `frontend/src/vendor/scm/lib/delivery-order-queries.ts`: the three hooks and
  `DoPayment`; the re-export in `sales-invoice-queries.ts`; the DO-payment prefill
  in `SalesInvoiceNew.tsx` (the invoice still shows the order's own ledger
  read-only, as before).
- The `check-do-payment-book-gap` script and its workflow are deleted. It
  selected from the missing table, so a dispatch could only fail, and the question
  it asked — is money keyed on a delivery order missing from the book — has no
  subject when no such payment can exist.
- Guides corrected: `docs/modules/delivery-order.md` (route table, hooks, tables,
  the "money taken at the door" paragraph, the desktop/mobile pair) and
  `docs/modules/autocount-writeback.md` (the "second money table" note). Generated
  route docs regenerated.

No test is added: this removes a surface, it does not change a rule. The typecheck
is what proves nothing still imports the removed hooks.

Left alone on purpose: `public.delivery_order_payments` stays in place. Dropping a
table is its own decision, and nothing in the application reads it.

**Lesson.** Two careful entries built on "the table exists" because the route
file said so. A route is a statement about what the code expects, never about
what the database holds — the rule `CLAUDE.md` already carries ("Reading code is
not evidence about production"), missed twice on the same table.

**Ref.** fix/do-payment-ledger-never-existed, 2026-09-14. Corrects
`docs/bugs/0704` and `docs/bugs/0850`.
