## ERP edits dropped the office's payment references from AutoCount on carried-over sales orders [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** A carried-over sales order's `SO.UDF_PAYEMENT` holds the office's
payment references, e.g. `(123456/MAYBANK)(654321/CASH)`. After an ERP edit it
held fewer of them.

The book's `EventLog` has 136 "UDF PAYEMENT" changes by MASTER (the write-back
user) from 2026-09-07 to 09-15:

- 76 dropped references the book had, on 74 orders;
- 56 only added references;
- 4 changed spacing only.

On 69 of the 74 orders a real reference was lost; on 4 only the office's wording
inside a bracket, on 1 an empty bracket.

A read-only comparison at 2026-09-15 11:55Z found 415 carried-over orders (334
open, 81 delivered or closed) whose next ERP edit would remove book text:

- 364 would lose a reference the ERP does not hold;
- 49 only a spelling (an extra slash part);
- 2 only a cut-off tail or text outside the brackets.

**Root cause (traced).**

- `composeSoState` (`backend/src/scm/lib/autocount-outbox.ts`) reads
  `readSoPaymentRefs` on every sales order edit.
- `soEditHeader` sends `UDF.PAYEMENT = composePaymentUdf(refs)` whenever the ERP
  holds a reference. The payment-only edit (`ac-so-payment-edit.ts`) does the same.
- The ERP holds a carried-over order's payments only in part. The cutover built
  one ERP row per order, standing for total minus balance, even where the book
  text named several payments. Its account sheet and approval code are the first
  pair only; the rest sit in a note, and only for 363 of 2,795 cutover rows.
- So the composed text is a subset of the book's, and the edit overwrote the
  book's with it.
- Each of the 76 dropping changes matches a sent full sales order edit carrying
  that exact text, within a second. None came from the payment-only edit, only
  because few payments had yet been keyed on such orders.

**Fix (STOPGAP).** New `backend/src/scm/lib/ac-payement-owner.ts`
(`erpOwnsPaymentText`) decides who owns the text:

- The ERP owns it on an order not yet in the book (a create) or in it under an
  ERP number (`HC-`).
- The office owns it on an order carried over under the book's own number.

On an office-owned order, `composeSoState` and `enqueueSoPaymentEdit` pass no
references, so `UDF.PAYEMENT` is omitted and the book keeps the office's text.
`BALANCE` is still sent.

**Cost, accepted for now:** a reference typed on a new ERP payment for a
carried-over order does not reach the book's text.

**Root fix, not built: owner's decision pending.** The ERP keeps the book's own
text, then composes it with new ERP references added after it (whole references,
up to 50 characters). 69 of the 74 damaged orders still differ from the office's
text, per the read-only per-order plan built from `EventLog`:

- 61 restore cleanly;
- 8 need a person to look first.

The other 5 already match again.

**Tests.** `backend/src/scm/lib/ac-payement-owner.test.ts`, 5 tests:

- the owner rule;
- a carried-over order's payment-only edit and full edit carry `BALANCE` and no
  `PAYEMENT`;
- controls: an ERP-numbered order still sends both.

With the two call sites reverted, both carried-over tests fail; restored, they
pass. Two existing composer tests that exercised `PAYEMENT` on a book-numbered
order now use ERP-numbered orders. The AutoCount and payment suites pass.

**Ref.** fix/ac-payement-keep-book, 2026-09-15.
