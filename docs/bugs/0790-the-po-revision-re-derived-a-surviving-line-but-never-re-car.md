## The PO revision re-derived a surviving line but never re-carried its SO photo, so a carried key went stale (root fix for 0789) [low]

<!-- area: Purchase orders + GRN + PI -->
<!-- status: fixed -->

**白话.** 这是 `docs/bugs/0789` 那个「PO 照片死链」的**根治**（0789 只补了已经错的那 1
行数据，根因当时先记下没改）。根因：一张销售单（SO）行被改（例如换 code、换图），
批准后系统会**重新推导**采购单（PO）里对应的行——数量、价格、变体、仓库、交货日都
按当前 SO 重新带，**唯独漏了照片**。所以 PO 那行留着旧照片地址，旧图没了就显示 err。
新增的行本来就会带当前照片，只有「原有行重新推导」这条漏了。现在补上：重新推导时
也按当前 SO 行重新带照片，同时保留 PO 自己上传的图。

**Symptom.** The residual root cause recorded in `docs/bugs/0789`: a PO line's
carried `so-items/...` photo key went stale after the source SO line was replaced,
rendering "err" on the PO. `0789` re-aligned the one affected row; this closes the
mechanism so it cannot recur.

**Root cause (traced).** `reviseBoundPo` (`backend/src/scm/lib/so-revision.ts`)
re-derives each surviving PO line in place from its revised SO line — the UPDATE
at step (12a) writes qty, unit price, item_group, variants, description2,
warehouse_id and delivery_date, but **never `photo_urls`**. The ADD branch (12c)
DOES carry `line.photo_urls` for a newly-added line (mig 0274), and the type
comment at the revised-SO-line load even says photos "follow it onto the PO line …
on this amendment path as on the convert paths" — but the re-derive UPDATE was
never given the field, so a surviving line kept its stale snapshot. When an
amendment REPLACES an SO line (delete + add → new id + new photo) and re-links the
PO's `so_item_id`, the PO kept the OLD line's `so-items/<old>/...` key whose R2
object is gone.

**Fix.** The re-derive UPDATE now sets `photo_urls` to (the PO line's OWN
`po-items/` uploads) + (the revised SO line's CURRENT `photo_urls`), de-duplicated
— mirroring the ADD branch while preserving PO-owned photos. Pinned by
`backend/src/scm/lib/so-revision.reviseBoundPo.test.ts` (new case): a surviving
line's stale carried key is replaced by the SO line's current photo and the
po-owned upload is kept — proved RED on the pre-fix tree (POI-1 keeps the OLD
key), GREEN after. `audit:swallowed-reads` clean (the added `photo_urls` read
rides the existing bound `existing` select).

**Ref.** claude/repair-po-carried-photos, 2026-09-10. Root fix for the DEFERRED
half of `docs/bugs/0789` (which carries the data repair + the production trace).
