## The cutover import dropped seventeen book lines behind one count and two of them were named goods the matcher could not read [medium]

<!-- area: AutoCount sync + write-back -->

**白话.** 搬单进 ERP 的时候，账本上有 17 行被丢掉了，程式只印了一个数字「丢了 17
行」，没说是哪 17 行、也没说是什么。老板看到这个数字时说「这些都要」——可是这 17 行
根本不是同一种东西：**2 行是真的货**（一张床垫、一个床架，名字写得清清楚楚，只是电脑
认不出型号）、**2 行是师傅写的做工指示**（「颜色 885-4」、「脚跟展示品一样」，这种要
写在货那一行的栏位里，不是自己开一行货）、**13 行账本自己什么都没写**（没编号、没名
字、没钱），其中 12 行连数量都是 0，只有 1 行写着数量 4 却没说是什么东西。

**Symptom.** `import-ac-outstanding-so.mjs` prints one line about it:

```
Blank zero-value lines dropped: 17
```

That is the whole record. Which lines, on which documents, and whether any of
them carried goods is not in the run log, not in a file, and not anywhere else.
On 2026-09-08 the owner was asked about the seventeen and answered 「这些都要」
— against a number, because a number was all there was to answer against.

**Root cause (traced).** Two separate things, and only the second is a defect in
the owner's rule's neighbourhood.

*The rule itself is correct and stays.* `import-ac-outstanding-so.mjs`:

```js
if (!erp) {
  // Owner 2026-08-09: blank AutoCount lines (no code, no name) with a price
  // are charges -> TRANSPORTATION CHARGES; a zero-value blank line is dropped.
  if (num(l.UnitPrice) > 0) { erp = "TRANSPORTATION CHARGES"; ... }
  else { droppedZero++; continue; }
}
```

*What reaches it is not one population.* Measured over all **14,041 lines /
2,789 documents** of `backend/scripts/data/ac-outstanding-so.json.gz`, the file
the importer actually read: **22 code-less lines — 5 priced (kept), 17
zero-priced (dropped)**. The seventeen are three kinds of thing:

| class | n | what it is |
| --- | --- | --- |
| NAMED GOODS | 2 | `SO-000015` dtl 123388 `AKEMI BASTION MATTRESS (153x190x25CM)` and dtl 123389 `NK-JAGER B/FRAME(Q) (152x190CM)`, both quantity 1. The free-text resolver failed, and only then did the zero-price rule fire — so on these two the drop is a MATCHER failure wearing the rule's clothes |
| INSTRUCTION | 2 | `SO-000102` dtl 15968 `COLOUR : 885-4`; `SO-000814` dtl 58981 Desc2 `LEG: FOLLOW DISPLAY`. Both quantity 0. A build note typed on a line of its own — creating a product line for one invents goods the customer never ordered |
| UNDESCRIBED | 13 | no code, no description, no Desc2, no money. Twelve carry quantity 0 and the ERP holding nothing for them is the two sides agreeing (`lib/ac-blank-book-row.mjs`). **One does not**: `SO-011384` dtl 783795, **quantity 4** — the book orders four of something it never names |

*Why the matcher failed, from the resolver's own branches* (each reproduced
against a two-product fixture, `lib/ac-name-resolver.mjs`):

* `AKEMI BASTION MATTRESS (153x190x25CM)` — `153x190` is in none of the five size
  patterns (`183x190`, `152x190`, `107x190`, `90x190`, `200x200`), so no size
  suffix could be read and the token match never ran at all. It is a
  non-standard mattress size, which is exactly the case a human resolves as
  `(SP)` and a size table cannot.
* `NK-JAGER B/FRAME(Q) (152x190CM)` — the size reads fine as `(Q)`; the token
  match then looks for `JAGER` and `BEDFRAME` in the product name and the pick
  list's row is called `JAGER-(Q)`, which contains `JAGER` and not `BEDFRAME`.
  Score 1 against a threshold of 2.

**The goods are NOT missing, and this is the part a repair would have got
wrong.** Probe run `34211433089` (`probe-cutover-so-do-lines`, read-only,
2026-09-08 09:42 UTC) reads `HC-SO-000015` as **three ERP rows** —
`AKEMI FORTRESS MATT (K)` RM 9,099.00, `AKEMI BASTION MATT (SP)` RM 0.00,
`JAGER-(Q)` RM 0.00 — header RM 9,099.00, lines summing RM 9,099.00, equal to
the book. Both "dropped" lines are on the document with the right products.
**Writing them again would have duplicated goods on a live order.**

What that costs instead: **not one of those three rows carries an AutoCount line
key**, so the reconcile calls the document UNJUDGEABLE and can state nothing
about its lines. Eight sales orders are in that state (run `34211433089`,
section B). Who wrote the rows is **UNKNOWN** from the key alone — the importer
stamps `linked_ac_dtlkey` on every line it inserts, so no row on that document
came from the import, and section F of the new probe reads the audit log to say
who did.

**The same question, for every other document type** (the owner asked
「其他order也是这样？」), over the cuts each importer read:

| type | code-less lines | outcome |
| --- | --- | --- |
| sales orders (`ac-outstanding-so`, 14,041 lines) | 22 | 5 kept as charges, 17 dropped — the table above |
| purchase orders (`ac-outstanding-po`, 501 lines) | 1 | `PO-009979` `ERGOTEX PILLOW CASE - FAIR` x20 at RM 50.00. The purchase importer has a DIFFERENT rule — no drop, an exception — and it refuses the line because `scm.purchase_order_items.item_code` is NOT NULL. It is the document's ONLY line, so **the whole purchase order is absent from the ERP**: run `34211433089` reads `PO-009979 -> (NOT IN THE ERP)`, RM 1,000.00 of goods on order the ERP does not know about |
| delivery orders (`ac-partial-dos`, 369 lines) | 3 | `DO-000097` `COLOUR : 885-4` (the same instruction as its sales order), `DO-001604` one empty row and one `* DISPOSE …` at RM 150.00 — the priced one was written on 2026-09-08 by `topup-ac-lines-from-truth` (run `34204421089`) |

**Fix.** The silence, which is what made a number the only thing anyone could
answer. `backend/scripts/probe-dropped-book-lines.mjs` +
`.github/workflows/probe-dropped-book-lines.yml` — read-only, no APPLY flag,
every statement a SELECT — names every dropped line, classifies it, asks the
**live** pick list through the importer's own resolver so a failure is reported
with the branch it fell out of, prints what the ERP holds for each affected
document, says whether each instruction reached the ERP by another route, reads
the provenance, and re-measures the movement control.

The resolver moved to `backend/scripts/lib/ac-name-resolver.mjs` **unchanged** to
make that possible: nothing could ask it WHY it failed without writing a second
copy of the matcher, which is this repo's most expensive recurring bug.
`buildNameResolver` is now `buildTracedNameResolver` with the verdict's `.code`
taken off it, so there is no branch a trace can report that the resolver does not
actually take. Pinned by `backend/tests/acNameResolver.test.mjs`, which fails on
a tree where the two are not the same function.

**What was deliberately NOT changed.** The owner's zero-price rule. The
matcher's size table and its score threshold — its only caller is a one-time
cutover import that has already run, so loosening it changes nothing in
production and can only make a future match wrong. And no line was written to
any document: the goods this bug is about are already on `HC-SO-000015`.

**Ref.** `fix/dropped-book-lines`, PR #3239, 2026-09-08.
