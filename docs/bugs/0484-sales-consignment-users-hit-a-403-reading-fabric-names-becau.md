## Sales/consignment users hit a 403 reading fabric names, because the read carried cost [medium]

<!-- area: Sofa, fabric, variants -->

**白话.** 销售员在销售单选布料、或开寄售单的时候,系统去读「布料资料」被挡回 403 —— 因为
那个读法连**布料成本和库存**一起返回,需要采购权限,而销售/寄售的人没有。结果布料下拉框
是空的。现在多开一个「只给名字＋价位级别、不给成本」的读法,销售/寄售的人就能选布料了,成本
还是照样锁着。

**Symptom (measured).** `[rbac 403] GET /fabric-tracking` in the Client Errors
telemetry — multiple real users over days. `useFabricTrackings` (the SO fabric
dropdown in EVERY line editor, via SoLineCard, plus the PC-Order detail) fired the
full read, which needs `scm.procurement.products`; those surfaces are gated on
`scm.sales.*` / `scm.consignment.*`, so the read 403'd and the dropdown went empty.

**Root cause + why the one-liner was WRONG (traced by reading the handler).**
`/fabric-tracking/*` was the only reference route without `openRead`. But it could
NOT simply be opened: the GET selects `price_sen, soh_sen, *_usage_sen,
shortage_sen, reorder_point_sen, po_outstanding_sen, supplier, lead_time_days` —
procurement COST and STOCK. `openRead` would leak those to sales staff within the
company (the leak area-guard.ts:84 warns about for `/inventory`).

**Fix.** An additive, safe-by-construction read: `GET /fabric-tracking/lite`
returns ONLY name + price TIERS + is_active + the display dual-code (`supplier_code`)
— NO cost/stock — and is opened via `openReadPaths: ["/fabric-tracking/lite"]` while
the full cost-bearing read stays gated. The two display surfaces switch to a new
`useFabricTrackingsLite` hook returning a `FabricLite` (Pick) type; the fabric
pages that show cost keep the full hook. Verified the whole display chain
(SoLineCard, PcLineCard, PcVariantEditor, `fabricOptionLabel`) reads only safe
fields — the compiler proves it, since `FabricLite` omits every cost column.
Price TIERS are kept because SoLineCard needs them to price a sofa/bedframe line;
a tier is a pricing CLASS, not a cost.

**Verified against.** `backend tsc --noEmit` + frontend `tsc -b` clean;
`fabric-tracking.lite-safe.test.ts` (5 tests) pins the lite SELECT against every
sensitive column and pins that the guard opens ONLY the lite path.

Ref: 2026-08-20.
