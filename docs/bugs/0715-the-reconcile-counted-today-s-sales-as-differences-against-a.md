## The reconcile counted today's sales as differences against an August book [high]

<!-- status: fixed -->

<!-- area: AutoCount sync + write-back -->

**白话.** 2026-09-08 傍晚交货单开放给同事用，一个钟头内对账报告就多了两张
「账本没有的单」——`HC-DO-2609-003` 和 `HC-DO-2609-011`。这两张是同事当天下午自己开
的交货单，账本的那张「照片」是当天早上八点拍的，那时候单还没存在。所以那不是错，是
新的。结果就变成：**同事每做一单，报告上的数字就多一个**，那个「0」永远到不了。

老板当天定了标准：**「差异 0」= 搬进来的资料全部对上账本**。现在报告就是照这个数：
只数搬过来的资料，ERP 自己开的新单另开一栏叫 `native`，看得见、点得出名字，不藏起来。
数字从 17 变成 14，那 3 张是新单，一张都没有从「搬过来的资料」里被拿掉。

**Symptom.** Reconcile run `34217807499` (2026-09-08, company 1) reported
**17 disagreements**, three of which were documents staff had created that day:

| document | reported as | what it actually is |
| --- | --- | --- |
| `HC-DO-2609-003` | DO phantom | delivery order created 2026-09-08T10:10:01Z |
| `HC-DO-2609-011` | DO phantom | delivery order created 2026-09-08T10:21:56Z |
| `HC-SO-2609-001` | SO phantom | sales order created 2026-09-08T06:06:50Z |

The AutoCount snapshot they were compared against was cut at
`2026-09-08T00:03:44.762Z` — before all three existed. The headline number
therefore ROSE every time somebody did their job, and could never reach zero
while the shop is trading.

**Root cause (traced).** `check-ac-erp-reconcile.mjs:634` built `phantom` from
presence alone:

```js
for (const ac of claimed) {
  if (!B.headers.has(ac)) phantom.push(`${ac} (ERP ${(erpByAc.get(ac) || pointerByAc.get(ac)).erp_no})`);
```

`claimed` is every ERP document carrying a `linked_ac_docno`, and that column
means two different things — the population `docs/bugs/0703-*` names. The cutover
import writes `"HC-" + acDoc`; the write-back stamps the ERP's OWN number on a
document the ERP created minutes earlier. The second kind is not a document the
book is missing. It is a document the book has not been asked about yet.

Nothing in the reconcile knew the difference, so the two populations shared one
column, and the comparison population was "everything the ERP holds" rather than
"what the cutover carried".

**Fix.** `backend/scripts/lib/ac-erp-native.mjs` classifies a claimed document by
IMPORTING `src/scm/lib/so-is-migrated.ts` — the rule #3251 shipped for the
migrated-sales-order lock, not a second copy of it. Two copies of one rule
answered oppositely about `HC-PO-010040` twenty minutes apart the same day
(`docs/bugs/0708-*`). A document the ERP originated is reported in its own
`native` column, named with the minute it was created, and excluded from the
difference total; it is never folded into `phantom` and never dropped.

It fails closed twice:

- a number pair fitting NEITHER shape answers MIGRATED and stays counted, exactly
  as it locks at the sales-order lock;
- ERP-native BY SHAPE is not enough. The claim is "newer than the snapshot", so
  `created_at` must be at or after the snapshot's `exported_at`. A document the
  ERP made BEFORE the cut whose number the book does not state is the opposite
  finding — the write-back says the book has it and the book, photographed
  afterwards, does not — and it stays in `phantom` with the reason printed
  beside it. **Measured: zero documents land there.** The `created_at` read is
  its own per-type query in its own `try`, so a table that cannot answer
  reclassifies nothing for that type and the run says so.

`backend/tests/acErpNative.test.mjs` pins the three production documents by name,
the carried-over `HC-SO-013361` staying MIGRATED, the no-`linked_ac_docno` case,
both fail-closed directions and the millisecond boundary. 11 tests. It was proved
RED on the unfixed tree by construction: the module under test did not exist.

**PROVED ON PRODUCTION, and the proof is in the checker.** The summary now prints
what the same run would have reported under the old population, so the narrowing
can never be taken on trust. Run `34219567205` (read-only, this branch):

```
POPULATION — ... This run would have reported 17 under the old population;
3 of those are documents the ERP made after the book snapshot was cut, so the
count is 14. 17 = 14 + 3. New since the cutover: SO HC-SO-2609-001,
DO HC-DO-2609-003, DO HC-DO-2609-011.
14 disagreements that are NOT covered by a declared design difference.
```

**No migrated count moved**, which is the standard this change was not allowed to
touch. Every other cell of the summary table is identical between run
`34217807499` (before) and `34219567205` (after) — `both` 2882/574/400/173/45/55,
GR `money` 9, PI `lineCnt` 1, IV `absent` 4, PO `decided` 1 / `no-price` 241 /
`non-MYR` 1, GR `ERP-RM0` 100 — and so is the per-document verdict: *2882 migrated
sales orders compared against the book: 2736 match it exactly and would OPEN; 146
still differ and stay LOCKED.*

**The other direction, measured rather than assumed.** An ERP-native document
whose number the book DOES state would still be compared, and that is now printed
per type: `ERP documents the book DOES state that the ERP itself originated: 0`,
on all six types. So the narrowing reached only the three documents named above.

**Ref.** `fix/reconcile-migrated-only`, 2026-09-08. Before: run `34217807499`.
After: run `34219567205`. Shape evidence: runs `34214516108` and `34215427617`.
