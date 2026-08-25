## The day view resolved a trip stop's delivery order with no company predicate [med]

<!-- area: Delivery / TMS -->

**白话.** 罗里当天的路线画面，在把每一个停靠点对回它的送货单时，没有加「这张单是
不是我这家公司的」这一条。一个只拿到 Houzs 权限的调度员，画面上的行程虽然已经过滤
过了，但那一步读送货单是全公司通读的。**没有人报过这个问题**，也没有证据说画面上真
的漏出过别家的资料——它读到的东西最后只被拿去接销售单号，而销售单那一步是有过滤的。
记下来，是因为那一条「靠父单据就够了」的想法，正是 0496 和 0497 两次真出事的写法。

**Symptom.** Not reported by anyone. Found while building the packing list on
top of the same reads (`GET /trips/packing`), by walking every statement the
trips router issues and asking which of them carries the tenant boundary.

**Root cause (traced).** `backend/src/scm/routes/trips.ts`, `GET /trips/day`.
The trip rows above it are correctly widened to the caller's granted companies
(`scopeToAllowedCompanies`), and the stops hang off those trips — so the
statement that resolves each stop's delivery order was written as if the parent
had already answered the question:

```ts
const { data: doRows } = await sb.from('delivery_orders').select('id, so_doc_no').in('id', doIds);
```

That is rule (b) of the company-scope note in `backend/src/scm/lib/companyScope.ts`
in one line: *a parent-ownership predicate proves the row is on that document,
NOT that the document is in your books.* The SCM client is service-role and mig
0061 enabled RLS with **zero** policies, so nothing behind the statement
re-checks anything — the predicate in the statement is the entire boundary.

**How far it actually reached, stated honestly.** The two columns it selects are
`id` and `so_doc_no`, and the only use of the result is to look the sales order
up — and *that* read is scoped (`scopeToAllowedCompanies` on `mfg_sales_orders`).
So no other company's customer name, address or phone is known to have rendered
from this path. **UNKNOWN, not disproved:** whether any production trip has ever
carried a stop pointing at a delivery order outside the caller's grants. That
needs a production read, and none was taken for this entry.

**Fix.** The statement takes `scopeToAllowedCompanies` like every other read
around it, widened rather than pinned to the active company because TMS is a
deliberately cross-company queue. One line, no behaviour change for a caller
whose grants cover the trip's delivery orders — which is every caller the
scoped trip read leaves standing.

The same discipline is what the new `GET /trips/packing` is built on, and it is
pinned per-STATEMENT rather than per-handler by
`backend/tests/packingListView.test.ts`: `check-company-scope.mjs` acquits a
whole handler once any scoped call appears in it, which is exactly how
`docs/bugs/0497-a-delivery-order-could-take-goods-off-the-other-company-s-ra.md`
escaped it. Proved RED by deleting the predicate from the
`delivery_orders` read (1 of 18 fails, naming the table) and from the
`warehouse_racks` read (1 of 18 fails, naming the table), and green with both
in place.

**Ref.** `feat/the-packing-list-is-a-trip-you-can-print`, 2026-08-26. Same class
as `docs/bugs/0496-delivery-planning-board-listed-other-companies-service-cases.md`
and `docs/bugs/0497-a-delivery-order-could-take-goods-off-the-other-company-s-ra.md`.
