## A purchase order line with no so_item_id hides itself from the hard-bound sofa set [high]

**Symptom.** Owner, 2026-09-11, with two screenshots of the MRP page:
*"SO-011114 already have PO:010045, please update why only item 3 no show PO?"*
and *"SO-013389 this already have PO-010087, please update it"*. In both the
purchase order is open, the goods are not received, and the sales-order line
still reads SHORT — so the buyer is asked to order sofas that are already on
order, and the sales order can never reach READY.

**Root cause (traced, on live prod, read-only).** Not one cause — two, and the
second was not previously recorded anywhere. Since 2026-09-09 a company-1
hard-bound line (sofa / bedframe / `(SP)` mattress) is covered ONLY by a
purchase-order line that (a) carries its `so_item_id` and (b) is itself on a
hard-bound `item_group`: `isDedicated` in `backend/src/scm/routes/mrp.ts` needs
`!!r.so_item_id && isHardBoundLine(r.item_group, r.item_code)`, and section 8's
`boundSofa = boundCompany` then reads `dedicatedOpenByLine` and nothing else.
The rule is correct and is the owner's. What it exposed is dirty purchase-order
data on the two documents he sent:

| document | which condition fails | what the row actually holds |
| --- | --- | --- |
| `HC-PO-010045` / `9058-STOOL` | (a) | `so_item_id IS NULL`, while the same PO's `9058-2A(LHF)` and `9058-1A(RHF)` lines are linked — which is exactly why only item 3 reads SHORT |
| `HC-PO-010087` / `8030-1A(LHF)` | (b) | linked to the right sales-order line, but `item_group = 'others'` on a line whose sales-order side is `sofa` |

`HC-SO-013389`'s other half, `8030-1A(RHF)`, is NOT this bug: no purchase order
anywhere carries it. That piece genuinely has to be ordered.

Condition (b) is the new shape. `docs/mrp-stock-vs-bound-rules-2026-09-09.md`
§3 recorded the missing-link shape; a wrong `item_group` hides a purchase order
just as completely, and nothing had looked for it.

Census on live company-1 purchase orders (the read-only plan below, run
2026-09-11): **6** hard-bound lines with no `so_item_id` — every one created
2026-08-28, `from_mrp = false`, `line_no` NULL, i.e. one batch of hand-opened
POs — and **1** line failing (b). The §3 repair item (`HC-PO-009024` /
`HC-SO-012025`) was re-read on prod and is now fully linked; that item is
closed.

**Fix.** `backend/scripts/repair-mrp-po-line-links.mjs` +
`.github/workflows/mrp-po-link-repair.yml` — plan by default, apply behind a
confirm phrase, one column written per row (`so_item_id` or `item_group`,
never qty/price/status), and a verification that re-opens a FRESH connection
and asserts the row's SHAPE rather than a row count. Its evidence bar is §3's,
because §3 measured what a looser one costs: the PO's other lines must resolve
to exactly ONE sales order, and that order must have exactly ONE live,
still-uncovered line with this item code in this warehouse. On the 2026-09-11
plan that admits 3 rows and refuses 4, each with its own printed reason.

**This is a data repair, so there is no code test to prove RED** — the engine is
right and is not being changed. The plan was run against the read-only
production DSN and its output is in the PR body and in
`tasks/MRP-REDESIGN-2026-09.md` Track E. **APPLY has NOT been run** — it is a
production write and is the owner's call; the two screenshots going green is a
prediction from the rule as read, not an observation, until E4 and E5 run.

**Ref.** `fix/mrp-po-link-repair`, 2026-09-11. Rules read in
`scm/lib/so-stock-allocation.ts` (`isHardBoundLine`, `HARD_BOUND_COMPANY_ID`)
and `scm/routes/mrp.ts` (`isDedicated`, section 8 `boundSofa`).
