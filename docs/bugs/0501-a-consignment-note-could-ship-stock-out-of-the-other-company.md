## A consignment note could ship stock out of the other company's warehouse [high]

<!-- area: Delivery, DO, returns -->

**白话.** 2990 和 Houzs 并库后，寄卖单（CN）读源寄卖订单行时不带公司过滤，而且用
的是绕过行级权限的服务角色连接：只要请求里带上**另一家公司**的 CO 行 id，出库仓
就解析成对方的仓库——Houzs 的寄卖单直接从 2990 的仓里扣货，流水却盖 Houzs 的章，
对方库存无端短缺、账上找不到解释单据。同一张单的自由文本 CO 单号也原样落库（跨
租户被关系图追踪），共享的 source-cost 读数还会把对方行的成本抄过来。寄卖退回
（CR）和两条加行路径共享行 id 这个洞。修法＝GRN/客退/DO 三兄弟一直有的那套跨公
司防线整套补齐。

**Symptom.** 2026-08-21 full-flow source audit, item A3 — found by grepping the
guard helpers (`assertSourceLinesInCompany` / `crossCompanySourceRefusal`)
across the conversion routers: every sibling chain carried them, the
consignment sales trio carried none.

**Root cause (traced).** The trio was cloned from the SO/DO/DR chain before the
cross-company guards were added there, and no incident ever reached it. The
three unscoped inputs on `POST /consignment-notes`: the CO line ids (resolve
ship-from warehouse + unit cost), the free-text `consignment_so_doc_no`, and
the shared `sourceUnitCostByItemId` read; `POST /consignment-returns` and both
`POST /:id/items` paths shared the line-id half.

**Fix.**
- `lib/source-cost.ts` — `sourceUnitCostByItemId` takes a REQUIRED
  `companyId: number | null` and predicates the read; the six call sites
  (consignment-notes ×2, consignment-returns ×2, delivery-returns ×2) pass the
  active company.
- `consignment-notes.ts` — create asserts the CO line ids in-company
  (`assertSourceLinesInCompany`) and validates `consignment_so_doc_no` against
  a company-scoped read (fail-closed, `source_check_failed` /
  `consignment_order_not_found`); the add-line path carries the same line
  guard; the CO-line warehouse resolver read gains the company predicate with
  its error bound (degrading to this company's fallback warehouse, never a
  foreign one).
- `consignment-returns.ts` — create and add-line assert the note line ids
  in-company.
`backend/tests/consignmentCrossCompanySource.test.ts` pins the required
parameter, the six scoped call sites, and the guards per handler slice; RED on
the unfixed tree (none of the anchors exist there), GREEN here.
Swallowed-reads baseline tightened (consignment-notes 13 → 12).

**Ref.** fix/consignment-cross-company, 2026-08-21.
