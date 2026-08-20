## An approved amendment could carry any price except RM 0 [medium]

<!-- area: Sales orders + pricing -->

**白话.** 单子一旦已经下给供应商，改价就要走「修改申请」，主管批准后才生效。批准
RM 50、RM 125 都没问题，唯独批准 **RM 0** 不行 —— 系统把 0 当成「没填价钱」，
于是又把目录价填回去，而且不报错。8 月 16 号写这段的时候这是对的，因为那时候
任何地方都不能开 RM 0；8 月 18 号 #2425 让**没锁的**单子可以开 RM 0，两条路就
对不上了。现在改成一致。顺便修好另一个同类问题：赠品那种价钱是 0 的行，只改数量
也会被填回目录价，等于把送的东西拿去收钱。

**Symptom.** On a supplier-ordered (locked) SO, a salesperson edits a line to
RM 0 and an approver holding `scm.amendment.approve_*` signs it. The line comes
back at the catalogue price. Nothing 400s, nothing is logged, and the approver's
diff showed RM 0 — so the order reads as approved-at-zero while billing the
customer the full amount.

Second, same root: approving a **quantity-only** amendment on a line already at
0 — a free gift, a PWP reward — also filled in the catalogue price, billing the
customer for the giveaway.

**Root cause (traced).** `applySoAmendment` passed
`trustOperatorSelling: (approval !== null)` — plain `true` — for native orders
(`so-revision.ts:397`). The recompute's trust condition is
`manualUnitSelling > 0 || trust === 'including-zero' || trust === 'operator-zero'`
(`mfg-pricing-recompute.ts`), so a requested 0 matches none of the three arms and
`unitToPersistSen` keeps the catalogue figure. Zero is the single value plain
`true` cannot carry, by design: there it means "no price was entered".

That was correct on 2026-08-16, and the comment above the line said so — an
approved amendment grants "exactly the authority the operator would have had on
the SAME order before it locked", and on that date nobody could author RM 0 on
any road. **#2425 (2026-08-18) moved the unlocked road**, adding `'operator-zero'`
so the ERP line editor could state that the operator typed the zero. The
amendment path was not updated with it, so the invariant this code states about
itself was broken by the newer change, not by this code. The quantity case
followed for free, because the editor sends `newUnitPriceSen` on every changed
line rather than only when the price moved (already pinned for RM 80 by the
QTY-only test; 0 was the value that test did not reach).

**Fix.** `amendTrust` becomes `'operator-zero'` on a native order with an
approval — the sanctioned mode for an authored zero — and stays `'including-zero'`
for migrated orders and `false` with no approval. The ceiling is unchanged in
kind: `clientUnit` still refuses to read a requested price without an approval,
so an unapproved apply cannot author a 0 any more than it could author RM 50.
Five cases added to `so-revision.amendmentPrice.test.ts`; two of them fail on the
unfixed source, the other three are guards that pass either way (no price
requested → catalogue; no approval → catalogue; ADD at 0 → catalogue).

**Deliberately NOT fixed: ADD lines.** `addLineTrust` stays plain `true`, so a
line added at 0 still takes the catalogue price. An ADD names a SKU and nothing
else about it is established, so a 0 there is likelier an unfilled field than an
intended giveaway, and the existing migrated-order test pins that behaviour in as
many words. Editing an existing line is the opposite case. Add and Edit therefore
disagree about 0 on purpose; a gift that belongs on a locked order goes through
the free-item path. Revisit only with the owner, and move that test in the same
breath.

**Ref.** fix/amendment-operator-zero, 2026-08-19. Continues #2425 and the
2026-08-16 approved-price fix.
