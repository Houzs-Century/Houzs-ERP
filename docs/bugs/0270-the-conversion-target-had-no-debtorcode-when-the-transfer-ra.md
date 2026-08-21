## The conversion target had no DebtorCode when the transfer ran — PROVEN on the host [critical]

<!-- area: AutoCount sync + write-back -->

**Symptom.** `HC-DO-2608-001` and `HC-DO-2608-002` spent a week outside the
account book, `HC-SI-2608-001` blocked behind them, every attempt answering
`AutoCount.Invoicing.InvalidTransferItemException: Invalid transfer item.` —
eleven words naming no key, no document and no reason.

**Root cause (PROVEN, on the live host, 2026-08-17 00:42–00:56).** The target
document has **no `DebtorCode`** when the transfer is attempted. `cmd.AddNew()`
creates it empty and `SalesHeader(doc, p)` never set one at all. Three
compile-and-deploy iterations on the AutoCount machine, verbatim from
`C:\Temp\ac-sync-service.log`:

```
00:42:42  trying FullTransfer from=HC-SO-2608-002 tf=SalesOrder
00:42:42  FullTransfer refused: AppException: Debtor Code is empty.
          - falling back to AddPartialTransferDetail
00:50:13  target debtor before transfer = []
00:55:30  target debtor before transfer = [300-C002]
00:55:30  trying FullTransfer from=HC-SO-2608-002 tf=SalesOrder
00:55:30  FullTransfer OK
```

then, by direct SQL against the book:

```
DO  HC-DO-2608-001  300-C002  F
DO  HC-DO-2608-002  300-C002  F
IV  HC-SI-2608-001  300-C002  F
```

The `00:50:13` line is the load-bearing one: `SalesHeader` had already been moved
BEFORE the transfer by then, and the document was still empty. Only the explicit
assignment filled it. `AddPartialTransferDetail` reports this condition as the
contentless `Invalid transfer item.`; `FullTransfer` names it — which is the
second time in two days that the documented call's error message was worth more
than the primitive's.

**The contradiction from the previous entry is RESOLVED, not standing.**
`DO-011260` succeeded on 2026-08-12 under the old ordering. It was created by
`qa-convert.ps1`, whose payload carries a debtor. Nothing about "the old order
worked once" survives that.

**This also corrects the entry directly below**, which says *"Root cause —
UNKNOWN, and stated as unknown"* and ships four changes on the grounds that the
call did not match the vendor's. Three of those four were right and one of them
— setting the account before the transfer — was the fix; the write-up simply
could not know which, from a machine with no AutoCount on it. It is left in place
rather than edited: what it was honest about not knowing is the record.

**Fix.**

- `SetMaster` assigns the account before the transfer and then **reads it back
  off the document**, logging `target debtor before transfer = [...]` — the
  host's own string, byte for byte, because it is what the operator greps. It
  reads back rather than logging what it assigned because an "applied" line
  written from the value we passed in would have agreed with the `00:50:13`
  failure.
- The account comes from the **payload first** (`DebtorCode` / `DebtorName`,
  `CreditorCode` / `CreditorName`) and from the **SOURCE document's header in the
  book** second. The book fallback is not politeness: every row already queued in
  `scm.autocount_outbox` was composed without an account, and without it none of
  them drains. The ERP not sending one is registered as divergence **D15**.
- Sales arms now call `SalesHeader(doc, p)` BEFORE the transfer — the shape
  proven at `00:55:30`, DocNo included, since all three documents carry the ERP's
  own numbers.
- An empty account after all that logs a **WARNING naming this bug** instead of
  running silently into the contentless exception.

**NOT symmetrical on the purchase side, and that is deliberate.**
`PurchaseHeader` still runs AFTER the transfer. With `transferMaster: true` the
transfer copies the source PO's master over the target, so a header applied first
would be partly overwritten; and `/po-to-gr` has never once succeeded, so there
is no run to compare against in either direction. Only the explicit
`CreditorCode` assignment is carried across. **Unverified — it needs the host.**

**A second finding, not fixed here.** `FullTransfer` is the call proven against
this book, and no production payload reaches it. `readConvertSourceKeys` returns
`{ keys }` whenever every source line *has* a `linked_ac_dtlkey`, **whether or not
the conversion is partial**, so `PlanTransfer` always sees named lines and always
picks `AddPartialTransferDetail`. Inferring "whole" from a row count is exactly
the decision this service must not make — a wrong guess over-transfers into a
live book — so the fix is the ERP saying which it is. `RunTransfer` now logs the
choice and the reason on every conversion so that path cannot fail silently
again. See `docs/modules/autocount-writeback.md` §7c3.

**Test.** `backend/src/services/autocount-writeback.contract.test.ts` asserts the
four account keys are read and pins D15. No test can exercise the SDK call: it
needs the licensed assemblies.

**Ref.** PR for `fix/autocount-debtor-before-transfer`, 2026-08-17. Follows #2336.
Host build that proved it: `builtAt 2026-08-16T16:52:49Z`,
`mvid 58ee4929-7966-407a-a122-5539290014f1`; pre-patch source backed up at
`C:\Temp\acbuild-0816b\AcSyncService.cs.bak`.
