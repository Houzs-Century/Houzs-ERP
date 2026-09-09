## A purchase order's item code is the SUPPLIER's model, and reading it as ours nearly recoded three live rows [high]

**Symptom.** `HC-PO-010041` carried three different model names on one line, and
they were read as a contradiction to resolve:

| source | value |
|---|---|
| AutoCount's item code | `HOK-5536 SOFA` |
| its `Desc2` | `back rest (5540)` |
| the ERP | `9058` |

The owner was asked which one was right. His answer, 2026-09-09:
「那就是9058 然后去给supplier的时候才是5536」.

**Root cause (traced, not guessed).** On a PURCHASE ORDER the account book's item
code is the **supplier's** model. The `HOK-` / `AMN-` / `DSL-` / `THL-` / `RDS-`
prefix names the supplier and what follows is **their** catalogue number, not
ours. `HOK-5536 SOFA` is supplier HOK's name for the model this ERP calls `9058`,
and `back rest (5540)` is a SPECIAL ORDER on that model rather than a model at
all. **None of the three names was wrong.** There was no contradiction to
resolve.

**What it nearly cost.** `model: "5536"` was written into
`backend/scripts/data/sofa-compartment-corrections-drawings.json`. The applier
builds its target SKUs as `${model}-${piece}`
(`apply-sofa-compartment-corrections.mjs:297`), so a dispatch would have recoded
`5536-L(LHF)`, `5536-1NA` and `5536-1A(RHF)` onto three live purchase-order rows
— and carried the change down onto the receipt and its invoice, which is what
that script does. It was caught by the owner in one line before the applier ran.
Nothing was written.

**The reasoning error, which is the part worth keeping.** The failure was not the
reading of a drawing. It was treating *"AutoCount says X and we say Y"* as
automatically our error, on the strength of the standing ruling
「autocount怎么写我们就怎么写」. That ruling is about the VALUES on a line — a
price, a quantity, a compartment — and it does not extend to a column whose two
sides are naming different things **on purpose**. Before aligning a code to the
book, ask what that column MEANS on that document type.

**Fix.** The entry reverted to `model: "9058"`, which is what the ERP already
held; nothing on the document changes. The rule is recorded in the entry's `why`
and in the session memory `po-item-code-is-the-suppliers-model`.

**The consequence for the reconcile, stated so nobody re-derives it.** A PO item
code differing from the ERP's is **EXPECTED** and is not by itself a defect. The
item-code axis on purchase orders has to be read with that in mind —
`scripts/lib/item-code-class.mjs` already splits translation / decomposition /
genuinely-different, and a supplier's own catalogue number is the first of those,
not the third.

**Ref.** PR for `fix/sofa-owner-answers-0909-batch3`, 2026-09-09.
