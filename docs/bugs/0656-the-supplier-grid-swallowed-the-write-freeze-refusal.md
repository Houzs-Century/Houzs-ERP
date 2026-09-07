## The supplier grid swallowed the write-freeze refusal [high]

**Symptom.** The owner, 2026-09-07: 「我点了main 为什么没反应」. On
`/scm/suppliers/<id>` he clicked the ★ in the **Main** column of the SKU-mapping
grid and nothing happened at all — no change, no message, no console line.

**Root cause (traced, and the button was never broken).** The write is being
REFUSED, correctly. The go-live write freeze is on and
`scm.procurement.suppliers` is one of the 23 paused areas — read live from
production, not assumed:

```
scm.write_freeze = "1 - scm.procurement.products"   (updated 2026-09-02T03:52:25Z)
areas still PAUSED (23): ... scm.procurement.suppliers ...
```

`scm/index.ts:127` mounts `scmWriteFreeze()` ahead of every sub-router, so
`PATCH /api/scm/suppliers/:id/bindings/:bindingId` answers **503** with the
freeze's own staff message — *"Editing is paused while the AutoCount data
migration is completed…"*.

That sentence never reached the screen. `useUpdateBinding`
(`vendor/scm/lib/suppliers-queries.ts:503`) declares no `onError`, and the
global `MutationCache` (`lib/queryClient.ts:59`) carries only `onSuccess`, so a
rejected mutation reaches nobody. Five cells on this page call it
fire-and-forget with no per-call options: the ★ Main star, the supplier-SKU
input, the unit price, and the two price-matrix cells. Its neighbours
`useDeleteBinding` (:527) and `useSetCostAnchor` (:550) both carry
`onError: writeFailed`, so the ⚓ button one column to the LEFT reports the
refusal and the ★ beside it says nothing.

**This page had already paid for it once.** `SupplierDetail.tsx` carries a
comment at the Supplier-Info Save button — *"Never fail silently (Commander
2026-06-16 — 「Save 没有反应」)"*. That one call site was fixed; the grid cells
were left alone.

**Why the checker said the file was clean.** `check-silent-mutations.mjs`
reports `0 SILENT` over 358 call sites, and classifies this one **CAUGHT**. Its
second pass is per-consumer-FILE, not per-call-site (`:204-206`,
`consumerHandles` `:148-172`): `SupplierDetail.tsx` does `await
update.mutateAsync(...)` in `AutoSuffixButton` and `ImportBindingsDialog`, and
those two await-sites mark the whole file safe. The sweep that fixed this exact
shape elsewhere (`3a759fe6a`, "THE REAL ONE") caught `Categories.tsx` only
because its two consumers sat in DIFFERENT files.

**Fix.** `onError: writeFailed` per call at all five grid cells — per call, not
on the hook, because two other consumers in the same file already pass their own
`onError` and a hook-level handler would fire alongside them and double-report.
The shared checker is left alone; its file-level blind spot is real but
narrowing it is a separate change that will light up other call sites and must
not ride along on a cutover-day fix.

**Not fixed here, and deliberately:** the star still will not save until the
freeze lifts. That is the freeze working as designed. What changes is that the
owner now reads why.

**Ref.** fix/supplier-grid-silent-writes, 2026-09-07.
