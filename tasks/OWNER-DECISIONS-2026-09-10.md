# Owner decisions, 2026-09-10 — written down the moment he gave them

He has had to repeat himself before because an answer stayed in chat. These are
his, verbatim where it matters, with what each one COMMITS us to. Anything not
on this list is still open and must not be assumed.

## 1. Sofa purchase-order line order — DO ALL 142 historical POs

**Answer: 全部 142 张都排.**

He first wrote 「要 我说的是进来的单要没进来的单不需要」, which was ambiguous
enough to change which documents get written, so it was put back to him as a
picker and he chose **all 142**. Do not re-interpret the earlier sentence.

This overrides, for this one job, his standing 「只针对新的order生效 旧的就不理了」 —
and it is a different act: copying the SALES ORDER's existing line order onto the
purchase order, not re-deriving an order from a drawing. PR #3512.

## 2. Backfill of the book's spec text into `variants.extraAddonNote` — INCLUDE the delivered lines

**Answer: 要** — the 21 DELIVERED lines of the 417 get backfilled too.

Money, quantity and status are untouched; only the note is written. PR #3526.

## 3. `TBC` / `random` lines are a SKU signal, not text to copy

**Answer, verbatim: 「random和TBC会选random 的square pillow啊 squarepillow random colour」.**

So a line whose book text says *random* or *TBC* is telling us the SKU should be
the RANDOM one (`SQUARE PILLOW RDM`), **not** that we should print
`SPECIAL: TBC` on a supplier's purchase order. Two consequences, and they are
different jobs:

- the ~140 TBC/random lines are **excluded from the text backfill**;
- they are **input to the scrap-pillow SKU audit** — his rule is 有颜色 → CUSTOM,
  没颜色 → RANDOM, and the colour is only required once the order is PROCEEDED
  (see [[blank-ok-until-proceeded]]).

He also confirmed the sample text is right: `SPECIAL: SUPER KING (200x200CM)`,
`SPECIAL: COL: J9883-1-1 pama`, `SPECIAL: 210cm X 210cm` — 「这些是对的」.

## 4. Sofa + bedframe — copy ONLY what the purchase order does not already say

**Answer: 照建议做（1,332 条）.**

Skip the 938 lines that are only 颜色未定 (KIV/TBC) and the 192 that are only a
piece build. Copying whole would push 1,723 lines past AutoCount's 100-character
limit — 666 of them carrying nothing new — and over that limit the book loses the
whole special order in exchange for repetition.

## 5. `9058-Console` vs `9058-CONSOLE` — MERGE, keep `9058-Console`

**Answer: 合并,保留 9058-Console.**

The survivor is the one with 3 supplier bindings and HOOKKA INDUSTRIES as main;
`9058-CONSOLE` (1 binding, HOOKKA MANUFACTURING) is the one that goes. Documents
already raised move with it — produce the impact list (documents, stock, money)
BEFORE writing anything, and re-read it on a fresh connection after.

## 6. Amendment-added lines that get no purchase order and no warning — FIX IT

**Answer: 要,查到底并修掉.**

`so-revision.ts:1314` / `:1321` — both warnings are gated on `scopeCoversAll`,
false whenever the sales order has 2+ live bound POs. Measure that population on
production first; it is the shape he has named repeatedly: 「如果等到要送货的时候，
我们才发现没有 order，那就严重了」.

## 7. The extra MRP categories go into ONE "Others" tab

**Answer, verbatim: 「应该要放others 一个category把」.**

PR #3522 made the MRP tab list dynamic from `MrpResponse.categories`, which fixed
the disappearance (DINING / BEDLINES / DIFFUSER / CARPET rows belonged to no tab)
but gives each category its own tab. He wants the four core tabs — Sofa,
Bedframe, Mattress, Accessories — plus **one Others tab that catches everything
else**.

That is also the more durable shape: a category he creates at runtime
(`scm.acc_register_item_group()` is granted to `service_role` precisely so he
can) lands in Others automatically instead of growing a tab nobody expected.
SERVICE stays out of the page entirely — 「Service 我们都不会进 MRP 里面去计算的」.

---

## Still open — do NOT assume an answer

- Where the HISTORICAL pillow colours are, if anywhere. The AutoCount export he
  sent (`houzs-century-ALL-SO-detail-2026-09-10.xlsx`) has **no** accessory
  `Detail Description 2` and **no** Processing Date on any row, so it cannot
  supply them. A scrap pillow is made from the sofa's offcuts, so the sofa's
  fabric on the same order is a CANDIDATE — deriving it would be computing rather
  than copying, and he has not been asked yet.
- `HC-SO-011160` looks truncated: the book snapshot says
  `colour : B0315-9, 7, 8,12`, the ERP holds `colour : B0315-9`. Needs a person.
- Why MRP shows `— none —` on a line whose product IS bound. Four causes ruled
  out with run ids in `docs/bugs/0780-mrp-shows-no-supplier-...`; still unknown.
