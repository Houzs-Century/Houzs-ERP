## A recorded payment never reached AutoCount — BALANCE went stale the moment it was sent [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** The owner's goal for the write-back, in his words: *"我们记录新的
payment，它就是可以进去。"* It did not. #2218 started sending the outstanding
balance as the `BALANCE` UDF, and from that moment the account book carried a
figure that was correct when the order was last SAVED and wrong from the next
payment onwards. A fully settled order kept showing a debt until somebody
happened to edit a line or the header.

**Root cause, traced by enumerating the call sites, not by reading the design.**
Every SO mutation route funnels through `queueAcSoEdit`, and there are eleven
such call sites in `scm/routes/mfg-sales-orders.ts` — the header CAS save, line
add / edit / delete, the three `tbc-*` swaps, the price override. The last one
sits at line 10403. The three routes that mutate the payments ledger start at
10958 (`POST /:docNo/payments`), 11146 (`PATCH`) and 11357 (`DELETE`), and none
of them queued anything. A payment changed money the account book holds and the
ERP said nothing about it.

Two things kept it invisible:

- `src/scm/lib/autocount-outbox.test.ts` has a case literally named *"an EDIT
  carries it too, so a payment taken after the create reaches the book"*. It
  passes, and it always would have: it calls `enqueueEdit` itself. A composer
  test cannot see a missing call site.
- `tests/autocountWritebackWiring.test.ts`'s *"every SO mutation path queues an
  edit"* checks seven hand-listed places. A payment is an SO mutation and was in
  none of them, so the word `every` was false and the suite stayed green — the
  **unverified-completeness-claim** class at the top of this file, this time in a
  test name rather than a PR body.

**Fix.** The enqueue goes into `recordSoPaymentRow`, the factored insert core,
NOT into the HTTP route: `scan-so.ts` books scanned receipts through the same
core with no request context, so a rule written into the route would have
covered the payments a human typed and silently missed every scanned one — this
module's recurring shape. `PATCH` and `DELETE` call `queueAcSoEdit` in their own
closures, having no shared core. `POST /:docNo/payments/:id/slip` deliberately
does not: it attaches proof and moves no money.

`src/scm/routes/soPaymentQueuesAcEdit.test.ts` pins the core — the queued edit
must carry the balance AFTER the payment (500.00 ordered, 300.00 taken, `200.00`
sent), a settling payment must send `0.00` rather than dropping the key, the
toggle OFF must queue nothing, an order with no AutoCount counterpart must queue
nothing, and a dead queue must not fail the payment. Its three positive cases
were observed RED with the enqueue neutralised. The three route anchors are
pinned in `tests/autocountWritebackWiring.test.ts` under their own test rather
than by widening the "every" claim that already failed to hold.

**Ref.** 2026-08-15, PR #2228.
