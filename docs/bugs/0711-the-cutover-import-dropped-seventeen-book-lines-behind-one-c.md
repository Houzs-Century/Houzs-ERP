## The cutover import dropped book lines behind one count, and reading the export alone put two real products in it that were never dropped [medium]

<!-- area: AutoCount sync + write-back -->

**白话.** 搬单进 ERP 的时候，账本上有一些行被丢掉了，程式只印一个数字「丢了 17 行」，
没说是哪几行、也没说是什么东西。老板看到这个数字时说「这些都要」——他只能对着一个数字
回答。**查下去才发现，这 17 行里有 2 行根本没被丢**：一张床垫、一个床架，电脑其实认得
出来，早就在 ERP 里了（`HC-SO-000015`，三行齐全，金额跟账本一分不差）。**如果照着那个
数字去「补回来」，就会在一张活单上把同样的货记两次。** 真正被丢的是 15 行：12 行账本
自己什么都没写、2 行是师傅的做工指示（应该写在货那一行的栏位，不是自己开一行）、
1 行写着数量 4 却没说是什么货 —— 那一行要老板看原始单据才知道。

**Symptom.** `import-ac-outstanding-so.mjs` prints one line about it:

```
Blank zero-value lines dropped: 17
```

Which lines, on which documents, and whether any of them carried goods is not in
the run log, not in a file, and nowhere else. On 2026-09-08 the owner was asked
about the seventeen and answered 「这些都要」 — against a number, because a number
was all there was to answer against.

**Root cause (traced).** Two things, and the second is the one that would have
done damage.

*The owner's rule is correct and stays.* `import-ac-outstanding-so.mjs`:

```js
if (!erp) {
  // Owner 2026-08-09: blank AutoCount lines (no code, no name) with a price
  // are charges -> TRANSPORTATION CHARGES; a zero-value blank line is dropped.
  if (num(l.UnitPrice) > 0) { erp = "TRANSPORTATION CHARGES"; ... }
  else { droppedZero++; continue; }
}
```

*The free-text RESOLVER runs first, and reading the export alone gets that
backwards.* Thirty lines above, a code-less line is resolved by NAME against the
**live** `scm.mfg_products` pick list, and the owner's rule only ever sees what
that could not answer. So "code-less AND zero-priced" — which is what a reader
of `ac-outstanding-so.json.gz` can compute — is the **candidate** set, not the
dropped set. Over the whole file (14,041 lines / 2,789 documents) that candidate
set is 22 code-less lines, 5 priced and 17 unpriced. Asked against the live pick
list, probe run `34214774396`:

```
of the 17 zero-priced code-less line(s), the resolver answers 2 TODAY
  SO-000015 dtl 123388 "AKEMI BASTION MATTRESS (153x190x25CM)" -> AKEMI BASTION MATT (SP)
  SO-000015 dtl 123389 "NK-JAGER B/FRAME(Q) (152x190CM)"       -> JAGER-(Q)
```

**Both are already in the ERP, and writing them again would have duplicated
goods on a live order.** `HC-SO-000015` holds three rows —
`AKEMI FORTRESS MATT (K)` RM 9,099.00, `AKEMI BASTION MATT (SP)` RM 0.00,
`JAGER-(Q)` RM 0.00 — header RM 9,099.00, lines summing RM 9,099.00, equal to
the book to the sen (probe runs `34211433089` and `34214774396`). Its
`mfg_so_audit_log` has **zero rows**, so nobody edited it: the importer wrote
those three lines itself, by name.

So the real dropped population is **15**, and it is three different things:

| class | n | who owns it |
| --- | --- | --- |
| the book states NOTHING — no code, no description, no Desc2, no money, quantity 0 | 12 | nobody. `lib/ac-blank-book-row.mjs` already rules the ERP holding no row for one as the two sides AGREEING |
| a build INSTRUCTION on a line of its own | 2 | the FIELD it belongs on. `SO-000102` dtl 15968 `COLOUR : 885-4`, `SO-000814` dtl 58981 Desc2 `LEG: FOLLOW DISPLAY`. Creating a product line for one invents goods the customer never ordered |
| the book states nothing and ORDERS FOUR | 1 | **the owner.** `SO-011384` dtl 783795, quantity 4, no code, no description, no Desc2, no money. Nothing can be recovered from the book and inventing a product is forbidden — already section F of `docs/cutover-so-do-remainder-2026-09-08.md` |

*Neither instruction reached the ERP by any route* (probe run `34214774396`,
section E, which searches every line's `description2`, `remark`, `variants` and
`custom_specials` and the header's remark fields, punctuation removed from both
sides):

* `HC-SO-000102` — `885-4` is on nothing, **and `scm.fabric_colours` holds 0 rows
  with that colour code**, so there is no colour field it could be written to.
  The order is CONFIRMED, fully paid, and its bedframe was delivered in 2023.
* `HC-SO-000814` — `FOLLOW DISPLAY` is on nothing. The sofa's own build text is
  there (`[ (1 ELT / T + NA +2ER) (28") / COL: J9883-1-1 PAMA]`, on
  `description2` and `remark` of all three compartments); the leg instruction was
  a separate book line and is absent. The order is IN_PRODUCTION with a
  processing date, and the book already shows the sofa transferred to
  `DO-000542`, so it is built.

**The same question for every other document type** (the owner asked
「其他order也是这样？」), over the cut each importer read:

| type | code-less lines | outcome |
| --- | --- | --- |
| sales orders (`ac-outstanding-so`, 14,041 lines) | 22 | 2 resolved as goods, 3 became charges, 1 became a charge by delivery wording, 1 resolved as a mattress, 15 dropped |
| purchase orders (`ac-outstanding-po`, 501 lines) | 1 | `PO-009979` `ERGOTEX PILLOW CASE - FAIR` x20 at RM 50.00. The purchase importer has a DIFFERENT rule — no drop, an exception — because `scm.purchase_order_items.item_code` is NOT NULL. It is that document's ONLY line, so **the whole purchase order is absent from the ERP**: probe run `34211433089` reads `PO-009979 -> (NOT IN THE ERP)`. RM 1,000.00 of goods on order the ERP does not know about |
| delivery orders (`ac-partial-dos`, 369 lines) | 3 | `DO-000097` `COLOUR : 885-4` (the same instruction as its sales order), and `DO-001604`'s empty row plus its `* DISPOSE …` at RM 150.00, which `topup-ac-lines-from-truth` wrote on 2026-09-08 (run `34204421089`) |

**Fix.** The silence — which is what made a number the only thing anyone could
answer, and what let a reconstruction of that number look like a list of missing
goods. `backend/scripts/probe-dropped-book-lines.mjs` +
`.github/workflows/probe-dropped-book-lines.yml`, read-only (no APPLY flag, every
statement a SELECT): it asks the live pick list through the importer's own
resolver BEFORE it calls anything dropped, classifies what is left, prints what
the ERP holds per affected document, says whether each instruction reached the
ERP by another route, reads the provenance, and re-measures the movement control.

The resolver moved to `backend/scripts/lib/ac-name-resolver.mjs` **unchanged** to
make that possible: nothing could ask it WHY it answered as it did without a
second copy of the matcher, which is this repo's most expensive recurring bug.
`buildNameResolver` is `buildTracedNameResolver` with the verdict's `.code` taken
off it, pinned by `backend/tests/acNameResolver.test.mjs` (8 tests) so a trace can
never report a branch the import does not take.

**What was deliberately NOT changed.** The owner's zero-price rule. The matcher —
against the live pick list it answers both of the lines this bug was opened
about, so there is nothing to loosen, and its only caller is a cutover import
that has already run. And **no line was written to any document**: the goods this
bug was opened about are already on `HC-SO-000015`.

**What is still open, and whose it is.** `SO-011384`'s quantity-4 unnamed row and
`PO-009979`'s absent purchase order are the OWNER's — one needs the original
order slip, the other needs a product minted before a NOT NULL column will accept
the line. `885-4` needs a fabric-library row before it can be recorded anywhere.

**Ref.** `fix/dropped-book-lines`, PR #3239 (probe) and the follow-up, 2026-09-08.
