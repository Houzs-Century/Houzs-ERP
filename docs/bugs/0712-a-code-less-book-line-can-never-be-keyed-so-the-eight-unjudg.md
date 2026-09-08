## A code-less book line can never be keyed, so the eight unjudgeable sales orders are the line-key backfill working as written [medium]

<!-- area: AutoCount sync + write-back -->

**白话.** 对账的时候，有 8 张销售单系统说「这张我没办法一行一行比对」。查出来原因很
简单：账本上有些行是店员直接打字写的，没有货号。我们补「行号」的程式是靠货号去认哪一行
对哪一行的，没有货号就认不出来，所以那些行永远补不到行号——**不是资料错了，是那支程式
本来就做不到。** 这些单的金额和货品都跟账本一模一样，只是「哪一行对哪一行」不知道而已。

**Symptom.** The reconcile reports, and has reported all week:

```
SO — Sales Order: 2882 paired document(s); 8 UNJUDGEABLE (an ERP row carries no
     AutoCount key); 2865 claim every book line; 9 do NOT
```

(probe run `34211433089`, section B). `HC-SO-000015` is the extreme case: **0 of
3** rows carry a key, so nothing can state anything about its lines — while its
header, its three products and its money all equal the book to the sen.

**Root cause (traced).** `backend/scripts/backfill-ac-line-keys.mjs` is what
stamps `linked_ac_dtlkey` onto migrated sales and purchase lines, and it buckets
by the TRANSLATED item code:

```js
const acKeys = (rows, codeField) => {
  const m = new Map();
  for (const r of rows) {
    const erp = byAc.get(norm(r[codeField]));
    if (!erp) continue;                      // <- a code-less book line exits here
    const k = `${r.DocNo}|${norm(erp)}`;
    ...
```

`byAc` is `data/autocount-erp-mapping-1561.csv`, keyed on the AutoCount item
code. **A book line with no item code has no row in it**, so `continue` fires,
no bucket is ever created for that line, and the ERP row the importer minted for
it — by resolving the free text against the pick list — can never receive a key.
It is not a miss the backfill could report: the line is invisible to it by
construction.

Measured, and the pattern is exact — probe run `34213244770`, section F:

| document | rows keyed | the keyless row(s) |
| --- | --- | --- |
| `HC-SO-000015` | 0 of 3 | all three book lines are code-less |
| `HC-SO-000102` | 3 of 4 | `TRANSPORTATION CHARGES`, from the book's code-less `DELIVERY FEE ` |
| `HC-SO-001180` | 9 of 10 | `TRANSPORTATION CHARGES`, from a code-less priced row |
| `HC-SO-001463` | 3 of 4 | same shape |
| `HC-SO-001473` | 4 of 5 | same shape |

Every keyless row corresponds to a code-less book line and every keyed row to a
coded one. `mfg_so_audit_log` has **zero rows** on all of them except
`HC-SO-000814`, whose four entries are `UPDATE_LINE by system (auto-allocate)` —
so no person edited any of these orders and the keyless rows are the import's
own, exactly as the importer wrote them.

**This refutes the reading that reached for a repair.** A keyless row looks like
a row somebody re-entered by hand, and on `HC-SO-000015` that reading would have
concluded two lines were missing and written them — onto a document that already
holds them. The provenance is what settles it, not the key's absence.

**Fix.** Not a write. `backend/scripts/probe-dropped-book-lines.mjs` section F
reports, per document, how many rows carry a key and what the audit log says,
so the next reader gets the provenance instead of inferring it from the gap. The
reconcile's UNJUDGEABLE verdict is CORRECT and stays: pairing those lines by
position is what produced transposed pairs five times on 2026-09-07/08, and the
keyless-multiset verifier (`docs/bugs/0700`) already answers the question that
matters — same goods, same quantities, whatever order the rows are in.

**What would actually close it, and why it is not done here.** A code-less book
line can only be keyed by matching on something other than the item code —
description, or position within the document — and a private matcher built
inside a repair script is this repo's most expensive recurring bug
(`docs/bugs/0707`). It is a decision about the SHAPE of the key backfill, not a
defect to patch, and it buys only the ability to line-match five documents whose
goods and money already agree.

**Ref.** `fix/dropped-book-lines`, 2026-09-08.
