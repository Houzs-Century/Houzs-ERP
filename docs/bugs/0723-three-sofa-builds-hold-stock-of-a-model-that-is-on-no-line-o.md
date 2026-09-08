## Three sofa builds hold stock of a model that is on no line of the order they claim to come from [medium]

<!-- area: Inventory, costing, FIFO -->
<!-- status: open -->

**白话.** 有三张采购单，仓库里挂着的沙发件跟单上的型号对不上 —— 单上写的是 A 型
沙发，库存里却挂着 B 型的件，一共 9 件（等于多算 3 台沙发）。**为什么会这样还没
查清楚**，所以先记下来，一件都没有动。修重复库存那个工具会把它们列出来但拒绝处
理，等查清楚再说。

**Symptom.** Read live on production 2026-09-08. Three purchase orders carry
open sofa cutover stock whose compartment codes belong to a model that appears
on no line of that order:

| batch | its own sofa lines are | the lots hold | pieces | written |
| --- | --- | --- | --- | --- |
| HC-PO-009712 | `5535-*` | `8030-*` | 3 | 2026-09-07 20:49:38 |
| HC-PO-009017 | `9058-*` | `8030-*` | 3 | 2026-09-07 20:49:48 |
| HC-PO-009550 | `8030-*` | `9058-*` | 3 | 2026-09-07 20:49:43 |

All nine carry the sofa opening lane's own note text, `AutoCount sofa opening:
PO-0097xx received, batch HC-PO-0097xx`, so they were written by
`backend/scripts/import-ac-sofa-stock.mjs` — run 34160820055, the display-sofa +
binding-category release.

**Root cause: UNKNOWN, and two stories are already dead.** This is recorded
rather than explained, because both explanations that fit the shape were checked
and refuted:

- *"Two ERP purchase orders share one AutoCount document, so a build takes its
  neighbour's number."* REFUTED: each of the three maps 1:1 to its own
  `linked_ac_docno` (`PO-009712`, `PO-009017`, `PO-009550`), and no
  `linked_ac_docno` in company 1 is carried by two purchase orders — the
  group-by returns zero rows.
- *"The 009017 / 009550 pair is a straight swap, so the importer paired builds to
  batches off by one."* The 009712 row does not fit that story at all: its lots
  are 8030 and neither of the other two orders is a 5535.

What IS established: the importer takes the lot's code from the order's own line
(`code: l.item_code`, section 6). For these rows to exist, those lines must have
carried the other model at 2026-09-07 20:49 and been re-coded since. Which lane
re-coded them is not established — `scm.entity_audit_log` holds nothing for the
three orders' item ids, so whatever wrote them wrote directly. The 8030 codes on
this family come from `SOFA_MODEL_ALIAS` (HOK-5537 / HOK-5540 supplier SKUs map
to `8030-*`), which is where a re-coding lane would plausibly have been working.

**Why it is not "just" 9 pieces.** A sofa is sold as a set of compartments, so
9 pieces read as 3 whole sofas in
`backend/scripts/lib/sofa-piece-fold.mjs` — the arithmetic the AutoCount stock
reconcile compares against the book. They are part of the ~20-sofa overstatement
recorded in
`docs/bugs/0721-the-sofa-stock-import-opened-a-second-set-of-lots-for-a-buil.md`,
and the only part of it that tool refuses to touch.

**Fix.** None, deliberately. `backend/scripts/lib/duplicate-sofa-lot-plan.mjs`
detects the class and REPORTS it — `MODEL NOT ON THE ORDER`, naming the models
the order does carry — and `repair-duplicate-sofa-cutover-lots.mjs` never
retires it. Two tests in `backend/tests/duplicateSofaLotPlan.test.mjs` pin that
refusal, including the case where such a cell ALSO carries two variant keys, so
a future change to the duplicate rule cannot start retiring these by accident.

Retiring them would remove stock; re-coding them would rewrite it. Both are
answers to "which sofa is physically on that shelf", and nobody has looked.
**The next step is a floor check, not a script.**

**Ref.** claude/so-do-conversion-remaining-wz1d5x, 2026-09-08. Found while
measuring the population for 0721.
