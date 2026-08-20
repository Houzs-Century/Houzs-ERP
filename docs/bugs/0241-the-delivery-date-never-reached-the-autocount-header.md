## The delivery date never reached the AutoCount header [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** The owner: *"AutoCount 有一个 Sales Exemption Date，怎么没有 update
进去？"* — and then, when told the ERP has no exemption field: *"这个就是
delivery date 来的 … 就是用我们 delivery date 放进去 sales exemption date 而已，
一样的东西."*

**Root cause, and the first answer was wrong.** The first answer was that the
ERP has no such field, so there is nothing to send. That was true about the
NAME and false about the THING. AutoCount's sales-order HEADER has no delivery
date of its own — the SDK lists `DeliveryDate` on the six DETAIL classes and
nowhere else, which is why an earlier query for `SO.DeliveryDate` returned
`Error 207: Invalid column name` — so this book keeps the header delivery date
in `SalesExemptionExpiryDate`, and Inistate, the connector the ERP replaces,
writes it there.

`mfg_sales_orders.customer_delivery_date` is the value. It was not even being
READ: `SO_HEADER_COLS` did not list it.

**Fix, four places, because a date needs different handling from a string at
every one:**

| where | what |
|---|---|
| `SO_HEADER_COLS` | read `customer_delivery_date` |
| `composeCreateSo` | `SalesExemptionExpiryDate` on the payload |
| `soEditHeader` | the same key, omit-when-absent |
| `AcSyncService.cs` | apply it on BOTH create and edit |

**The C# is the part that would have failed silently.** `Edit`'s header loop
reads every key with `Str()` and assigns through reflection; a
`Nullable<DateTime>` property given a string throws — inside `Set()`, which
swallows exceptions. Adding the key to that allow-list would have produced a
field that looks wired and writes nothing. It is handled beside `DocDate`
instead, which is the existing precedent for a date on that path.

`ContainsKey` rather than `HasValue` on both paths, so present-and-null blanks
it and absent leaves the book's own — the same rule the line delivery date
already follows, and the reason `#2218` exists.

Registered as clearable: it is a date with no foreign key behind it, so an
operator who deletes it has that reach the book.

**Ref.** 2026-08-16, PR #2305.
