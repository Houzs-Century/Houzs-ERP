## A PO arrived unlinked because the two importers wrote different placeholder codes for the same sofa build [high]

**Symptom.** Owner, 2026-08-31: 「我明明已经有了 Processing Date 和 Delivery
Date，并且 AutoCount 也是有连接性的（SO to PO），为什么在我们的 ERP 里面却没有
显示?」 — HC-SO-013389's relationship map showed PURCHASE ORDER "Not created",
while AutoCount's own map showed `SO-013389 → PO-010087`.

**Root cause (traced to the byte).** The purchase order IS in the ERP
(HC-PO-010087, SUBMITTED) and its line carries the book's key
(`linked_ac_dtlkey 917339`), whose `FromSODtlKey` is 915302 — the SO's sofa
line. The link failed on the ITEM CODE:

| | book | ERP |
|---|---|---|
| SO line | `HOK-5540 SOFA` | `8030-1S` |
| PO line | `HOK-5540 SOFA` | `5540-1S` |

Both importers map the code through `autocount-erp-mapping-1561.csv`
(`HOK-5540 SOFA → 5540-1S`) and then apply `SOFA_MODEL_ALIAS` (5540 → 8030).
The composition is not written in this order's Desc2 ("35 inch per seat /
Nilon bottom / Col : HR805-30 / replace the leg by fully cover"), so both sides
land on a placeholder — but they choose it differently: the SO importer writes
`${model}-1S` (aliased, `8030-1S`), while the PO importers write
`codeSet.has(ph) ? ph : erp` and then looked the SO line up by
`dedicate(l, phCode, erp)` — with `phCode` ALREADY collapsed to `erp`, so the
aliased spelling was never tried at all, twice. An aliased model could
therefore never match its own order line.

**Fix.** Two halves, because both the future and the past are wrong:
1. Both PO importers now try the ALIASED placeholder FIRST and unconditionally
   (`dedicate(l, ph, phCode, erp)` / `takeSoLine(ph) ?? …`), so a fresh import
   links.
2. `repair-dedication-from-autocount` accepts AutoCount's own pointer when BOTH
   sides are `-1S` placeholders: for an undecoded build the codes differ by
   construction and the book's link is the authority. The cross-code guard
   (bug 0571) is amended in all three of its predicates to exempt exactly that
   pair — every other code mismatch still refuses.

**Ref.** fix/report-branding-po-link, 2026-08-31. Related: docs/bugs/0570 (the
sofa vocabulary), docs/bugs/0571 (the guard's scope).
