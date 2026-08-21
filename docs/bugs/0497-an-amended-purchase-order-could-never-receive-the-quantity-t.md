## An amended purchase order could never receive the quantity the amendment added [high]

<!-- area: Purchase orders + GRN + PI -->

**白话.** PO 已全收（状态 RECEIVED）之后走修单加量，供应商真把货补来了——但整个
收货界面都以「RECEIVED 的 PO 不能再收」为闸：新建 GRN、批量转、picker 全部把这张
PO 拒之门外，加出来的量**没有任何路径能收进系统**。反过来减量到已收数，PO 又永远
停在 PARTIALLY_RECEIVED，挂在 outstanding 桶里其实无货可收。根因＝修单引擎改了行
数量，却从不重derive那个由数量推出来的收货状态缓存。修法＝approve 成功后按该 PO
全部行重跑一次 recomputePoReceived。

**Symptom.** Found in the 2026-08-21 full-flow source audit (item B10), by
crossing the amendment apply against the GRN gates: `applyPoAmendment`
(`lib/po-revision.ts`) mutates `purchase_order_items.qty` and recomputes only
totals/revision; `reviseBoundPo` likewise; the approve route called neither
recount. Meanwhile GRN create paths and the outstanding-items picker gate on
`isReceivablePoStatus` (`grns.ts`), which excludes RECEIVED.

**Root cause (traced).** `purchase_orders.status` is a derived CACHE
(`grns.ts recomputePoReceived`: fully → RECEIVED, any → PARTIALLY_RECEIVED,
else SUBMITTED), maintained by GRN post/cancel/line-CRUD and purchase-return
writers only. The amendment apply is a quantity writer that was never wired to
the recount, so the cache kept answering for the pre-amendment quantities.

**Fix.** `routes/po-amendments.ts` approve: after the apply try/catch (both
branches — follow-up `reviseBoundPo` and manual `applyPoAmendment`) and before
the amendment's status flip, read the PO's own line ids (error BOUND, degrading
to a warning) and run `recomputePoReceived` over them. Best-effort like the
recount's other callers: the amendment applied, so a recount hiccup appends an
`appliedWarnings` entry, never a rollback.
`backend/tests/poAmendmentReceivedRecount.test.ts` slices the approve handler
between the apply-failure return and the status flip and pins the recount, the
bound error, and the one-home import. RED on the unfixed tree (main's segment
contains no `recomputePoReceived`), GREEN here.

**Ref.** fix/po-amendment-received-recount, 2026-08-21.
