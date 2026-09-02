## A deleted line stayed in AutoCount at quantity zero [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** The owner deleted a line in the ERP and the line was still on the
document in AutoCount — quantity 0, description prefixed `[ERP-CANCELLED]`,
still printed. 「我是要 autocount 的全部 line 都跟 ERP 一样」, and then, once shown
that the connector the ERP replaces did it differently: **「跟 inistate 一样」**.

**Root cause (traced).** Not a defect — a design decision taken for the wrong
scope, and it is worth recording as the former rather than dressed up as a bug.

`composeEdit` expresses EVERY line removal as a retirement (`Retire: true` →
Qty 0, `Transferable = false`, an `[ERP-CANCELLED]` Desc2 marker), because
**`PurchaseOrder` has no `DeleteDetail` and no line-level `Cancelled`** in the
2.2 SDK. One uniform shape was chosen so both document types behaved alike.

The cost of that uniformity is what he saw: **`SalesOrder` DOES have
`DeleteDetail(Int64)`** and was made to use the workaround it did not need.
Verified against the SDK reference in this repo, not from memory:

| class | `DeleteDetail` |
| --- | --- |
| `Sales.SalesOrder.SalesOrder` | **`DeleteDetail(Int64)`** |
| `Purchase.PurchaseOrder.PurchaseOrder` | none |
| `Purchase.GoodsReceivedNote.GoodsReceivedNote` | none |
| `Sales.DeliveryOrder.DeliveryOrder` | none |

Read live off the office host the same day, `C:\InistateConnector\InistateConnector.exe`
references `AddDetail`, `DeleteDetail` **and** `ClearDetails`; our service
references `AddDetail` (4 calls) and named `DeleteDetail` only inside a comment.

**Fix.** The ERP now says WHAT HAPPENED and the host decides what the book can do
about it — deciding here would be deciding from a copy of the book rather than
the book.

* `AcRetiredLine.Gone?: 'deleted' | 'cancelled'`. `retiredLineOf` stamps
  `'deleted'` once, where the rows are read: every caller of it is a DELETE
  route. **Absent means retire**, which is the stricter direction and the one
  case CLAUDE.md allows an optional flag for.
* `AcSyncService.Edit()` calls `doc.DeleteDetail(key)` only when **all three**
  of the book's own conditions hold — the ERP said `deleted`, the document is a
  SALES ORDER, and the book's own `TransferedQty` is 0. Otherwise it falls
  through to today's retirement. Nothing fails and nothing is held back.
* The deletes are collected and applied **after** the detail enumeration
  (removing while enumerating skips the next line) and **descending**, so one
  removal cannot move a key not yet removed. Not wrapped in `Set()`: that
  swallows, and a silently-skipped delete is exactly the divergence this path
  exists to prevent.

**Why the third condition is not caution for its own sake.** AutoCount's own
troubleshooting for a TRANSFERRED document whose rows are deleted is that the
source points at nothing, the document goes grey and uneditable, and recovery
needs raw SQL plus Management Studio's *Fix Deleted Document Transfer Problem*.
`scm/lib/downstream-lock.ts` already stops the ERP editing such a document — the
owner's own rule from 2026-08-10 — but that lock is OURS, and somebody can
transfer inside AutoCount without telling us. The guard therefore reads the
BOOK's figure.

**A concern I raised and then withdrew.** I argued this collided with his other
rule that a converted PO's fourth item must stay fourth (`docs/bugs/0605`),
since deleting a line moves the ones after it up. It does not collide: the
downstream lock means a delete can only ever reach the write-back for a document
with nothing converted from it. He had already said so — 「convert 了的，我们的
order 也不可以动了，只有 submit amendment」 — and I had not absorbed it.

**Ships INERT, on purpose.** `AcSyncService` reads keys by name, so a host that
has not been rebuilt has never heard of `Gone` and retires exactly as today.
Our half is therefore zero-risk to merge; the behaviour changes when the office
host is rebuilt and redeployed.

**UNTESTED against the account book, and UNCOMPILED.** There is no C# toolchain
in this environment, so `AcSyncService.cs` has not been built, and no deletion
has been performed on any document. `backend/tests/acLineDeletedNotRetired.test.ts` [gone]
(9 tests) pins the wiring on both sides and asserts the SDK table above against
the reference file itself, so a later SDK that adds `DeleteDetail` to
`PurchaseOrder` fails the test rather than leaving the guard quietly wrong.

> **SUPERSEDED THE SAME DAY, by `docs/bugs/0608`.** The fix described above gave
> SALES ORDERS a real `DeleteDetail` and left the other five retiring in place —
> one operator action with two behaviours, decided by an SDK capability. The
> owner's word for that was 「规则变形」, and he replaced the rule: **the SET of
> lines decides.** A line added or removed rebuilds the document, on every type;
> the same lines edited are still matched on the key.
>
> So `SDK_DELETES_ONE_LINE`, the per-type table, the host's `DeleteDetail`
> branch and `backend/tests/acLineDeletedNotRetired.test.ts` [gone] were all
> removed rather than left as dead code reading like a second rule. What SURVIVES
> from this entry is the finding that started it — a deleted line was still
> visible in the book at quantity 0 — and the `Gone` flag, which is now what
> tells `composeEdit` the line set changed.

**Ref.** fix/autocount-line-order-is-stable, 2026-09-02.
