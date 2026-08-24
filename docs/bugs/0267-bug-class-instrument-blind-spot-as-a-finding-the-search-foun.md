## BUG CLASS - instrument-blind-spot-as-a-finding: "the search found nothing" written down as "it is not there" [high]

<!-- area: AutoCount sync + write-back -->

**The shape** — a query, a reflection run, a join or a grep is pointed at a
question, comes back empty, and the empty answer is recorded as a FACT about the
world instead of a fact about the instrument. It then gets a parenthesis that
makes it unre-checkable — *"reflected off the installed assemblies, NOT guessed"*
— and everything downstream is built on it.

**Two instances, both found on 2026-08-16/17, both in this one subsystem:**

1. **`BindingFlags.DeclaredOnly`.** The 2026-08-10 reflection dump of the
   AutoCount 2.2 SDK was taken with `DeclaredOnly`, which SKIPS INHERITED
   MEMBERS. Every per-subclass listing in
   `backend/scripts/autocount-service/sdk-api-reference.txt` therefore shows
   `AddPartialTransferDetail` — declared on `DeliveryOrder` — and shows no
   `FullTransfer` or `PartialTransfer`, because those live on the base
   `SalesDocument` / `PurchaseDocument`. `AcSyncService.cs`'s header then stated
   it as measured fact: *"There is NO TransferTo/CreateFrom API. Every document
   class exposes exactly one transfer primitive."* Re-reflected with
   `FlattenHierarchy` against
   `C:\Program Files\AutoCount\Accounting 2.2\AutoCount.Sales.dll` on
   `AutoCount.Invoicing.Sales.DeliveryOrder.DeliveryOrder`, there are **three
   `FullTransfer` overloads, four `PartialTransfer` overloads**,
   `IsTransferFromSupported`, and three transfer events. Seven days of work sat
   on the non-finding, including the argument in the same header that the
   over-transfer event *"cannot be subscribed"*.
2. **`DODTL.FromDocDtlKey`.** NULL on all 47,531 rows, so a join through it
   returned zero rows and the zero read as "no delivery-order line was ever
   transferred from a sales order".

**Why it hides** — an empty result is indistinguishable from a true negative
without a POSITIVE CONTROL, and nobody asks for one when the answer is the
answer they expected. Both of these would have been caught by a single check:
*"run the same instrument against something I know is there."* Reflecting for
`Save()` — which every document has and which is also inherited — would have
returned nothing on 2026-08-10 and exposed the flag in one line.

**The remedy, and it is not "be careful":**
- **A dump that cannot be re-taken must not be the reference.** `AcSyncService`
  now re-takes its own: `LogTransferApi` prints every `FullTransfer` /
  `PartialTransfer` / `AddPartialTransferDetail` overload the loaded assemblies
  expose, WITH PARAMETER NAMES, once per document class per service start, into
  `C:\Temp\ac-sync-service.log`. The comment can rot; the log line cannot.
- **When you record an absence, record the instrument's settings beside it** —
  the flags, the predicate, the join column. `sdk-api-reference.txt` did say
  `DeclaredOnly` in its own third paragraph, and the C# comment that quoted it
  did not carry that word, which is the whole distance between the two.
- **Say what the search covered, not what exists.** "No `FullTransfer` in a
  `DeclaredOnly` dump of the subclasses" is true and useful. "There is no
  transfer API" is neither.

**Ref.** PR for `fix/autocount-documented-transfer-api`, 2026-08-17. Related:
**BUG CLASS unverified-completeness-claim** and **BUG CLASS optional-param-noop**
below — all three are a claim about a POPULATION taken from a look at part of it.
