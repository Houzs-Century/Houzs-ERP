## Opening Purchase Orders and Goods Received each ran a full company-wide MRP [high]

<!-- area: Purchase orders + GRN + PI -->

**白话.** 打开「采购单」和「收货单」两个列表,每次都要等约 4 秒。原因和上次采购发票
那次一模一样:列表为了显示「关联销售单」和「已交货」两栏,每次打开都把整套全公司 MRP
引擎跑一遍 —— 而列表根本不需要现算它。现在照采购发票那套改法:列表先秒开(那两栏先
空着),过一拍再由独立轻接口补上。功能不变。至此「列表白跑 MRP」这个病的四处(销售单、
采购发票、采购单、收货单)全部修完。

**Symptom.** Opening the Purchase Orders list (`GET /api/scm/mfg-purchase-orders?page=…`)
and the Goods Received list (`GET /api/scm/grns?page=…`) each took ~4s — the same
shape the SO and PI lists had, measured before at ~4.2s.

**Root cause (traced, PROVEN by reading origin/main).** Both list handlers filled
four columns (`assigned_sos`, `assigned_so_linked`, `assigned_so_provenance`,
`delivered_dos`) inline: PO via `resolvePoSoCoverageForPos` and GRN via
`resolvePoSoCoveragePerSkuForPos` (`routes/po-so-coverage.ts`), each of which runs
`computeMrp` — the global company-wide MRP engine — once per list load. So neither
list could be faster than the MRP page (~4s), regardless of its own cheap query.
Same class as the SO-list deferral (#2433) and the PI-list deferral shipped just
before this.

**Fix.** Defer the four MRP-derived columns off each list's critical path,
mirroring the PI list. Each list now OMITS them (not blanks — C16) and the client
heals them a beat after render via a new thin endpoint —
`GET /mfg-purchase-orders/list-mrp-enrichment?poIds=…`
(`routes/mfg-purchase-orders-list-enrichment.ts`) and
`GET /grns/list-mrp-enrichment?grnIds=…` (`routes/grns-list-enrichment.ts`) —
each re-reading its ids under the SAME company scope and running the SAME
resolvers, so the healed values are byte-identical, only deferred. The GRN
endpoint reproduces the list's per-GRN-line-code roll-up exactly (header ==
union(drill lines)). One shared FE overlay `applyListMrpEnrichment`
(`frontend/src/lib/listMrpEnrichment.ts`) + `useEnrichedPoListRows` /
`useEnrichedGrnListRows` merge the healed rows; the enrichment fetch is BATCHED
per page (chunk 100), and an aborted fetch is silent (react-query cancellation),
not a false "failed" — the Hookka P8 trap. C16 parity pinned both ways:
`LIST_MRP_ENRICHMENT_KEYS` (`scm/lib/list-mrp-enrichment-keys.ts`, re-exported by
both routes) == `LIST_MRP_DERIVED_FIELDS` (frontend), asserted by
`backend/tests/listMrpEnrichmentKeys.test.ts` + `frontend/src/lib/listMrpEnrichment.test.ts`.
The legacy non-paginated PO path (no `page`) is unchanged. No mobile PO/GRN list
consumes these columns (checked), and no read was removed, widened or re-ordered.

**Ref.** this PR, 2026-08-19. Completes the "list runs computeMrp on load" class:
SO (#2433), PI, PO, GRN all deferred.
