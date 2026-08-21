## The bare-create purchase return was the thinnest stock-moving path in the module [high]

<!-- area: Purchase orders + GRN + PI -->

**白话.** `POST /purchase-returns`（手工新建退货）比它的两个兄弟（from-grn /
from-grns）少了整整四道防线：① 超退上限的读库失败被丢弃——数据库抖一下，上限和
跨公司防线一起静默失效；② 不查源 GRN 状态——先取消收货单（反冲已写）再对它退货，
第二笔出库照写，库存转负；③ 没有写后复核——两人并发各退满余量，双双通过，20 件
OUT 打 10 件收货，且事后的钳位让超退永久隐形；④ 写前拒绝烧掉幂等钥匙——改个数字
重提就 409 死局，只能整页刷新重录。这次四道一起补齐，并让加行路径也带上源 GRN
状态闸。

**Symptom.** 2026-08-21 full-flow source audit, items B2/B3/B4/B5 — found by
comparing the three create paths' guard sets side by side; /from-grn and
/from-grns carried POSTED gates and scoped reads the bare path lacked, and the
add-line path carried a post-insert verifier the bare path lacked.

**Root cause (traced).** Guards accreted per-handler instead of per-chain:
each incident patched the handler it surfaced on. The cap read was a bare
`const { data }` (fail-open, the exact class lib/qty-cap.ts refuses); the
status gate only ever existed on the converters; the post-insert verifier only
on add-line; markIdempotencyNoWrite only on the short-stock branch.

**Fix.** `routes/purchase-returns.ts`:
- header + line source reads bind their errors and fail CLOSED
  (`source_check_failed` / `cap_check_failed`), and a supplied grn_item id the
  read did not answer refuses (`grn_item_not_found`) instead of passing uncapped;
- header grnId AND every caller-supplied line's parent GRN must be POSTED
  (`grn_not_posted`), on bare-create and add-line both;
- post-insert over-return verification between the item insert and the
  movement write: live non-cancelled sum per linked line, broken → rollback
  (items + header deleted, claim released) + 409;
- pre-write refusals across the three create handlers call
  markIdempotencyNoWrite, so a corrected resubmit gets a fresh claim.
`backend/tests/purchaseReturnCreateGuards.test.ts` pins all four properties by
bounded source slices; RED on the unfixed tree (zero matches for the new guard
anchors on main), GREEN here. Swallowed-reads baseline tightened 27 → 25.

**Ref.** fix/purchase-return-guards, 2026-08-21.
