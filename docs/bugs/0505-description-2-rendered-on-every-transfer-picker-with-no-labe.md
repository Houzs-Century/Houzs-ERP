## Description 2 rendered on every transfer picker with no label, so nobody could find it [low]

<!-- area: Frontend + mobile -->

**白话.** 老板在 PO → GRN 的转单挑选画面问「看不到 description 2 的?」。其实有
显示 —— 每一行下面那行灰字 `PC151-12 / SEAT 28 / LEG DEFAULT` 就是 —— 但它旁边
每一个栏位都有小标题，只有它没有，所以看起来像装饰，不像一个栏位。这次只是补上
标题，用的字跟系统其他地方一模一样：**Description 2**。资料、读取、后端一律没动。

**Symptom.** Owner, 2026-08-21, looking at `GrnFromPo`: 「看不到 description 2
的?」.

**Root cause (traced).** Presentation, not data. `VariantDescription.tsx` (the
shared component the ten desktop transfer pickers render this column through)
emitted the summary as a bare muted `<div>` with no label, while the fields
around it each carry a small uppercase one. Coverage was verified and is NOT the
problem: `buildVariantSummary` / `VariantDescription` render on ~60 frontend
surfaces and all eight backend picker reads still select `variants`. The mobile
convert wizard had the identical bare-line shape
(`MobileConvertWizard.tsx`, two sites).

**Fix.** The label lives on the SHARED component, so all ten desktop pickers
gained it at once and an eleventh cannot forget it:
`VariantDescription.tsx` exports `DESCRIPTION_2_LABEL = 'Description 2'` and
renders it as a small uppercase prefix, with the summary kept in its OWN element
so it stays one findable string. The word is not invented here — it is what the
desktop SO line editor's column header, `pages/scm-v2/so-audit-labels.ts`, the
mobile amendment label map and six list columns already say. `MobileConvertWizard`
imports the same constant and spells it the phone's way (`Description 2: value`,
matching the `Supplier SKU:` line two rows below) — one WORD, two presentations.

`frontend/src/vendor/scm/components/VariantDescription.test.tsx` pins the word
against `so-audit-labels.ts`, that the label and the summary are both present
and separately findable, and that all ten pickers still render through the
shared component. Proved RED on the unfixed tree by deleting the label span —
three assertions failed.

**Ref.** fix/warehouse-label-and-desc2, 2026-08-21.
