## Cancelled duplicate DO never gave its stock back — reversal was best-effort and silently lost [high]

<!-- area: Delivery, DO, returns -->

**白话.** 一张销售单 (2990-SO-2606-019, 客户 Andrew khoo) 出了两次货：一张真的
(2990-DO-2607-017)，一张重复的 (2990-DO-2607-005)。重复那张后来取消了，但它出掉的
库存没有还回来 —— 仓库里那 1 张床垫、2 个枕头、1 张沙发 (KETTA 1 / NTYR 2 /
TRION 1) 明明还在货架上，系统却当作出货了，库存少算。修法：用系统自己的取消还货
函数，只针对这一张单还货；真的那张单一根手指都不碰。这是一次性资料修复，PLAN 是默认，
要 apply 得打确认句。

**Symptom.** On sales order 2990-SO-2606-019, the duplicate delivery order
2990-DO-2607-005 is status=CANCELLED, yet its three stock-OUT
`inventory_movements` at warehouse `41d544bc-cb3b-424a-8629-e3e27e14df5f`
(2990 KETTA-FIRM MATT (K) qty 1, NTYR MEMORY CONTOUR PILLOW qty 2, TRION-(K)
qty 1) were never reversed — stock is still double-deducted against
2990-DO-2607-017 (DISPATCHED), which is the genuine delivery. Verified live
2026-08-19 via the SO-DO drill (`.github/workflows/so-do-drill.yml`,
`backend/scripts/check-so-do-drill.mjs`).

**Root cause (traced).** Two failures compounded. (1) When DO-005 was cancelled,
`reverseInventoryForDo`'s return value was discarded by the cancel path's
best-effort `try/catch`, so a movement-write failure left the shipped stock
deducted while the request returned a clean 200 — the exact defect the current
`reverseInventoryForDo` contract comment now warns about
(`backend/src/scm/routes/delivery-orders-mfg.ts:1891-1895`). (2) The
over-delivery invariant R1 was blind to the double-ship: DO-005's lines carry
`so_item_id = NULL` (UNLINKED), and R1 sums delivered qty per `so_item_id`, so an
unlinked duplicate DO deducts stock without ever counting against the ordered qty
(`check-so-do-drill.mjs` header records the same finding).

**Fix.** A gated one-shot repair,
`backend/scripts/reverse-cancelled-do-005-movements.mjs` +
`.github/workflows/reverse-do-005.yml`, replays the system's OWN cancel-path
reversal for this ONE document: it calls the canonical
`scm.fn_reverse_do_out(do_id, NULL, false)` (migration 0198, recreated with
`item_code` in 0307) — scoped by `source_doc_id = DO-005`, so it restores each
OUT's original lots at original cost, deletes the cancelled sale's lot
consumptions, zeroes the OUT cost stamps, and writes one balancing `+net_out`
ADJUSTMENT per bucket. No ad-hoc rows are hand-crafted, and 2990-DO-2607-017
(a different id) is untouched by construction. PLAN by default; APPLY needs
`MODE=apply` + `CONFIRM="REVERSE DO-2607-005 OUT MOVEMENTS"`, then re-reads on a
fresh connection and asserts the per-item stock deltas are exactly +1 / +2 / +1,
the three ADJUSTMENT rows exist, and the genuine DO's movements are unchanged.
Idempotent (the fn and the script both no-op once an ADJUSTMENT tags the DO).
This does NOT change any module surface — no new route, permission, status or
required field — so no module-guide update. **Not yet applied to prod** — the
workflow is dispatched by the owner; this entry records the repair, not a run.

**Ref.** fix/reverse-cancelled-do-005-movements, 2026-08-20.
