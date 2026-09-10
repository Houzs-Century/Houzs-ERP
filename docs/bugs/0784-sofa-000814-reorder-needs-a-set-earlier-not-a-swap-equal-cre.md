## sofa-000814 reorder needs a set-earlier, not a swap (equal created_at) [low]

**Symptom.** `repair-so-000814-sofa-order.mjs` (as first written) would not have
reordered the sofa even after its item-code match was fixed. Its dry-run showed
the two target compartments share a `created_at` to the microsecond:

```
5526-2A(RHF)  created_at=Sat Sep 05 2026 05:12:30
5526-1NA      created_at=Sat Sep 05 2026 05:12:30
```

**Root cause (traced).** Both rows were inserted by the same ERP edit, so they
carry an identical `created_at`. The canonical AC line order is `(created_at,
id)` (`ac-line-order.ts`); with `created_at` equal, `id` breaks the tie and
`2A(RHF)` (id `a940…`) sorts before `1NA` (id `d910…`). SWAPPING the two
`created_at` values leaves them equal, so the `id` tiebreaker still puts
`2A(RHF)` first — the swap is a no-op.

**Fix.** Set `1NA`.created_at to `2A(RHF)`.created_at **minus one second**, so
it sorts strictly first. Still lands after `L(LHF)` (a different, older day),
so only the two targeted compartments move relative to each other. Idempotent:
if `1NA` already sorts earlier, the script exits without writing. Verified by
the dry-run printing the timestamps before any apply.

**Ref.** `fix/sofa-000814-set-order-not-swap`, 2026-09-10.
