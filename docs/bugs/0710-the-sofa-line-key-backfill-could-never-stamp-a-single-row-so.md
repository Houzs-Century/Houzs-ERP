## The sofa line-key backfill could never stamp a single row, so 89 migrated sales orders were uneditable [high]

<!-- area: AutoCount sync + write-back -->
<!-- status: fixed -->

**白话.** 沙发的单子在账本里是一行，在我们系统里是一件一件分开的行。中间靠一个看不见
的编号把它们对回账本那一行。有 89 张已经搬进来的销货单少了这个编号 —— 以后员工要在
ERP 改这些单，会被整张挡下来，改不了。我们本来有一支程式要补这个编号，但它从来没补成
过一行，因为它认不出「同一张沙发的两个型号写法」。修好之后，89 张剩下 8 张。

**Symptom.** `backfill-ac-sofa-line-keys.mjs` had seven runs in its history and
its last dry run, `34163860885` (2026-09-07 21:38), ended:

```
SO sofa lines: sofa builds 88 in 88 document/model group(s); rows to key 0;
  no mapping 0; no AutoCount line 50; count mismatch 38
```

**`rows to key 0`, every time.** Read as a status line it says the sofa keys were
attempted and there was nothing to do. It says the opposite. Measured on
production the same day (plan run `34209494838`): **237 of 1,168 sales-order sofa
rows carried no `linked_ac_dtlkey`**, and **89 migrated sales orders held at
least one keyless line**. `composeEdit` refuses the WHOLE document when one
compartment has no key (`src/scm/lib/autocount-line-keys.ts:155`), so those 89
were orders staff could not edit at all — days before the owner opens sales-order
editing. The reconcile could not read them either: 90 of 547 sofa lines sat in
its `unread` compartment column.

**Root cause (traced).** Three defects in the script's own matching rule. None is
in the data.

1. **It did not fold `SOFA_MODEL_ALIAS`.** It resolved a build to `<model>-1S`
   and looked that string up in `autocount-erp-mapping-1561.csv`. The floor
   writes one sofa under two numbers — 5530/9028, 5536/9058, 5537/8030,
   5540/8030 — so the sheet maps `HOK-5530 SOFA -> 5530-1S` while our rows are
   `9028-1A(LHF)`. Run locally against the committed snapshot: `HOK-5530 SOFA`
   resolves to `SOFA 9028` only once folded, and `acByErp.get("9028-1S")` holds
   `AMN-SF9028 SOFA` and `DSL-9028 SOFA` — never the HOK line. That is the whole
   of `no AutoCount line 50`. Every other sofa script in the directory folds it;
   this one did not.
2. **It read the OUTSTANDING cut, not the book.** `ac-outstanding-so.json.gz`
   holds 2,789 documents and 14,041 lines; `ac-reconcile-truth.json.gz` holds
   13,378 and 62,742 with **no filtering**. A sofa line already transferred is
   absent from the first while its document is not — the same blind spot
   `docs/bugs/0694` records for `topup-ac-so-lines.mjs`.
3. **Its build map was degenerate.** `builds` was keyed by `${acDocNo}|${model}`
   and then grouped into `byDocModel` by the same string, so a group ALWAYS held
   exactly one build. A document with two sofas of one model therefore read
   *"1 build(s) here, 2 AutoCount line(s)"* and was refused **by arithmetic**,
   not by ambiguity. That is `count mismatch 38`.

**Fix.** The script no longer carries a matching rule of its own. It reads the
full book and calls `planLineKeys` from `lib/ac-forced-line-pairing.mjs` — the
module that already stamped the migrated goods receipts and delivery orders, and
that canonicalises both sides through `comparisonKey` (alias and all; 5535 is its
own model and is never folded). Third caller, not third copy; two tools answering
one pairing question differently is `docs/bugs/0708`.

That module gained one clause, for (3): where every compartment row of a model on
a document carries a build text, the rows are grouped by it and each unit is
matched to the book line stating the **same** text — exact equality after
`normaliseDesc2`, and a perfect bijection or nothing. It splits only on evidence;
one blank build text on that model and it folds exactly as before, which is why
the goods-receipt and delivery-order lanes (which pass no build text) are
unaffected. Proved by running the downstream plan from `main` (`34210033771`) and
from this branch (`34210128201`): both read `GR ... 0 to stamp; 563 already
keyed; 73 NOT stamped` and `DO ... 796 already keyed; 36 NOT stamped`, character
for character.

Tests: `tests/acForcedLinePairing.test.mjs` +6, proved RED with the split
disabled — **3 failed / 30 passed**, 34 passed with it.

**APPLIED to production**, run `34210459226` (2026-09-08 17:33 +08):
`APPLIED: 224 row(s) stamped of 224 planned`, on 121 book lines across 81
documents. **Uneditable sales orders 89 -> 8.** Sofa rows with no key 237 -> 13.
The reconcile's sofa `unread` column went 195 -> 113 and its document headline
23 -> 21.

**Ref.** fix/sofa-keys-unread, 2026-09-08.
