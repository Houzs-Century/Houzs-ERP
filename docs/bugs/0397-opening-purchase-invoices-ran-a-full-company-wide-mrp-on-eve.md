## Opening Purchase Invoices ran a full company-wide MRP on every load [high]

<!-- area: Purchase orders + GRN + PI -->

**白话.** 打开「采购发票」列表要等大概 4 秒。原因是列表为了显示「关联销售单」和
「已交货」这两栏，每次打开都把整套 MRP 引擎跑一遍 —— 而 MRP 是全公司最重的计算，
采购发票列表其实根本不需要现算它。现在改成跟 8 月销售单列表一样的做法：列表先秒开
（那两栏先空着），过一拍再由一个独立的轻接口把这两栏补上。功能不变，只是不再让整张
列表卡在 MRP 上。

**Symptom.** In the ERP, opening the Purchase Invoices list (the paginated
`GET /api/scm/purchase-invoices?page=…`) took ~4.2s — measured from the browser
against prod with a real session, **~4237 ms** — while the rows themselves are a
light paginated query with cheap status counts. The exact disease the Sales
Orders list had before it was deferred.

**Root cause (traced).** PROVEN by reading the call chain on `origin/main`. The
paginated list handler called `attachPiAssignedSos`
(`backend/src/scm/lib/pi-assigned-sos.ts`) to fill four columns — `assigned_sos`,
`assigned_so_linked`, `assigned_so_provenance`, `delivered_dos`. That calls
`resolvePoSoCoveragePerSkuForPos` (`routes/po-so-coverage.ts`), which runs
`computeMrp` — the global, company-wide MRP engine — **once per list load**. So
the PI list could never be faster than the MRP page (~4s), no matter how light
its own query was. The list query + the six status counts were never the cost;
the MRP run was. (The 4.2s number is PROVEN by the earlier live browser sweep;
the after-number is measured post-deploy — the list query is the same one the SO
list runs in well under a second.)

**Fix.** Defer the four MRP-derived columns off the list's critical path,
mirroring the Sales Orders list. The paginated list now OMITS them — not blanks
them (C16: absent means "not computed yet", `[]` would mean "computed empty") —
and the client heals them a beat after render via a new thin endpoint
`GET /purchase-invoices/list-mrp-enrichment?piIds=…`
(`backend/src/scm/routes/purchase-invoices-list-enrichment.ts`), which re-reads
each PI's `(id, grn_id)` under the SAME company scope the list applies and runs
the SAME `attachPiAssignedSos`, so the healed values are byte-identical, only
deferred. The FE overlay `applyPiListMrpEnrichment`
(`frontend/src/lib/piListEnrichment.ts`) merges them into the shown rows. C16
parity is pinned both ways: `PI_LIST_MRP_ENRICHMENT_KEYS` (backend) and
`PI_MRP_DERIVED_LIST_FIELDS` (frontend) are asserted equal by
`backend/tests/piListEnrichmentKeys.test.ts` +
`frontend/src/lib/piListEnrichment.test.ts`. The legacy non-paginated path (no
`page`) is unchanged — byte-identical historical behavior. No read was removed,
widened, narrowed or re-ordered; only the moment the MRP columns are computed.

**Ref.** this PR, 2026-08-19. Same class as the Sales Orders list MRP-off-load
deferral (`GET /mfg-sales-orders/list-mrp-enrichment`).
