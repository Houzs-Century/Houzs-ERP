## A purchase-consignment receive could book its stock twice and never say so [high]

<!-- area: Purchase orders + GRN + PI -->

**白话.** 采购寄卖（供应商货寄在我处）的收货是写库存的，但它是全家唯一一个**数据
库层没有幂等索引**的库存写入者：并发双击、或 Worker 超时后的重试，两边都读到「还
没写过」、双双把整批 IN 记两遍——寄售库存凭空翻倍进 MRP 和 FIFO。更糟的是 post 路
径把入库函数包在一个空 catch 里（而那个函数本来就不抛错、只返回失败清单），失败
清单被整个丢掉——单据显示已过账、库存一动没动、响应是干净的 200。修法＝补上兄弟
们都有的部分唯一索引（历史重复行用 0279 的 correction_seq 编号保留，不删账不动库
存），并让 resync 的失败清单以 movementErrors 随响应返回。

**Symptom.** 2026-08-21 full-flow source audit, item A11 — found by diffing the
`uq_inv_mov_*` index family (DO / DR / CS_DO / CS_DR present; PC_RECEIVE /
PC_RETURN absent) against 0154's own header, which still declared the module
OFF-LEDGER two months after the code went on-ledger (2026-06-05).

**Root cause (traced).** The 0154 design ("a real GRN is created only at
settlement, the receive does NOT write inventory_movements") was superseded in
code but not in schema: `resyncReceiveInventory` books a PC_RECEIVE primary
posting per bucket with deltas via STOCK_TRANSFER — exactly the CS_DO template
— but no index enforced the once-only primary. And
`postPcReceiveAndRollup` wrapped it in `try { … } catch { /* best-effort */ }`
around a function that never throws, so `writeMovements` refusals vanished.

**Fix.** Mig `0321_pc_inventory_idempotency.sql`: numbers any pre-existing
duplicate (doc, product, variant) buckets under `correction_seq` 1..N
(append-only — deleting a movement would rewrite on-hand and orphan its FIFO
lots, 0279's minefield), then creates `uq_inv_mov_pc_receive_source` /
`uq_inv_mov_pc_return_source` in the 0279 v2 shape
(`COALESCE(correction_seq, 0)` in the key), search_path pinned.
`purchase-consignment-receives.ts`: the post chokepoint captures the resync
result and returns it; create, from-pcos, the explicit post route, add-line
and edit-line all carry `movementErrors` in their responses — the same
contract every sibling stock writer has. The stale "PC_RECEIVE has no unique
index" comment now names the index.
`backend/tests/pcInventoryIdempotency.test.ts` pins the migration shape (both
indexes, duplicate-stamping before the build, no DELETE, pinned search_path)
and the capture-not-discard contract; RED on the unfixed tree, GREEN here.

**Ref.** fix/pc-inventory-idempotency, 2026-08-21.
