## 962 migrated sales-order lines still offer themselves for purchase after their purchase order was raised [high]

**Symptom.** On a migrated (HC-*) sales order whose purchase order was already
raised in AutoCount and imported, the line still appears in the Convert-from-SO
picker as needing to be ordered. Nothing on the screen says it was already
bought, so a second purchase order can be raised for goods that are already on
the way. Measured on production 2026-09-08, company 1: **962 of 15050** live
sales-order lines, **all 962 reading LOW** and **all 962 on a migrated order**;
0 on an ERP-native one.

**Root cause (traced).** The SO->PO ceiling is `qty - po_qty_picked`
(`po-over-convert.ts:32-35`), so a counter stuck at 0 makes the line read
entirely unpurchased.

`po_qty_picked` has exactly one writer, `recomputeSoPicked`
(`mfg-purchase-orders.ts:2843-2887`), and it only ever runs from a route
handler. The cutover wrote those purchase-order lines from a script, not a
route. `repair-migrated-po-lines.mjs:369-383` — the script that stamped the
`so_item_id` dedications — states the consequence in its own comment:

> "po_qty_picked is NOT recomputed here, and that is a real gap, named so it is
> not discovered later. ... A dedication stamped by this script therefore does
> not move the counter, so these SO lines keep reading as still-needing-ordering
> in the From-SO picker (qty - picked > 0) — a duplicate-PO risk until something
> recomputes it."

Nothing ever recomputed it. The gap was named, correctly, and then left; it was
found again by `check-ac-convert-symmetry` section 4b, which is the "discovered
later" that comment anticipated.

**A hypothesis was tested and REFUTED on the way here.** The first reading was
that the 962 were an artefact of the check comparing against the wrong rule —
`recomputeSoPicked` drops `from_mrp` lines and excludes DRAFT purchase orders,
and the check counted both. Correcting the check to the write-path rule (0676)
changed the number not at all: **962 either way**, run 34142505986. The drift is
real, and the direction is the dangerous one.

**Fix.** `backend/scripts/recompute-so-po-qty-picked.mjs` +
`.github/workflows/recompute-so-po-qty-picked.yml`, PLAN by default.

It **invents nothing**: every value is a sum over `purchase_order_items` rows
that already carry `so_item_id`. No link is created, moved or inferred and the
account book is not consulted — `migration-copy-never-compute` governs the LINK,
and no link is touched.

It applies the app's own rule rather than a plausible one: `from_mrp` lines
dropped (an MRP-origin line is reference-only by the 2026-05-31 decision), DRAFT
purchase orders excluded alongside CANCELLED, and the result NOT clamped,
because `recomputeSoPicked` writes the raw sum. This is precisely the value the
app would write itself the next time anyone edited one of those purchase orders
— the live-count model's own promise is that it "self-heals on the next
operation that touches these SO lines". The script performs that heal
deliberately instead of waiting for a staff member to trip over it.

The rule is written ONCE and shared by the plan, the write and the verification.
Two copies is how a verification comes to agree with the bug it is checking.

Release discipline: MODE defaults to `plan`; apply needs
`CONFIRM=recompute-po-qty-picked`; each row is written by id and guarded on its
old value, so a row that moved since the plan is refused rather than
overwritten; verification reconnects on a FRESH connection, recomputes the rule
from scratch and asserts three shapes — zero rows still disagreeing, zero
negative, zero null — because a row count is not a shape and this repo has a COE
where 7-of-7 was reported while the bug was being reproduced.

**Sequencing.** `po_qty_picked` is read by MRP and by the From-SO picker, so the
apply must not race a stock re-seed or an MRP recompute. The plan is read-only
and safe at any time.

**Ref.** fix/convert-symmetry-matrix, 2026-09-08. Found by
check-ac-convert-symmetry run 34142505986.
