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

What the repair does NOT do, and what still has to happen after it: open the
stock (that is `import-ac-sofa-stock.yml`, which will now see the builds) and
bind the batch (the allocation recompute). Neither has been run against
production as this entry is written; the 2026-09-09 delivery depends on all
three.

**Not fixed here, offered as options.** The pick screen's Remaining column is
delivery arithmetic and carries no stock signal, so an operator learns the sofa
cannot ship only on the last screen. The ledger entry records the gap; a Stock
column on the picker is the owner's call.

**Ref.** claude/so-do-conversion-remaining-wz1d5x, 2026-09-08.
