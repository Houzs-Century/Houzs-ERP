## The relationship map read Customer PO "Not linked" on orders that carry one [medium]

<!-- area: Frontend + mobile -->
<!-- status: fixed -->

**白话.** 送货单的关系图第一格「CUSTOMER PO」几乎全部显示 "Not linked"，但客户单号
其实好好地存在数据库里 —— 例如 HC-DO-011555 的客户单号是 HC10995。原因不是数据
缺失，是页面根本没有把 `ref` 这一栏交给规则去算。线上 246 张送货单里，有 174 张
的客户单号只存在 `ref` 一栏（`po_doc_no` 一张都没有，`customer_so_no` 只有 13
张），所以那 174 张全部白白显示成「没有关联」。

**Symptom.** The Relationship Map's first node on a delivery order reads
`Customer PO — Not linked` on almost every order, including orders whose
customer reference is recorded. Read live on production 2026-09-09:
`HC-DO-011555` carries `ref = 'HC10995'` and still rendered "Not linked".

**Root cause (traced).** `frontend/src/lib/customer-ref.ts` is the one rule, and
it reads `ref` FIRST — the owner's 2026-08-18 ruling. But the three header types
that feed it in `frontend/src/pages/scm-v2/sales-doc-relationship-map.ts` were
written independently of that rule and listed only `so_doc_no`, `po_doc_no` and
`customer_so_no`:

```ts
export type DoRelationshipHeader = {
  id: string; do_number: string;
  so_doc_no?: string | null; po_doc_no?: string | null; customer_so_no?: string | null;
};                                             // <- no `ref`
```

So the three detail pages never put `ref` into `relMapHeader`, and
`customerRefOf()` fell through to two columns that are empty on live data.

Measured on production (`scm.delivery_orders`, 246 rows):

| column | rows filled |
| --- | --- |
| `ref` | 186 |
| `customer_so_no` | 13 |
| `po_doc_no` | 0 |
| **`ref` and nothing else** | **174** |

Those 174 are exactly the orders that rendered "Not linked" while carrying a
reference. `scm.sales_invoices` (45 rows) and `scm.delivery_returns` (1 row)
carry none of the three today, so the SI and DR maps were wrong in the same way
but with no visible effect yet.

**Why no check caught it.** The pages build the header inside a `useMemo`, so
what reaches `useDoRelationshipMap` is a VARIABLE, not a fresh object literal —
TypeScript's excess-property check never fires. The type and the rule it feeds
could therefore drift apart silently in either direction, and `tsc -b` stayed
green throughout.

**Fix.** The three header types are now `CustomerRefHeader & { … }`, so they are
defined in terms of the rule's own input type and cannot again omit a column the
rule reads. The three pages pass `ref`. Separately, nine hand-written copies of
the same fallback chain — eight `refOf` helpers across the SCM v2 detail and
list pages, plus `ConsignmentOrders.tsx` — now call `customerRefOf` instead of
re-implementing it with `ref` last. Those nine were LATENT, not live: on production no row has `po_doc_no` set, and every row where
`customer_so_no` and `ref` are both filled has them equal, so no displayed value
changes today (`would_display_wrong = 0` on both `scm.mfg_sales_orders` and
`scm.delivery_orders`).

**DEFERRED: `frontend/src/mobile/MobileSODetail.tsx`.** It carries a tenth copy
(`customer_so_no || ref || po_doc_no`) and was reverted out of this PR: the file
is 2118 lines against a 2118 ceiling, and the one added import line is growth
the file-size gate correctly refuses. It resolves identically to the shared rule
on every production row today — where `ref` and `customer_so_no` are both set
they are equal, and the 8 sales orders carrying only `customer_so_no` resolve to
that value under either order — so nothing is wrong on screen. Convert it in a
change that leaves that file no bigger, and the last private copy is gone.

Pinned by five cases in `sales-doc-relationship-map.test.ts` asserting the
Customer PO node resolves off `ref` alone on all three builders, still reads
"Not linked" with no reference at all, and prefers `ref` over the legacy
columns. The `ref`-only cases are RED on the unfixed tree at typecheck —
the object literal trips the excess-property check the pages' `useMemo` avoided.

**Ref.** fix/customer-ref-plumbing, 2026-09-09.
