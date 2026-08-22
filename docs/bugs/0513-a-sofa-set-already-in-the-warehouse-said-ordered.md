## A sofa set already in the warehouse said "ordered" on the MRP board [high]

<!-- area: Sofa, fabric, variants -->

**白话.** MRP 那张板上，**货已经收进仓库的沙发套装，还是写着 `ordered`**。原因是
前端自己组沙发套装那一行的时候，规则**少写了一岔**：后端是三岔（短缺 / 有采购单 /
库存），前端只写两岔（短缺 / 采购单）。所以「不短缺、也没有采购单」——也就是**货在
仓库**——被判成「采购单」，然后因为没有单号可以印，画面就退而印 `ordered` 这个字。

`ordered` 从来就不是系统算得出来的状态。它是「我被告知这是采购单，可是找不到采购
单」的时候印的字。**一个只有在资料自相矛盾时才会出现的标签，等于画面每次 render 都
在替自己写一份 bug 报告。**

**Symptom.** Owner, 2026-08-21: 「然后我不是收货了吗？为什么是show PO
outstanding？还显示ordered？那么奇怪的」. Two separate defects wore that one
sentence; this is the half that put the word on the screen.

**Root cause (traced).** The rule had THREE hand-written copies:

| where | rule |
|---|---|
| `routes/mrp.ts:1114` general lines | `need > 0 ? 'shortage' : poNumber != null ? 'po' : 'stock'` |
| `routes/mrp.ts:1364` coverage map | `shortageQty > 0 ? (poNumber ? 'po' : 'shortage') : poNumber ? 'po' : 'stock'` |
| `Mrp.tsx:307` sofa SET rows | `shortageQty > 0 ? 'shortage' : 'po'` ← **two arms** |

The frontend synthesises the sofa-SET rows itself, because the backend returns
sets in a different shape from general lines. In writing that third copy the
`stock` arm was dropped, so a set with no shortage and no covering PO came back
`po`, and the chip at `Mrp.tsx:1465` / `:1551` fell through to `'ordered'`.

The two BACKEND copies also disagreed with each other — on a set that is short
AND has a covering PO, the general rule says `shortage` and the coverage map
says `po` — with nothing anywhere saying that was deliberate. It is: the
coverage map answers the PURCHASE side's question (*"a PO's supply is currently
covering this outstanding Sales-Order line. Advisory only."*), where a
partly-covering PO is the thing being reported.

**Fix.** One shared module, `backend/src/scm/shared/mrp-alloc-source.ts`,
mirrored byte-identically to `frontend/src/vendor/shared/mrp-alloc-source.ts`
(`check-shared-mirrors --strict`), carrying BOTH rules with the difference
written down:

- `allocSourceOf` — *is this demand covered, and by what?* A shortage wins.
- `allocSourceCoveringPo` — *is a purchase order involved?* A named PO wins.

Both test the NUMBER, not "was a PO involved": a PO that cannot name itself is
missing data, not an order — which is exactly what left the chip with nothing to
print. All three sites now call one of the two.

The `'ordered'` fallback is DELETED from both the desktop table and the mobile
card. `source === 'po'` now guarantees a number, so the branch was unreachable;
leaving it would leave the lie one drift away from returning.

**Guard.** `backend/src/scm/shared/mrp-alloc-source.test.ts` — 13 cases,
including the regression itself (no shortage, no PO → `stock`), the
whitespace/empty/null PO number, a negative shortage, and the one input where
the two rules deliberately disagree. Proved RED by restoring the two-arm rule:
7 failed, the first being *"no shortage and no PO is STOCK, not po"*.

**Ref.** The other half of the owner's sentence — the goods receipt whose lines
never told the purchase order they had arrived — is
`grn_items.purchase_order_item_id`, traced separately and measured by
`probe-convert-link-gaps` (#2642).
