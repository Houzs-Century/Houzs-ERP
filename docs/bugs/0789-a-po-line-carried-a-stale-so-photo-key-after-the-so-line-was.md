## A PO line carried a STALE SO photo key after the SO line was replaced, so the PO photo rendered err [low]

<!-- area: Purchase orders + GRN + PI -->
<!-- status: open -->

**白话.** 采购单（PO）上「从销售单（SO）带过来的参考图」，是**转单那一刻抄的一个
地址快照**，之后修订（revision）也只是保留这个快照。所以当 SO 那行的照片后来换了
（旧行删掉、建了新行、换成新图），PO 存的还是**旧图地址**——旧图已经没了 → PO 那
张图显示 "err"，SO 那张正常。修法两半：① 一次性把 PO 存的旧地址**对齐回当前 SO 行
的照片**（这个 PR）；② 根治是让 PO 修订/读取时按 `so_item_id` **重新带当前 SO 的
照片**，否则下次修订可能再变旧（根治另做，owner 2026-09-10 决定先做①）。

**Symptom.** Owner, 2026-09-10, on `HC-PO-2609-049_R3` line `9028-2A(RHF)`: the
PHOTOS cell showed a red "err" badge, while the SAME sketch displayed fine on the
source SO (`HC-SO-012016`).

**Root cause (traced against production `anogrigyjbduyzclzjgn`).** The PO line's
`photo_urls` carried `so-items/HC-SO-012016/de3dbc2f…/ac-824937-1.jpg` — an OLD SO
item id (`de3dbc2f…`, `count=0`, deleted) and an AutoCount reference photo whose
R2 object is gone — while the PO line's `so_item_id` and the SO line itself are
now `62db736a…`, whose current photo is
`so-items/HC-SO-012016/62db736a…/de1a8463….jpg`. The PO photo route
(`mfg-purchase-orders.ts` `poItemPhotoProxyHandler`) `SO_ITEM_PHOTOS.get(key)`
returns null for the dead key → `SoLinePhotoStrip` renders "err". The carry copies
`photo_urls` from the SO by `so_item_id` at convert
(`mfg-purchase-orders.ts:1345-1353`) and the revision PRESERVES the PO's own
`photo_urls` (`:3937`), so it never re-carries when the SO line's photos change.
Census: exactly **1** PO line affected (this one), 0 dangling SO links.

**Fix.**
- **Data repair (this PR — UNTESTED against prod until dispatched).**
  `backend/scripts/repair-po-carried-photos.mjs` (+ pure planner
  `scripts/lib/po-carried-photo-resync.mjs`, tested by
  `backend/tests/poCarriedPhotoResync.test.mjs`) re-aligns each affected PO line's
  carried (`so-items/`) keys to the linked SO line's CURRENT `photo_urls`,
  preserving the PO's own `po-items/` uploads — `photo_urls` only, never a
  price/qty/status/date, and a dangling SO link is left and reported. Plan by
  default; `MODE=apply` + `CONFIRM="REPAIR PO CARRIED PHOTOS"`; fresh-connection
  shape verify. Dispatch via Actions -> **Repair PO carried photos (plan by
  default)** — plan first, then apply. Passes `audit:release-discipline`.
- **Root fix (DEFERRED, owner 2026-09-10).** Make the PO revision / read path
  re-carry carried photos from the current SO line by `so_item_id` (preserving
  PO-owned keys), so a carried photo is a live reference and cannot go stale. Not
  in this PR.

**Ref.** claude/repair-po-carried-photos, 2026-09-10. Data repair here; root fix
deferred. NOT caused by the same-day SO-amendment name fix (that touched
`description` only; the "err" predated it, present on `_R2`).
