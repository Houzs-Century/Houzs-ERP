## SO -> PO transfer threw the whole header away, so five fields never left the ERP [high]

<!-- area: AutoCount sync + write-back -->

**白话.** 用 Sales Order transfer 出来的采购单，很多资料没跟着过去。系统本来就有一段程
式把整张采购单的表头（单号、日期、供应商、采购员、备注 Description）组好；可是一旦判断
「这张单是 transfer 出来的」，它就把整个表头丢掉，只送三样东西过去。之前已经被抓到两次，
每次只补一个栏位 —— 补了供应商、补了单号 —— 剩下五个还是没补：日期、采购员、Ref、
Description、UDF。老板 2026-08-19 走真实采购流程时撞到的就是这个。这次不再补第三个栏位，
改成「表头整个带过去，只有真的必须换的才换」，以后新加的栏位自动跟着走。另外一件：采购单
的**收货仓库**（Purchase Location）AutoCount 表头上本来就有这个栏位，ERP 也有，可是从来
没送过，所以 AutoCount 一直自己填 —— 这不是 transfer 才有的问题，是每一张 ERP 写进去的
采购单都不对。

**Symptom.** Owner, 2026-08-19, walking a real Sales Order → PO → GRN →
Purchase Invoice chain: 「为什么 Sales Order to PO，它的 Description2 不对的呢？再来，
它的 Purchase Location 也不对… 因为它是用 transfer from Sales Order 的嘛，为什么它没有
把 Sales Order 的那些资料带过去呢？」

**Root cause (traced in source).** `scm/lib/autocount-outbox.ts` built the PO
payload with `composeCreatePo` — nine fields: `DocNo, DocDate, CreditorCode,
CreditorName, Agent, Ref, Description, UDF, Details` — and then, on the transfer
branch only, discarded that object and sent `composeSoToPo(...)`, which returned
`{ DocNo, DtlKeys, Details }`, plus a hand-merged `CreditorCode` / `CreditorName`.
Dropped on every transfer: **DocDate, Agent, Ref, Description, UDF**.
`Description` is `purchase_orders.notes`. `Agent` carries the constant
`AC_PURCHASE_AGENT` behind `FK_PO_PurchaseAgent`.

The same hole had been found and patched TWICE before, one field at a time, each
time after a live document failed — `CreditorCode` on 2026-08-17 09:15 (the host
answered `FK_PO_DisplayTerm`, the payment term's key, because the term defaults
from a supplier there was none of) and `DocNo` on 2026-08-17 10:15 (the first
successful transfer landed as `PO-009968` instead of `HC-PO-2608-001`). A third
one-field patch was the wrong fix.

Purchase Location is a **second, wider** bug, and not transfer-only.
AutoCount's purchase documents carry `PurchaseLocation`, and it is assigned in
TWO places because the purchase side does not share one header function:
`CreatePo` sets its own master, `PurchaseHeader` is what `/so-to-po` and the four
conversions apply. `PurchaseHeader`'s own comment records that the ERP "has never
been sent" one. The ERP's counterpart is
`scm.purchase_orders.purchase_location_id`, which `/submit` refuses a purchase
order without unless every line names its own. So AutoCount had been defaulting
the purchase location on every ERP-written purchase order since the cutover.

**Fix.** `composeSoToPo` now takes the CREATE payload and SPREADS it —
`{ ...master, DtlKeys, Details }` — so a field added to `composeCreatePo` reaches
a transfer without anyone editing it. `Details` is the ONLY deliberate override,
and it carries exactly the four keys the service's phase two applies
(`UnitPrice`, `Qty`, `Location`, `DeliveryDate`); a fifth would be composed,
stored, POSTed and silently dropped. `PurchaseHeader` now also reads `Agent`
(guarded — the four conversions send none), because carrying a field is not
landing it. `readPoHeader` selects `purchase_location_id` and resolves it to the
`dbo.Location` code, `composeCreatePo` sends it as `PurchaseLocation` and uses it
as the LINE default — the ERP's own precedence, `warehouse_id ??
po.purchase_location_id` — so a PO the ERP considers complete is no longer
refused with `MissingLocationError`. `mastersOf` opens it, since the service
applies it through `Set()`, which swallows. Assigned on BOTH service routes: the
first draft added it only to `PurchaseHeader` and left `/create-po` sending a key
the host never read — the same *carrying is not landing* trap as `Agent`, caught
by asserting the READ on both routes rather than one. `composeSoToPo` also
now REFUSES a payload whose `DtlKeys` and `Details` counts differ, an invariant
its doc comment had claimed without enforcing — and that refusal is WIRED into
`noteReadFailure`'s list, because an error missing from that list is not handled
elsewhere, it is dropped: the enqueue answers "not queued" with no outbox row and
nothing an operator can read. It was missing for six commits of this change
while its own class comment promised a readable row. It also has a sentence in
`acNotSentProblems`, so the person holding the document is told and not only the
engineer reading the queue — and those two `instanceof` chains are now pinned
against each other, because both were short of the same class on the same day.

**Still open.** `/edit`'s header allow-list has no `PurchaseLocation`, so moving
a written purchase order's ship-to warehouse in the ERP does not reach the book
(same class as divergence D8). `so_to_po` also does not run `ensure_masters`.

**Ref.** this PR, 2026-08-20. Pinned by `/so-to-po carries the whole master` in
`backend/src/services/autocount-writeback.contract.test.ts` (key parity between
the two arms, so a new create field that misses the transfer fails the day it is
added), by `describe('composeSoToPo')` in
`backend/src/services/autocount-writeback.test.ts`, and by 'every refusal reaches
BOTH the queue and the operator' in `backend/src/scm/lib/ac-preflight.test.ts`.
Guide §7c3b-i / §7c3b-ii, and `docs/modules/purchase-order.md` for the buyer's
sentence.
**The host binary must be rebuilt** (`deploy-on-host.ps1`) for the `Agent` half —
the ERP half is Worker-side and lands with the merge.
