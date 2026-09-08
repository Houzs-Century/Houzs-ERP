## The sofa purchase line was filed as others, so the sales order could never ship its sofa [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** Nico, 2026-09-08, on HC-SO-012565 (Lisa, customer date 2026-09-09,
staff note READY): *"这张单不能 create DO，但是 convert from SO 时候是有 remaining 的."*
The pick screen shows the two sofa modules with Remaining 1 each; the Delivery
Order form then asks "Stock not enough at the selected warehouse" (available 0
at Balakong), and Ship anyway stops at the sofa batch guard: no batch on hand, no
live supplier PO linked. Remaining is quantity minus delivered and says nothing
about stock, which is why the two screens disagree.

**Root cause (traced).** The sofa WAS purchased and WAS received. AutoCount
PO-009435 line DtlKey 859095 (`HOK-5540 SOFA`, FromSODtlKey 856506 = this order's
sofa line, TransferedQty 1/1 in `ac-so-linked-pos.json.gz`) is in the ERP as
`HC-PO-009435` — but as ONE row `8030-1S`, `item_group = 'others'`,
`so_item_id = NULL`, no `SOFA UNPARSED` marker, plus a migrated goods-receipt
line of the same shape (`HC-GR-005256-PO-009435`, `migrated_no_stock`, 0
inventory movements). Read live on production 2026-09-08 over the Supabase MCP.

The importer that wrote it (`backend/scripts/import-ac-so-linked-pos.mjs`,
2026-08-28 12:05) asked the catalogue about the MAPPED code `5540-1S` before
folding it through `SOFA_MODEL_ALIAS` (5540 -> 8030). The catalogue has never
held a 5540 code, so the group came back `others` and the sofa decomposition,
which only runs on `sofa`, was skipped — docs/bugs/0577's shape, fixed for future
imports by the alias fold (and again on the top-up in 0686). The rows written
before that fix stayed. The sales-order lane folds the alias first, so the same
Desc2 became `8030-2A(LHF)` + `8030-1A(RHF)` on the order.

Three readers then agree the sofa does not exist, each correctly by its own
predicate:

- `import-ac-sofa-stock.mjs` selects `item_group = 'sofa' AND received_qty > 0`,
  so no lot was ever opened for the build. The only BO315-31 stock at Balakong
  is another customer's set (HC-SO-013164, batch HC-PO-009877, seat 28, already
  bound to that order).
- `redecode-collapsed-sofa-lines.mjs` selects `sofa` plus the marker, and
  refuses any build with a goods-receipt line. Run 34216040071 on 2026-09-08
  could not see the row.
- `sofa-batch-guard.ts` finds no `allocated_batch_no` and
  `buildDropshipOffenders` finds no `purchase_order_items.so_item_id` pointing
  at either compartment, so `canDropship` is false and the 409 is the hard one.

**Population, measured on production 2026-09-08.** 14 purchase lines on 14
purchase orders match `-1S` + `item_group <> 'sofa'` + a SOFA supplier_sku:
HC-PO-008192, 009122, 009262, 009435, 009467, 009554, 009587, 009595, 009631,
009679, 009710, 009714, 009829, 009830. Every one is an HOK-5530/5536/5537/5540
alias model, RECEIVED, with exactly one migrated receipt line and zero
movements. Every one's sales side is already decoded into compartments. 9 of the
14 sales orders are open (IN_PRODUCTION, staff note READY): HC-SO-010128,
010886, 010956, 012060, 012173, 012526, 012565, 012986, 013013. The other 5 are
DELIVERED with a delivery-order line already on the compartments.

**The sibling tool, and why it reaches none of these.** PR #3261 shipped
`backend/scripts/repair-collapsed-sofa-po-line.mjs` for the same order
(`docs/bugs/0715-a-sofa-the-warehouse-already-holds-cannot-be-delivered-becau.md`,
`docs/bugs/0716-a-sofa-purchase-line-lost-its-category-on-the-so-to-po-hop-a.md`).
Its gate 6 refuses any build with a goods-receipt line, and every one of the 14
carries exactly one. Run 34220188752 (plan, `DOC=HC-PO-009435`, on main at
`db9b124`, 2026-09-08 11:21Z) says so verbatim: *"downstream has moved - 1
goods-receipt line(s) (HC-GR-005256-PO-009435)"*, PROVABLE 0. It also leaves
`item_group` as it found it, on purpose, deferring the category to the 0514 lane.
The collapsed `-1S` probe (run 34219111494, recorded in
`docs/bugs/0715-twenty-sofa-item-codes-are-bound-as-sofa-but-do-not-say-so-a.md`)
does not contradict this either: its purchase-order corpus is `item_group =
'sofa'`, where it found 9 bare `-1S` rows and 0 never-decomposed ones. The 14
rows here are filed `others`, so they sat outside that corpus as well.
So on this population the two tools do not overlap: that one owns the shape with
no receipt; this one owns the shape with a migrated, movement-free receipt, and
writes the category because the sofa stock import and `computeVariantKey` both
key on it and neither can be made to ship the sofa without it.

**Fix.** `backend/scripts/repair-mislabelled-sofa-po-lines.mjs` +
`.github/workflows/repair-mislabelled-sofa-po-lines.yml` (plan by default,
CONFIRM phrase on apply, one transaction per build, fresh-connection SHAPE
verify). It walks the book's own PODTL.FromSODtlKey edge from the purchase line
to the sales compartments, requires the purchase text to decode — by the same
`parseSofa` — to the same pieces in the same order (or to be the same text),
and then re-codes the purchase row as the first compartment, filed `sofa`,
dedicated to that compartment, inserting the rest at 0 money each dedicated to
its own compartment; the migrated receipt line splits with it. The variants are
COPIED off the sales compartment so the lot lands in the bucket the allocator
reads. A build with a delivery-order line, a receipt that really moved stock, a
sales side that is itself a placeholder, or a purchase text that says a
different sofa is refused and named. The pure half is
`backend/scripts/lib/mislabelled-sofa-po-plan.mjs`, pinned by
`backend/tests/mislabelledSofaPoPlan.test.mjs` (the population predicate and
every refusal; 24 tests, run green on this branch).

**Ran, all three steps, on production 2026-09-08 (owner ruling the same
evening: `item_group = 'sofa'` may be written; merge and run).** PR #3270 merged
through the queue as `b387a0e` at 11:50Z.

| step | run | what it reported | what the live database showed afterwards |
| --- | --- | --- | --- |
| 1 plan | 34222789273 | 9 builds planned, 5 refused (delivery-order lines already on the compartments), 0 deletions | — |
| 1 apply | 34222954681 | `builds applied 9 of 9; shapes verified 9`, totals held on every purchase order and receipt | 12:57:06Z: HC-PO-009435 holds `8030-2A(LHF)` + `8030-1A(RHF)`, both `sofa`, each dedicated to its sales line, receipt split with it (lead piece keeps RM 1,950.00, the other 0) |
| 2 dry-run | 34229086324 | 22 lots to create across 10 batches; the projection said 0 lines would go READY because the 19 repaired compartments were ALREADY READY (see below) | — |
| 2 apply | 34229613738 | the same 22 | 13:11:12Z: lots present for the 9 batches at the purchase line's warehouse, Lisa's two at Balakong under batch HC-PO-009435, variant key identical to the sales line's |
| 3 dry-run | 34230476031 | `canonical result: ok=true linesFlipped=22 ordersAdvanced=0 ordersRegressed=0`, rolled back | — |
| 3 apply | 34230737819 | the same, committed | 13:16:30Z: the 19 compartments of the 9 orders carry `allocated_batch_no` = their own purchase order's number, `stock_status` READY, order status READY_TO_SHIP |

Two things the runs taught that the plan above did not say:

- **The compartments went READY before the stock was opened.** The audit log
  on HC-SO-012565 shows `system (auto-allocate)` flipping `2 line(s) → READY`
  and the order to READY_TO_SHIP at 12:02:57Z, eight minutes after step 1 and
  an hour before step 2. That is `isHardBoundLine` doing what its comment says:
  a company-1 sofa line reads READY through its OWN dedicated, received purchase
  line, and step 1 had just written that dedication. READY without a batch is
  still not shippable — the batch guard reads `allocated_batch_no` — which is
  why steps 2 and 3 were still needed and why step 2's projection (which only
  counts PENDING lines) printed 0.
- **Step 2 also opened lots for a build outside this population**, HC-PO-009712
  (HC-SO-012629), under the import's own rules. That is a second, separate
  defect — the build already had lots under a different variant key — recorded
  in `docs/bugs/0721-the-sofa-stock-import-opened-a-second-set-of-lots-for-a-buil.md`
  and NOT repaired here.

**What is NOT proven:** nobody has pressed Create Delivery Order on
HC-SO-012565 since. The two gates it failed read warehouse, batch and variant
key, and all three now match the lots; that is LIKELY, not PROVEN, until the
delivery on 2026-09-09 is created.

**Not fixed here, offered as options.** The pick screen's Remaining column is
delivery arithmetic and carries no stock signal, so an operator learns the sofa
cannot ship only on the last screen. The ledger entry records the gap; a Stock
column on the picker is the owner's call.

**Ref.** claude/so-do-conversion-remaining-wz1d5x, 2026-09-08.
