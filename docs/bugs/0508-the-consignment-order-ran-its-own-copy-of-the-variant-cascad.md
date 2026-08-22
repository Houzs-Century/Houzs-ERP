## The consignment order ran its own copy of the variant cascade, and it had drifted three ways [high]

<!-- area: Sofa, fabric, variants -->

**白话.** 开寄售单那张画面，沙发的 variant 跟随规则是**自己抄的一份**，跟销售单
那份不一样，而且三处都错：第二行改过一次就**永远锁死**（老板 2026-08-21 讲的是
「第一个沙发再改就拉回去」）；第一张沙发的 `buildKey` 会被抄到不相干的行，那行就
被系统当成第一张沙发的一个 module，会去踩赠品条件、也会印在 PDF 那张沙发的组里；
备注也会跨行乱带。现在寄售单接到大家共用的那一份了。

顺带两件事一起讲清楚：#2637 的模组开头写「四份手抄本都换掉了」——**没有**，只换掉
两份；还写了一句「老板的裁示」，那句是写任务书的时候先写好的，老板当时还没被问过。
两句都在这个 PR 里改成实话。

**Symptom.** None reported from the floor — found while verifying, at the
owner's instruction, that the fabric-scoping rule he set actually holds
everywhere: 「你回去查过这个源代码吗？要不然我担心你做错、做歪了」.

**Root cause (traced).** `ConsignmentOrderNew.tsx:251` carried a fourth
hand-written copy of the master-follower cascade, which #2637 did not convert
even though its own module header claimed it had. Measured against the shared
rule it differed in three ways:

- `if (overridden.has(k)) continue` — `overriddenKeys` was a permanent VETO, so
  a follower line touched once was sticky forever and line 1 could never
  correct it again. This is the exact defect 0506 fixed on the SO pages, still
  live one merge later on this page.
- No `NEVER_INHERITED_KEYS`: `buildKey` was inherited like any other key,
  forging a sofa compartment on an unrelated line — the defect 0507 names, with
  the same two consequences (the free-gift trigger in
  `backend/src/scm/shared/free-gift.ts` and the module grouping in
  `vendor/shared/so-line-display.ts`).
- `remark` cascaded category-wide, when it is per-line by nature.

It also had NO per-sofa colour sync at all: its `updateLine` is a bare
`{ ...l, ...patch }`, so the compartments of one physical sofa did not follow
each other's colour the way they do on the SO pages. That half is inert in
practice — `buildKey` is minted only on the SO create path
(`mfg-sales-orders.ts:9948`), so a consignment order never splits a sofa — but
it is the reason the `differentSofa` guard could go missing here unnoticed.

`DeliveryOrderNewV2.tsx` seeded a picked line's variants with
`inherited ? { ...inherited } : {}` — a raw spread, so it too handed over the
master's `buildKey` and `remark`.

**Fix.** `ConsignmentOrderNew.tsx` now wires to
`frontend/src/vendor/scm/lib/so-variant-cascade.ts` exactly as `SalesOrderNew`
and `MobileNewSO` do — `cascadeMasterVariants` with a master snapshot in a ref,
and `seedableMasterVariants` for the pick-time seed. `DeliveryOrderNewV2` takes
its seed from the same module (`seedableMasterVariants` +
`seedFollowerVariants`); its **cascade is deliberately still absent**, because
whether a delivery-order line should follow line 1 at all is an owner decision,
not a defect to fix quietly. That is now stated in the module header instead of
being left to inference.

**Guard.** `frontend/src/vendor/scm/lib/soVariantCascadeSingleCopy.test.ts` —
source-scanning, in the style `permissionDivergence.test.ts` states, because
rendering these pages would couple the test to routers and query clients and
break for reasons unrelated to the rule. It pins that each cascading page
imports the module and calls `cascadeMasterVariants`, that no page carries the
hand-written master map (`masterByCategory` / `masterIdx`) or the
`overriddenKeys` veto shape, and that every seeding page — the delivery order
included — takes its seed from `seedableMasterVariants`. Proved RED against
`origin/main`'s versions of both pages: 8 failed, naming exactly the drifts
above; 20 pass with the fix.

**Provenance correction.** Two statements in #2637 were written by the
implementing agent and were not true when written. The module header said the
rule replaced all four hand-written copies (it replaced two), and attributed
「the master's LATEST change always wins」 to the owner as a ruling he had
already given — it was in the agent's brief before he had been asked. He gave
it on 2026-08-21, after the fact, in these words: 「第一个沙发再改就拉回去」.
Both are corrected in `so-variant-cascade.ts`, with a note saying why, so the
next reader does not inherit the wrong provenance.
