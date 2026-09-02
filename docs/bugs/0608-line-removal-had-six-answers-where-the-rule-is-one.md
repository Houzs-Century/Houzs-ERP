## Line removal had six answers where the rule is one [high]

<!-- area: AutoCount sync + write-back -->

**Owner, 2026-09-02**, on why the connector this ERP replaces only ever wrote
sales orders, and what that means for us:

> 「他只做 Sales Order 是因为他那边只有 Sales Order 的 Data Entry，我们这里是有全部
> Document 的 Data Entry 的（我们是 Full Set）。所以你需要把全部东西都 update 掉」

and then, on the shape of the answer:

> 「不要有规则变形，或者说没有清楚规则的这种 business logic 问题」

**Symptom.** A line deleted in the ERP disappeared from AutoCount on a SALES
ORDER and stayed visible at quantity 0 on the other five document types. That is
two behaviours for one operator action, decided by an SDK detail nobody outside
this file could see.

**Root cause (traced).** `composeEdit` expressed every removal as a retirement
because `PurchaseOrder` has no `DeleteDetail`; `docs/bugs/0606` then gave sales
orders a real delete. The result was a rule that varied by document type with
nothing naming the variation — exactly the "规则变形" he asked not to have.

**Fix — one sentence, one place.** `services/ac-line-gone.ts` holds it:

> **A line the operator DELETED disappears from AutoCount.** Where the SDK can
> remove one line it removes that line; where it cannot, the details are
> REBUILT, because `ClearDetails` is the only way those types can lose a line at
> all.

`rebuildNeededToRemoveLine(docType, anyLineDeleted)` is the whole decision, and
`composeEdit` DERIVES it — no caller can forget it and no route can disagree.
`SDK_DELETES_ONE_LINE` is the mechanism table, asserted against
`sdk-api-reference.txt` itself so a later SDK cannot make it quietly wrong.

**What the connector it replaces actually does, read off the host today** — and
it is not what I assumed twice before checking. `InistateConnector.exe` loaded
through .NET reflection exposes, for documents, exactly:

```
DocumentService`1 : UpdateOrCreate, ToggleCancel, setCancel, setValue
DocumentSetValueService : setValue
```

**There is no add-line, edit-line or delete-line API.** One `UpdateOrCreate`
takes the whole document and makes the book match it, which is why `ClearDetails`
is in that binary and why add/delete "just worked" there: **it never matches
lines at all.** Its `jobs` config confirms the scope — only `syncSalesOrder`
carries `to: "autocount"`; every other job is a `*SyncBack` reading OUT.

**Why we do not simply copy it.** It wrote sales orders that were never
transferred onward. This is a full set, and a purchase-order line's DtlKey is
held downstream — `PODTL.FromSODtlKey`, the transfer chain, the line
photographs. Rewriting every document wholesale would void all of it. So keys
are matched where they exist, and the rebuild is what happens when they cannot
be — plus an explicit operator request.

**How that finding was reached, recorded because the method was the mistake.**
Three earlier rounds counted METHOD-NAME STRINGS inside the binary and reported
"it has AddDetail, DeleteDetail, ClearDetails" as though that answered *when* it
uses them. It does not: a string table says what a program CAN call, never what
it calls. `[Reflection.Assembly]::LoadFrom(...)` needs no tool that was not
already installed and answers the real question in one command. The owner asked
「为什么你不检查清楚呢」 three times before that was done.

**Verified.** `backend/tests/acLineRemovalIsUniform.test.ts` — 22 tests: every
type has an answer, no type has BOTH, no type rebuilds without a deletion, and
each row of the table is checked against the SDK reference (an absent class may
only be listed as UNABLE, so a lookup miss cannot read as a pass). Backend
typecheck exit 0.

**UNCOMPILED AND UNDEPLOYED.** `AcSyncService.cs` has not been built — there is
no C# toolchain in this environment — so `Gone` and `Rebuild` remain keys no
running binary reads, and behaviour is exactly as today until the office host is
rebuilt with `build-local.ps1`.

**Ref.** fix/autocount-line-order-is-stable, 2026-09-02.
