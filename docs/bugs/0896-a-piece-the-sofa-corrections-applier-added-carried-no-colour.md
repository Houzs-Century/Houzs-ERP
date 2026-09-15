## A piece the sofa corrections applier added carried no colour, because its variants came from a row it did not have [high]

<!-- area: Sales orders + pricing -->

**白话.** 修正沙发组件时，工具**新加出来**的那一件（例如 2S 改成 1A(LHF)+1A(RHF)
里的 1A(RHF)）只带了座深，**没有颜色、没有脚**。一张沙发的颜色是整张的，本来就应该
每一件都一样。结果工厂单上那一件没有颜色；库存又是按颜色分格子的，所以同一张沙发的
两件被放进了两个不同的格子。现在新加的那一件会从同一张沙发的其他件抄颜色和脚（只补
空的，两种颜色的沙发不动，specials 不抄，因为 specials 会影响价钱）。

**Symptom.** HC-SO-013346 / HC-PO-010086, 2026-09-14, right after the owner's
`8030-2S` → `1A(LHF)+1A(RHF)` build was applied (apply runs 34844181280 and
34844363367). Read-only trace run 34844739166:

```
SO #1 8030-1A(LHF)  variants {colourId CH141-11, fabricCode CH141-11, legHeight Default, seatHeight 35, ...}
SO #4 8030-1A(RHF)  variants {"seatHeight":"35"}
PO    8030-1A(RHF)  fabric undefined
```

**Root cause (traced).** In `apply-sofa-compartment-corrections.mjs` the plan
built each piece's variants as `{ ...(p.row?.variants ?? {}) }`. For an added
piece `p.row` is undefined, so the only thing written was the seat height the
entry states. The INSERT then cloned every OTHER column from the build's lead
row (warehouse, Desc2, photos, line key) but took `variants` from the plan. The
PO half did the same. Every compartment the main path has ever ADDED went in
this way unless its entry carried a `colour` label. The downstream-document path
was not affected, because it clones `plan.template.variants`.

**Fix.** `backend/scripts/lib/sofa-build-axes.mjs`: `sharedBuildAxes(rows)`
and `fillFromBuild(variants, shared)`. They follow the same rule as
`fill-sofa-sibling-fabric-2026-09-09.mjs`, which the owner already approved:

- blanks only;
- the five fabric fields move together, and only when the build carries exactly
  ONE fabric (a two-tone build is left alone);
- `legHeight` only when the rows agree on one value;
- specials are never copied, because they carry money.

The applier builds every piece's variants through it, for kept and added pieces
alike. A dry-run prints `fill <piece>: <keys> from the build`. A re-run on a
build already written fills the blank pieces it left behind, and the existing
carry puts the SO variants onto the dedicated PO line.

Tests: `scripts/lib/sofa-build-axes.test.mjs` (6 cases) pins the rule.
`tests/sofaCorrectionsBuildAxes.test.mjs` (3 cases) pins the call site; all 3
were RED on the unfixed applier.

**Not in this fix.** An added PURCHASE piece is also inserted with no `line_no`
(shown as `#?`) and no `photo_urls`. The sales-order INSERT sets both. Neither is
changed here.

**Ref.** fix/sofa-added-piece-fabric, 2026-09-14. Sibling of docs/bugs/0894.
