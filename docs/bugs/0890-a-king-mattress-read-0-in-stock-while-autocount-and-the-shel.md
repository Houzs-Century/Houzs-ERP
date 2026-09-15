## A King mattress read 0 in stock while AutoCount and the shelf had 2 - its stock and its orders sat on two catalogue codes [high]

<!-- area: Cutover + migrated data -->

**Symptom.** Owner, 2026-09-14, with a screenshot of Inventory filtered to
`DL-CS2 NN-WINTER SLEEP MATT (K`: "inventory not accurate. autocount shown have
2pcs. ERP shown 0. Physical qty is 2pcs for king". The row read Stock 0,
Scheduled 1, Unscheduled 7, Spare -8.

**Root cause (traced).** One mattress has two ERP catalogue rows. The stock sits
on one and the sales-order lines on the other, and everything that counts stock
matches on the exact item code: the Inventory list groups by `mfg_products.code`
(`backend/src/scm/routes/inventory.ts`, `GET /products`), allocation loads
balances by the lines' own codes (`backend/src/scm/lib/so-stock-allocation.ts`,
the `inventory_balances` read), and the delivery stock guard checks per code.

Read-only production runs, "Duplicate item-code impact (read-only)", company 1,
2026-09-14 (counts only):

| run | code | catalogue rows | sales-order lines | on hand |
| --- | --- | --- | --- | --- |
| 34823557340 | `DUNLOPILLO COOLSILK 2.0 NANO-G WINTER SLEEP MATT (K)` | 1 | 0 | 2 |
| 34823557340 | `DL-CS2 NN-WINTER SLEEP MATT (K` | 1 | 6 | 0 (8 movements netting 0) |

AutoCount holds `DL-CS2 NN-WINTER SLEEP MATT (K` = 2 at PG in every committed
book snapshot (`ac-seed-baseline-balance.json.gz` 2026-08-28,
`ac-live-stock-balance.json.gz`, `ac-stock-balance-2026-09-10.json.gz`), and the
mapping sheet sends that code to the long name. The totals agree; the split is
the defect.

How the two rows came to exist:

1. AutoCount caps an item code at 30 characters. The book holds exactly nine
   codes of length 30 with an unbalanced parenthesis (measured from
   `ac-live-item-master.json.gz`, 1,623 codes; pinned by
   `tests/truncatedCodeMergePlan.test.mjs`).
2. The first cutover pass mapped those strings to themselves, so ERP catalogue
   rows were minted with the truncated codes.
3. docs/bugs/0567 (#2789, 2026-08-29) rebuilt the mapping rows to paren-closed
   names and `rename-new-code-rows.mjs` moved the stock to the family's long names
   the next day. Neither retired the truncated rows.
4. The 2026-09-07 sales-order migration wrote the book's own code onto its lines
   - which `lib/item-code-class.mjs` rightly calls the same product, while stock
   matching does not.

The same mechanism left three display units counted twice. The 2026-09-10
stock-vs-AutoCount run (34449850723) listed three cells as ERP-only
"CUTOVER ADJUSTMENT ONLY": `DL-CS2 NN-WINTER SLEEP MATT (Q` at PENANG DISPLAY,
`DL-CS2 NN-WINTER DREAM MATT (K` at PENANG DISPLAY, `HL-DT-GERALD 114/109 (900X1800`
at BALAKONG DISPLAY. The impact runs on 2026-09-14 show each survivor already
holding AutoCount's figure: Winter Sleep (Q) long name 5 against AutoCount 5
plus 1 on the truncated code (34823576157); Gerald 1 and 1 against AutoCount 1
(34824949414); Winter Dream (K) 1 on the truncated code against AutoCount 0
(34824066865). That unit is most likely the Arctic Dream (K) display piece the
pre-#2789 mapping filed under the Winter Dream code: Arctic Dream (K) already
holds 1 on its own code (34825498158) against AutoCount's 1. The identity of that
unit is inferred from the old mapping; the surplus is measured. The other five
truncated codes carry both rows and nothing else (34824247650, 34824462036,
34824716046, 34825113633, 34825294933).

Why nothing caught it: `check-stock-vs-autocount.mjs` compares cells through the
mapping sheet, so it saw the long name agree and reported the truncated code only
as ERP-only stock. It never looks at demand, so six order lines with no stock on
their code were not a finding.

**Fix.** `backend/scripts/merge-truncated-ac-codes.mjs`, with the rules in
`backend/scripts/lib/truncated-code-merge-plan.mjs`, dispatched through
`.github/workflows/merge-truncated-ac-codes.yml`. Plan by default. It measures the
pairs from the book files instead of listing them, and applies in two parts:

- `lines` re-keys the sales-order lines to the survivor (item_code only) and
  switches off the truncated rows that hold no stock. Nothing about quantity or
  value moves.
- `writeoff` removes a unit on a truncated code only where the survivor already
  holds AutoCount's balance at that warehouse: one negative ADJUSTMENT per lot,
  aimed at the lot, then the row goes INACTIVE. This takes the lots' cost out of
  inventory value, so the plan prints the total and it is a separate decision.

It refuses a whole pair when the two ledgers disagree, stock moved after the
snapshot, units look real rather than doubled (survivor + truncated = AutoCount,
which needs a move), any other document still carries the code, the survivor is
missing or INACTIVE, or a lot has no variant key.
`backend/tests/truncatedCodeMergePlan.test.mjs` pins the pair census against the
committed book and each refusal. Proved RED by mutating the planner on
2026-09-14: a write-off rule that ignores AutoCount failed 2 of its tests, and a
refused pair that kept its plan failed 3.

**Production, as run.** The owner confirmed both parts and the recompute in
writing on 2026-09-15.

| run (UTC) | what | result, from the run's own log |
| --- | --- | --- |
| 34831706513, 2026-09-14 10:09 | plan | 9 pairs, 0 refused; part lines 6 lines on 6 orders + 6 rows; part writeoff 3 units, RM 3026.00, + 3 rows |
| 34932893347, 2026-09-15 05:28 | apply `lines` | 6 lines re-keyed, 6 rows INACTIVE, 6 of 6 pairs committed. Fresh-connection verify: the King long name carries the 6 lines and PG WAREHOUSE 2 (AutoCount 2); the truncated code 0 |
| 34933070592, 2026-09-15 05:31 | apply `writeoff` | 3 units written off, 3 rows INACTIVE, 3 of 3 committed, movement cost equal to the plan. Winter Sleep (Q) now PG DISPLAY 1 + PG WAREHOUSE 4 (AutoCount 1 + 4); GERALD KL DISPLAY 1 (AutoCount 1); Winter Dream (K) none (AutoCount 0) |
| 34933239234, 05:33 | allocation recompute, global dry-run | 3 lines would flip, 1 order advanced, 0 regressed |
| 34933439014, 05:36 | allocation recompute, global apply | the same 3 flips committed and read back on a fresh connection: HC-SO-002331 Winter Sleep (K) PENDING -> READY, header IN_PRODUCTION -> READY_TO_SHIP; two unrelated STOOL lines READY -> PENDING by the allocator's own rules |

The recompute had to be GLOBAL. A doc-scoped run deducts every order's
outstanding quantity from the bucket before allocating
(`recomputeSoStockAllocation`'s `scopeToDocNo` note), so with 8 ordered against
2 on hand no scoped order could have been given a unit. Only one of the two
units went READY: the allocator gives stock only to an order with a processing
date, and HC-SO-002331 is the one order of the six in production. That the
other five carry no processing date is inferred from their CONFIRMED status and
was not queried.

After the retire, searching Inventory for the book code
(`DL-CS2 NN-WINTER SLEEP`) finds nothing, because the long name does not contain
it; "WINTER SLEEP" finds the row.

**Ref.** fix/truncated-ac-code-merge, 2026-09-14. Owner ruling the same day: keep
the mapping sheet's name, move the lines, switch the truncated rows off, take the
double-counted units out.
