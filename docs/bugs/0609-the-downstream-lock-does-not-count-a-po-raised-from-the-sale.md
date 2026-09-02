## The downstream lock does not count a PO raised from the sales order [high]

<!-- area: Sales orders + pricing -->

**Found by the owner asserting the rule, not by reading the code.** 2026-09-02,
while agreeing the rebuild was safe:

> 「如果它已经是转了 PO 或者被 convert 的话，这张订单就不能被更改了呀」

He believed a converted sales order is locked. **For a delivery order and a
sales invoice it is. For a purchase order raised from that sales order it is
not.**

**Traced.** `scm/lib/downstream-lock.ts`'s `soHasDownstream` counts exactly two
things:

```
liveCount(sb, 'delivery_orders', 'so_doc_no', soDocNo)
liveCount(sb, 'sales_invoices',  ...)
```

There is no count of `purchase_order_items.so_item_id`. So an order whose goods
have already been PURCHASED is still editable — its lines can be added to,
removed and re-priced, and nothing refuses.

**Why that turned from a quirk into a hazard on the same day.** The new line rule
(`docs/bugs/0608`) rebuilds a document whenever the line SET changes, and a
rebuild destroys and reissues **every DtlKey**. `PODTL.FromSODtlKey` is the
purchase line's record of WHICH sales line it was raised for. Rebuilding such an
order voids that link silently — the connection between a customer's order and
the goods bought for it.

**The host's own guard cannot be relied on here.** `AnyLineTransferred` reads
`SODTL.TransferedQty > 0`, and whether an SO->PO transfer writes that column is
**UNKNOWN** — `AcSyncService.cs` says so in its own words at the
`AddSOToPOTransferDetail` site. An UNKNOWN is not a guard.

**Fix (this PR).** `scm/lib/so-po-raised.ts` answers from rows the ERP can
prove, and `composeSoState` passes `rebuildBlocked` when a purchase line names
any line of this order. `composeEdit` then takes the ordinary keyed path.

**It refuses a MECHANISM, not an edit.** A change to such an order still syncs
exactly as it always has — matched line by line, every key preserved. Nothing an
operator could do yesterday is refused today.

`poRaisedFromSo` **throws** on a failed read rather than answering `false`: "I
could not tell" and "no purchase order exists" are opposite facts and only one of
them makes a rebuild safe.

**DECIDED — the lock is NOT widened.** Owner, 2026-09-02, asked whether
`downstream-lock` should count purchase orders: **「不加」· 「等遇到了问题再精简」**,
with the reason that matters — 「我们正常都是系统转的 PO，就是 submit SO
amendment」. An amendment is the sanctioned way to change such an order, and it
carries its own approval path, so the ordinary editable state is not the loose
end it looks like from the lock alone.

So the ERP keeps today's behaviour and the hazard is closed at the one place it
was real: the rebuild. Nothing an operator could do yesterday is refused today.

**What would reopen this:** a sales order edited directly (not through an
amendment) after its purchase order exists, in a way that changes the line SET.
That is the case the `rebuildBlocked` guard above catches — it takes the keyed
path instead, so the keys survive and `PODTL.FromSODtlKey` stays true.

**Verified.** Backend typecheck exit 0; `autocount-outbox.test.ts` and
`acLineRemovalIsUniform.test.ts` green together (127). **UNTESTED against
production** — no order has been rebuilt, and the service is still uncompiled.

**Ref.** fix/autocount-line-order-is-stable, 2026-09-02.
