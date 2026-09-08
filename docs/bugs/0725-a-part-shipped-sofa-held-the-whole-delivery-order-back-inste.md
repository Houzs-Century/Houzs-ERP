## A part-shipped sofa held the whole delivery order back instead of just its own line [med]

<!-- area: AutoCount sync + write-back -->

**Symptom.** `docs/bugs/0722` merged the sofa's repeated line key and, where the
sofa was only part-shipped, REFUSED the whole conversion — every line of it. A
delivery carrying one sofa piece and three pillows put nothing in the account
book, because of the sofa.

That refusal was written as a deliberate stand-in, and the entry said so: the
answer belonged to the owner. He gave it the same day.

**The owner's ruling, 2026-09-08 — option C.** Asked to choose between waiting
for the whole document, sending the sofa early, and restructuring the account
book, he chose:

> **the sofa's own line waits for the delivery that completes it, while every
> other line on the document goes on time**

and then narrowed it himself:

> 「C 除了accessories 不看 就看sofa」

— completeness is judged on the SOFA'S OWN PIECES. A pillow still in the
warehouse never holds the sofa back.

**Why this shape and not the other two.** A sofa in AutoCount is one line of one
unit; "two of its three pieces" has no shape there at all. Sending it early puts
goods in the ledger that are still in the warehouse — the silent class this
module exists to prevent. Restructuring the book to match the ERP's pieces would
change every historical sofa document and the item master, to remove one defect.
Waiting costs a delay on one line and nothing else, and the sofa's accounting
date becomes the day it was actually delivered whole, which is the correct
treatment.

This is also what a kit or assembly does in SAP, Odoo and NetSuite: the picking
layer explodes into components, the accounting document keeps the parent line.

**Fix.**

* A shared key that is not yet whole is **held out of the payload**; every other
  key on the document goes. The document is queued, not refused.
* **Completeness is counted across EVERY delivery, not just this one.** Each trip
  takes one piece, so "did THIS document take them all" answers no on the very
  trip that completes the sofa — it would wait for ever. The delivery that covers
  the last piece is the one that carries the sofa into the book.
* Keying the decision on the shared DtlKey gives the owner's accessories rule for
  free: a pillow has its own key and is a different question.
* **A document that is ONLY an incomplete sofa is still refused**, and that is not
  a special case to remove: a transfer naming no lines makes the service fall
  back to every outstanding line on the source, which is the defect this whole
  function exists to prevent.
* The coverage read is best-effort in the SAFE direction — unreadable coverage
  leaves the key waiting. Holding is recoverable; a sofa in the book that is
  still in the warehouse is not.

**Verified.**

* `autocount-convert-lines.test.ts` — **17 passed**, four of them new: the sofa
  waits while the pillow goes; an undelivered accessory does not hold the sofa;
  the delivery covering the LAST piece carries it (counted across documents, not
  within one); and a document that is only an incomplete sofa is refused rather
  than sent empty.
* With `autocount-outbox`, `salesInvoiceAutoCountSource` and the payload contract
  — **153 passed**.
* `npm --prefix backend run typecheck` clean; `audit:swallowed-reads` at ceiling.

**UNTESTED against the live book.** No part-shipped sofa has gone through this
path in production; the ten documents cleared on 2026-09-08 were all whole.

**What this deliberately accepts.** The AutoCount delivery order will have FEWER
lines than the ERP's for as long as a sofa is incomplete, and the sofa then lands
on a later delivery order than the one its first piece shipped on. That is the
trade option C makes, chosen with the alternatives on the table.

**Ref.** feat/sofa-line-waits-for-its-last-piece, 2026-09-08. Follows
`docs/bugs/0722-a-sofa-is-one-line-in-the-book-and-several-in-the-erp-so-its.md`.
