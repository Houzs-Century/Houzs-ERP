## The cost-stamping script priced a queen bed from a king's purchase line [high, money]

**Symptom** — `stamp-po-line-costs.mjs` planned to write RM470.00 onto
`DIVAN ONLY-(Q)` x3 and RM641.50 onto `ELEGANT (A)-(Q)` x1. The queen's own
purchase history is RM325 median over 152 lines (+44.6%) and RM585 over 52
(+9.7%). Worse, the dry-run log printed `LEFT AT ZERO` for those very lines
while the plan stamped them, so the log said the opposite of what APPLY would do.

**Root cause (traced, not guessed)** — the pricer resolved per
`(PoNo, ItemCode, Desc2)` but the TARGET lookup dropped the item code:
`bySigKey` was keyed `${ac_doc}|${sig(description2)}`. **Desc2 carries the
fabric, the leg and the gap — the SIZE lives in the item code.** So two bed
sizes on one purchase order share a Desc2 and collapse into one key. Measured
over the snapshot: of 170 target keys, 10 hold more than one line and 9 hold
more than one item code. The two above resolve to different prices, and in both
the priced sibling is a different bed size. Once stamped the line reads as
PRICED, so the new receipt gate could never catch it — the script defeated its
own guard. The contradictory log came from the same split: the `!hit` branch
counted the unpriced AutoCount line as left-at-zero while a *different*
AutoCount line's price reached the same ERP row through the code-blind key.

**Fix** — the decision moved out of the script into
`backend/scripts/lib/po-cost-plan.mjs`, where it runs with no database and is
unit-tested (`tests/poCostPlan.test.mjs`, wired into `test:scale-contract`).
Every key now carries the item code, by three routes, most exact first:
`linked_ac_dtlkey` (migration 0273, a 1:1 identity); `supplier_sku`, which holds
the RAW AutoCount `ItemCode` because `import-ac-outstanding-po.mjs` stores
`sku: l.ItemCode` verbatim — better than the mapping CSV, since a minted sofa
SKU still carries its AutoCount code there; then `material_code` via the CSV. A
DtlKey pointing at a different item code is refused rather than followed, and an
ERP row two AutoCount lines want at *different* prices is refused rather than
resolved. `plan[]` holds one entry per ERP id, so the closing count is no longer
inflated by double-counting. The dry-run prints one line per planned write —
the same list APPLY walks — plus the complement (`plan` and `skipped` partition
the rows read, asserted by a test), so the log and the write can no longer
disagree.

That partition test proves the DECISION partitions the rows; it cannot catch a
script that prints one list and writes another, which is the half that actually
shipped. Three further tests assert the SCRIPT's traversal against its own
source: exactly two `for (const p of plan)` blocks — one printing, one writing —
with the single `UPDATE` inside the second; no loop over `book.*` and no
`unmatchedUnits` counter, the walk that produced the false narration; and every
iteration in `main()` drawing from `plan`/`skipped` or a grouping of them, so no
third tally can be printed. Structural because `main()` opens a database
connection on import and cannot run in this harness. **Mutation-verified:** clean
**18 pass**; reintroduce the `book.poLines` narration loop and it is
**16 pass / 2 fail**; filter the printed list while APPLY keeps the full plan and
it is **17 pass / 1 fail**.

**Provenance of the footprint numbers — read this before quoting them.** Pre-fix
32 lines / 65 units / RM 9,482.00, post-fix 30 lines / 61 units / RM 7,430.50,
i.e. exactly the 2 lines / 4 units / RM 2,051.50 of wrong money removed. These
come from a RECONSTRUCTED ERP row set, **not** from the script's own production
DRY-RUN, which **has never been run** — `workflow_dispatch` resolves a workflow
from the DEFAULT branch, so while `stamp-po-line-costs.yml` exists only on this
branch it is not dispatchable (observed 2026-08-11:
`HTTP 404: workflow stamp-po-line-costs.yml not found on the default branch`).
**Treat the numbers above as an estimate of the right order, not as measurement.**
The binding sequence is therefore: merge, then dispatch the workflow at
`apply=0`, then read ITS `-- planned writes --` list — that list is the exact set
`apply=1` writes — and only then dispatch `apply=1`.

What IS measured in CI, on the real committed snapshot rather than by hand, is
the collision the fix removes: `tests/poCostPlan.test.mjs` re-derives from
`scripts/data/ac-po-line-costs.json.gz` that the pre-fix `(PoNo, Desc2)` key
yields 170 keys of which 9 merge more than one item code, that adding the item
code splits them apart, and that PO-009826 and PO-009802 are among them. That
assertion fails if the snapshot ever stops exhibiting the defect, which is the
signal to re-derive the footprint rather than trust the estimate above.

**What the audit RULED OUT** — the reviewer suggested `linked_ac_dtlkey` made a
1:1 match available today. It does not: a read-only production dry-run of
`backfill-ac-line-keys.yml` on 2026-08-10 reported `PO lines: erp lines 864; to
set 275; **already set 0**` — the column exists and is entirely NULL in
production. The DtlKey route is implemented and preferred, but every match today
comes from `supplier_sku` + Desc2. Do not assume that column is populated.

**The class, for next time** — *a key that resolves a value and a key that
selects the row it lands on must be the SAME key.* Two keys that differ by one
field look equivalent in review and diverge only where the dropped field is the
discriminator — here, exactly on the beds that share a fabric. And a dry-run
that reports on the SOURCE side while APPLY writes on the TARGET side is not a
dry-run; print the write set itself.

**Ref** — PR #1907 review round 2, 2026-08-11.
