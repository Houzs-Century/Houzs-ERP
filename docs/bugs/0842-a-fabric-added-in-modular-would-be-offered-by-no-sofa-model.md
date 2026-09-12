## A fabric added in Modular would be offered by no sofa model until 79 of them were edited [medium]

<!-- area: Sofa, fabric, variants -->

**Symptom.** Owner, 2026-09-12, on the Modular maintenance screen:

> 限不限制是我在 Modular 那边自己选，不用去理 … 我的维护，无论是打什么东西、
> 标点符号、妖魔鬼怪，全部都是可以跳出来给我去做选择的

He is describing the rule he wants, not a screen that is broken today — and the
difference matters, so it is stated plainly below.

**Root cause (traced).** `product_models.allowed_options.fabrics` is an
allow-list, and a non-empty one means "restrict to exactly these"
(`hasRestriction` = `Array.isArray(pool) && pool.length > 0`, read by both the
server gate `backend/src/scm/lib/allowed-options-check.ts` and the desktop
picker `SoLineCard.tsx`). Every sofa Model carries one — and all 79 carry the
**same** list, which is what identifies it as a snapshot taken once rather than
79 decisions.

**Measured on the staging copy of production, 2026-09-12T11:19Z** (79 sofa
Models, 820 active colours, 182 fabric series of which 100 carry colours):

| | |
|---|---|
| distinct sofa pools | **1** — one 101-entry list, on all 79 Models |
| entries that resolve | **101 of 101** (0 dead, after `docs/bugs/0814-*.md` rewrote the ten labels) |
| colours each Model can offer | **820 of 820** |
| bedframe Models restricted | **0** — they already carry no pool |

**So nothing an operator can see is wrong today, and this entry says so rather
than selling a fix.** The defect is in what happens NEXT: while a pool is
present, a fabric series created in Modular is offered by **no** sofa Model
until somebody edits 79 of them — the pool lists the series that existed the day
it was taken. That is exactly the shape the owner is guarding against, and the
bedframes already behave the way he wants.

This also corrects a number this session put in front of him earlier the same
day: "79 sofa models can only pick 3 of 851 colours". That was TRUE on
2026-09-11 and was fixed that day by `0814` (the pool holds fabric SERIES; the
gate compared a COLOUR). Re-measuring after the fix is what produced the table
above — 820 of 820. Reading a stale ledger entry as the current state is the
trap; the census is the answer.

**Fix.** `backend/scripts/open-model-fabric-pools.mjs` +
`.github/workflows/open-model-fabric-pools.yml` (staging / prod, plan by
default, `CONFIRM="OPEN-FABRIC-POOLS"` to apply) drop the `fabrics` key from
every SOFA Model's `allowed_options`, in every company. Empty behaves
identically to absent for both readers, so the key is removed outright rather
than left as `[]` for a later reader to wonder about. A Model whose pool is
already absent is skipped.

The plan output prints, per company, the pool size and **colours offered before
-> after**, and says in one line whether the change widens anything today —
because "this changes nothing you can see" is the honest headline here and it
should come from the script, not from a PR body.

Restriction remains available and is now only ever HIS: tick fabrics on a Model
in the Modular drawer and that Model restricts to them.

**Ref.** fix/model-fabric-pool-open-by-default, 2026-09-12.
