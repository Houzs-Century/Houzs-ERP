## The sofa stock import opened a second set of lots for a build whose sales line gained a special after the first import [medium]

<!-- area: Inventory, costing, FIFO -->
<!-- status: open -->

**白话.** HOK-5535 那台沙发（销售单 HC-SO-012629，采购单 HC-PO-009712）实际只有
一台，ERP 里现在却有**两套**它的件在库存里：8 月 28 日开的一套，和 9 月 8 日晚上
开库存那一步又开的一套。库存会把这台沙发**多算一台**。这不是 0714 那 9 张单的
问题，是开库存那个现成的 workflow 按自己的规则顺手做的；这条先记下来，还没修。

**Symptom.** `Import AutoCount sofa stock` apply run 34229613738 (2026-09-08
13:03Z, dispatched as step 2 of `docs/bugs/0714-the-sofa-purchase-line-was-filed-as-others-so-the-sales-orde.md`)
listed 22 lots to create. 19 were the compartments that repair had just made
visible. The other 3 were `5535-1A(LHF)`, `5535-2A(RHF)`, `5535-CNR` under batch
HC-PO-009712 — a build that had NOT been touched by that repair and already had
lots.

**Root cause (traced).** Read live 2026-09-08 13:21:18Z: batch HC-PO-009712 now
carries 9 open lots for one physical sofa.

| created | pieces | variant key |
| --- | --- | --- |
| 2026-08-28 13:05Z | `5535-1A(LHF)`, `5535-2A(RHF)`, `5535-CNR` | `fabriccode=bo315-03\|seatheight=30\|special=bottom use umbrella fabric` |
| 2026-09-07 20:49Z | `8030-1A(LHF)`, `8030-2A(RHF)`, `8030-CNR` | `…\|special=bottom use umbrella fabric,nylon fabric` |
| 2026-09-08 13:03Z | `5535-1A(LHF)`, `5535-2A(RHF)`, `5535-CNR` | `…\|special=bottom use umbrella fabric,nylon fabric` |

The sales lines of HC-SO-012629 today carry specials
`["BOTTOM USE UMBRELLA FABRIC", "Nylon Fabric"]`. The 08-28 lots were keyed
without `nylon fabric`, so at some point between 08-28 and 09-08 the special was
added to the sales line (and, through the lane that mirrors it, to the purchase
line the import reads). The import is idempotent on
`(warehouse, item code, variant key, batch)` — it compares the cell the way the
reconcile compares it — so the re-keyed build read as a NEW cell and was
opened again. Its AutoCount cap is per ITEM CODE (`HOK-5535 SOFA`) across all
variant keys, which a second key under the same code does not exceed. The
09-07 row of 8030 pieces under a 5535 purchase order is a third shape from
another lane and is only named here so the count is honest.

**Which of the three sets is real.** UNKNOWN from the data alone; what is
PROVEN is that AutoCount holds ONE unit behind this purchase order. The
allocator bound HC-SO-012629's three lines to batch HC-PO-009712 in step 3
(run 34230737819), which is correct: one set of lots with the matching key
covers the set. The stale-key set is the surplus.

**Fix.** Not written. Retiring the 3 lots keyed without `nylon fabric`
(ids `4b9bdbc2-…`, `89f67bc0-…`, `deb10345-…`) is a stock write and needs the
sofa-stock lane's own plan/apply tool plus the owner's word; the 8030 rows
under this batch need the lane that wrote them. What the IMPORT should learn
is the durable part: when a build's key changes after its lots were opened,
the old cell should be re-keyed, not joined by a new one — `import-ac-sofa-stock.mjs`
section 3 groups by `(PO, AutoCount item, Desc2)` and could detect an existing
lot under the same batch and item code with a different key and REPORT it
instead of writing.

**Ref.** claude/so-do-conversion-remaining-wz1d5x, 2026-09-08. Found while
running the three steps of 0714; the run that wrote the lots is 34229613738.
