## The four conversions transferred the document and left its own fields behind [high]

<!-- area: AutoCount sync + write-back -->

**白话.** ERP 把送货单、收货单、发票 transfer 进 AutoCount 的时候，只送了单号跟客户/
供应商，单据自己的资料——日期、Ref、备注、供应商的送货单号/发票号、收货仓库——全部没
跟着过去。AutoCount 不会报错，它就默默地：日期填今天（其实是 cron 跑的那天），Ref 跟
备注写空白。采购这两条更惨：AutoCount 本来已经从上一张单抄好了，我们送一个空的过去，
把人家抄好的盖掉。同一个洞在 `/so-to-po` 已经被抓到两次，每次只补一个栏位，补完还是漏
五个。这次不再补第六个：整张单据只写一份「它有什么」，两条路各自从那一份取自己用得到
的；以后新加栏位自动跟着走，加了一个两边都用不到的，测试会直接把名字喊出来。

**Symptom.** Owner, 2026-08-19, walking a live Sales Order → PO → GRN →
Purchase Invoice chain, asking about the purchase order: 「为什么 Sales Order to
PO，它的 Description2 不对的呢？再来，它的 Purchase Location 也不对… 因为它是用
transfer from Sales Order 的嘛，为什么它没有把 Sales Order 的那些资料带过去呢？」
Asked about `/so-to-po`; true of all five transfer routes, and nobody had looked
at the other four.

**Root cause (traced in source).** `enqueueConvert`
(`backend/src/scm/lib/autocount-outbox.ts`) built the conversion payload by hand
— `DocNo`, the account, `DtlKeys`, and `DocDate` / `Ref` spread in behind
`if (opts.docDate)` / `if (opts.ref)`. **No caller passes either**, all eight
verified: `delivery-orders-mfg.ts:3576` and `:4216`, `grns.ts:1961` and `:2343`,
`purchase-invoices.ts:1692` and `:1892`, `sales-invoices.ts:1394`,
`si-autocount-source.ts:178`. So the conditional was dead code and every
conversion since the cutover landed under the drain's date. Meanwhile the ERP's
full description of the same document already existed — `DOWNSTREAM[t].header`
— and was used by `/edit` only.

Dropped per target: DO and Sales Invoice — `DocDate`, `Ref`, `DebtorName`,
`Attention`, `Phone1`, `Note`. GRN — `DocDate`, `Ref`, `Description`,
`SupplierDONo`, `PurchaseLocation`. Purchase Invoice — `DocDate`, `Ref`,
`Description`, `SupplierInvoiceNo`.

**Nothing was refused, which is why it survived a week of live documents.**
`Ref`, `Description`, `SupplierDONo` and `SupplierInvoiceNo` are assigned
UNCONDITIONALLY (`AcSyncService.cs:2426-2427`, `:2450-2451`, `:1226`, `:1259`)
and `Str` of an absent key is `""` (`:3212`), so they were BLANKED, not
defaulted. On the two purchase arms that is destructive rather than incomplete:
`PurchaseHeader` runs again AFTER the transfer (`:1225`, `:1258`) precisely so
the ERP's values beat what `FullTransfer` copied off the source, and the ERP's
silence overwrote the source's real values with empty.

The same hole had been patched TWICE on `/so-to-po`, one field at a time, each
after a live document failed — `CreditorCode` 2026-08-17 09:15 (`FK_PO_DisplayTerm`,
the payment term's key, because the term defaults from a supplier there was none
of) and `DocNo` at 10:15 (the first successful transfer landed as `PO-009968`
instead of `HC-PO-2608-001`). Five were still missing after the second.

**Fix.** `AcDownstreamSpec.facts` is now the ONE description of a downstream
document, and both routes are PROJECTIONS of it —
`downstreamEditHeader` onto `AC_EDIT_HEADER_KEYS` (`Edit()`'s reflection
allow-list) and `downstreamTransferHeader` onto `AC_TRANSFER_HEADER_KEYS[type]`
(what `SalesHeader` / `PurchaseHeader` apply, plus each purchase arm's own
trailing assignment). `present()` still strips blanks at the projection, so an
absent value stays an absent key. A field added to `facts` reaches the transfer
with no edit to `enqueueConvert`, and one that reaches NO route fails the build
naming the key.

The dropped fields split into two classes that need different fixes, and reading
them as one is what would have made `Agent` a third no-op patch. Class (a) — the
service would apply it and the ERP did not send it — is fixed by sending:
`DocDate`, `Ref`, `Description`, `SupplierDONo`, `SupplierInvoiceNo`,
`PurchaseLocation`. Class (b) — the route has NO SLOT — was `DebtorName`,
`Attention`, `Phone1`, `Note`, so **`SalesHeader` was given guarded slots for all
four**, which is what finally makes a transferred delivery order carry the
customer's name instead of whatever AutoCount defaults off the fixed `300-C002`
account (`autocount-writeback.ts:43-44` states that as the design; on this route
it never was).

**Purchase Location, per document.** `scm.grns.warehouse_id` exists and the list
column it feeds is labelled "Purchase Location" (`grns.ts:1050`) — we have one,
AutoCount takes one, it is sent, resolved uuid → `dbo.Location` code.
`scm.purchase_invoices` has none, so nothing is fabricated: the guard on
`PurchaseHeader` leaves whatever the transfer copied off the GRN, which is the
right answer. The purchase ORDER's header location is PR #2523's.

**The omission is reported now, not silent, and through the channel #2499 built
rather than a second one.** A value the ERP has none of is omitted rather than
blanked (a blank is a foreign key error on a master field). `enqueueConvert` now
returns `AcEnqueueOutcome` — the shape the two create routes already return —
the four routes spread the problems into their 201 as `acNotSent`, and
`DeliveryOrderNewV2` / `GrnNew` / `PurchaseInvoiceNew` / `SalesInvoiceNew` call
`notifyAcNotSent` before navigating. The verdict is the OTHER one, so it carries
its own code `AC_SENT_INCOMPLETE` and its own title — "saved and sent, but not
every field on it reached the accounts". The not-sent wording would be false
here, and telling someone their goods receipt is ERP-only sends them to raise it
again into a book that already holds it. Never blocks; tone stays `info`.
The row keeps its own copy: `acNotCarriedReason(…)` in `last_error` on a
`pending` row (`acNeedsAttention` branches on status, so it does not read as
stuck), and `payload.notCarried` as the durable half, because the drain clears
`last_error` on success while the blank in the book stays true. The sentences
separate "the ERP document has none" from "this transfer has no field for it",
because only the first is fixable by the person holding the document.
`si-autocount-source.ts:178` is the one call site not wired to a dialog — it
returns a string enum, not a response body — and it still records on the row.

**Still open.** D17: the sales arms have no `SalesLocation` slot in
`SalesHeader` at all, and `scm.delivery_orders` / `scm.sales_invoices` carry TWO
note columns — `note`, mapped to AutoCount's `Note`, and `notes`, mapped nowhere
— so which one is the book's `Description` is the owner's call. Costs nothing
today: those arms build with `transferMaster: false` (`AcSyncService.cs:1096`),
so the `""` overwrites nothing.

**Ref.** this PR, 2026-08-20. D4 struck from the divergence register — its own
evidence had rotted (it cited `autocount-outbox.ts:254` for a function four
hundred lines away, and "sends only { DocDate, Ref }" predated DocNo, the
account codes and DtlKeys) and all four of its payload tests were `test.skip`
asserting the BUG as their expectation, so nothing went red while the shape
changed underneath them. Replaced by live parity tests in
`backend/src/services/autocount-writeback.contract.test.ts` that hold each
conversion's payload against the document's own master, and by the structural
guard `a header fact reaches a route, or the build says which one does not`.
Guide §7c5. **The host binary must be rebuilt** (`deploy-on-host.ps1`) for the
four `SalesHeader` slots; the ERP half lands with the merge and an old binary
ignores the keys.
