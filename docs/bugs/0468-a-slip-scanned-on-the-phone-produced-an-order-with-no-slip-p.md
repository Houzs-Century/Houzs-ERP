## A slip scanned on the phone produced an order with no slip photo [medium]

<!-- area: Sales orders + pricing -->

**白话.** `/scan-so/extract` 已经把它刚上传的两张照片的 R2 key（`imageKey` /
`receiptImageKey`）传回来了。手机的 client 建单路径两个都没送出去，电脑版两个都送
（`slip_image_key` / `receipt_image_key`，mig 0033 / 0034）。手机订单详情本来就有一张
「扫描照片」卡片在等这两个值，所以那张卡片对手机扫出来的单永远是空的。

**范围要讲清楚**：手机**主要**的扫描路径是 `/scan-so/enqueue`，草稿是**后台**建的，
后台本来就有带这两个 key。缺的是 client 那条 —— `/enqueue` 回 404（旧版 worker）时
走的 `submitLegacy`。所以这是补一条 fallback 路径，不是「每一张手机扫的单都丢了照片」。

**Symptom.** An order created by the phone's client-side scan path shows an
empty "Scanned photos" card on `MobileSODetail`, which is built to display
exactly those keys.

**Root cause.** `MobileScan.buildPrefill` dropped `d.imageKey` and
`d.receiptImageKey` from the extract response, so `MobileScanPrefill` never
carried them and `createDraftFromPrefill`'s create body sent neither.
`SalesOrderNew` sends both.

**Fix.** `MobileScanPrefill` carries `slipImageKey` / `receiptImageKey`,
`buildPrefill` fills them from the extract response, and
`createDraftFromPrefill` spreads them into the create body — omitted rather than
`""` when the photo does not exist, because the create handler stores the value
verbatim.

**HONEST SCOPE.** The PRIMARY path (`POST /scan-so/enqueue`) mints the draft
server-side and `backend/src/scm/routes/scan-so.ts` already sets both keys.
This closes the CLIENT path (`submitLegacy`, reached on a 404 from a stale
worker), which re-implemented the same create and lost the provenance.

**Test.** `frontend/src/mobile/mobile-scan-slip-provenance.test.ts` drives the
real exported `createDraftFromPrefill` with `authedFetch` faked and asserts the
POST body. Run RED first: `expected undefined to be 'scan-slips/abc'`.

---
