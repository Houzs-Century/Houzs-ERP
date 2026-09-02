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

**Fix — one sentence, one place.** `services/ac-line-gone.ts` holds it, and the
owner sharpened it once the old connector's own API had been read:

> 「如果只是 edit SKU、换东西或者添加 variants 等等，我们就直接照现在的模式去做。那
> 如果我们有 delete line、add line 导致了它的 line 不平整了，我们就整张重建」

> **The SET of lines decides.** The same lines, edited, are matched on the
> AutoCount key — every DtlKey survives. A line ADDED or REMOVED is a rebuild:
> the book is cleared and the ERP's list laid down, so the two sides finish
> identical.

`rebuildNeededForLineSetChange(anyAdded, anyDeleted)` is the whole decision, and
`composeEdit` DERIVES it — no caller can forget it and no route can disagree.

**A first version keyed off the SDK instead, and was wrong in the way he named.**
It rebuilt only where `DeleteDetail` is absent, so a delete removed one line on a
SALES ORDER and rebuilt on the other five — one operator action, two behaviours,
decided by a capability nobody outside one file could see. 「规则变形」. **An SDK
capability is a MECHANISM; it may not be the rule.** `SDK_DELETES_ONE_LINE`, the
per-type table, and the host's `DeleteDetail` branch are all gone rather than
left as dead code that reads like a second rule.

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
