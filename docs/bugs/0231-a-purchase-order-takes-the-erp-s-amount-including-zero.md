## A purchase order takes the ERP's amount, including ZERO [medium]

<!-- area: AutoCount sync + write-back -->

**Owner 2026-08-16:** *"就是 ERP 的，我填写多少就多少，我填写 0 就 0"*.

Two separate things stood between that and the book.

**1. Nothing sent an amount at all.** `UnitPrice` appears **nowhere** in
`backend/src/scm/lib/autocount-outbox.ts`, so a purchase order raised from a
sales order carried the SALES price the transfer brought across. The service
side now applies what it is given; the composer still has to send it.

**2. AutoCount refuses zero-value documents by default.** Every document class
carries `EnableZeroNetTotalChecking` and the service never touched it. That
check is meant for a human typing into the entry screen; here the number came
from the ERP deliberately, and a zero-value purchase order is a real thing —
free replacement, warranty supply, a line to be priced later. Turned off through
`Set()`, so a class that does not expose it costs the flag and never the
document.

**PROVEN:** `/so-to-po` sent `UnitPrice: 0`, and the book reads back
`UnitPrice=0` — not the sales price the transfer would otherwise have left. A
zero that survives is the strongest available evidence that the ERP governs.

**Ref:** this PR, 2026-08-16.
