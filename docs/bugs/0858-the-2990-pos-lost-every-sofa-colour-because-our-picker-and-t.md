## The 2990 POS lost every sofa colour because our picker and theirs read the same field oppositely [high]

**Symptom.** 2990 sales staff, 2026-09-13, in the group:
「老板请问 System 再更新着吗？Coner 款选不到颜色」 and 「其他款式也选不了颜色」.

On the POS, a sofa shows no fabric SERIES chips and no colours at all — there is
nothing to pick, so the line cannot be configured and the sale cannot be taken.

**This is ours.** `open-model-fabric-pools.mjs` (PR #3743) cleared
`allowed_options.fabrics` on every SOFA Model, scope "every company, SOFA Models
only".

**Root cause (traced to both lines).** Two clients read the same column and
disagree about what an EMPTY pool means.

*Ours — a filter.* `SoLineCard`:

```ts
const restricted = Array.isArray(pool) && pool.length > 0;
...filter((c) => !restricted || allow.has(c.colourId) || allow.has(c.fabricId))
```

Empty ⇒ not restricted ⇒ every active colour. Clearing WIDENS, which is what was
measured on production when it shipped (820 → 851 colours on Houzs).

*Theirs — the source.* The 2990 POS is a different app in a different repository
(`wenwei4046/2990s`, `pos.2990shome.com`) reading this same field through
`GET /pos-pools/mfg-catalog`, which selects
`product_models(..., allowed_options)` (`routes/pos-pools.ts:64`).
`apps/pos/src/pages/Configurator.tsx`:

```ts
fabricIds: (allowed as { fabrics?: string[] }).fabrics ?? []      // absent -> []
buildFabricSeriesRows(codes) {
  const enabled = new Set(codes);
  const seriesWithColour = new Set(
    fabricColours.filter((c) => enabled.has(c.colourId)).map((c) => c.fabricId));
  return fabricLib.filter((f) => seriesWithColour.has(f.id));
}
// its own comment: "Empty -> 'No fabrics enabled'."
```

Two things make it total rather than partial: `?? []` turns an ABSENT key into an
empty array rather than `null` (which the picker would have read as "no filter"),
and the SERIES CHIPS are BUILT from the pool rather than filtered by it. So an
empty pool removes the whole control, not just some swatches.

**The mistake, and it is the second instance of it in one day.** The clear was
verified against the consumer that could be seen from this repository, and
shipped to a consumer that could not. `pos-pools.ts` carries a banner saying
exactly this — *"EXTERNAL CLIENT — no screen in THIS repo calls this route. That
is expected, not evidence it is dead… Before removing it again, grep the POS
repo."* The route was already deleted once as dead code (#2422) and restored
(#2459) after the POS 404'd in production. The warning was there and was not
read; the same field's second reader was never looked for.

The sibling failure is `docs/bugs/0855` / `docs/option-pool-clear-coe.md`, where
the same premise — "a pool is a restriction" — was wrong for MATTRESS and
BEDFRAME sizes in THIS repo.

**Fix.** `refill-pos-sofa-fabric-pools.mjs` + workflow fills every SOFA Model of
the POS company with every ACTIVE colour of that company — the state the clear's
own plan promised ("-> every active colour") and the state our SO picker already
behaves as. Plan by default, `CONFIRM="REFILL-POS-FABRICS"`, backup first,
verified on a fresh connection by SHAPE, refuses to write an empty pool if the
company has no active colours (that would reproduce the defect).

**WHAT CANNOT BE RECOVERED, said plainly.** The per-Model narrowing that existed
before the clear is GONE. That script took **no backup** and its plan printed
only aggregates — model counts, pool sizes, colours offered — never the per-Model
contents, so there is nowhere to read the previous state from. Any Model that was
deliberately narrowed to a subset of colours must be re-ticked by hand in the
Modular drawer. Every Model now offers every active colour, which is more than
before and never less, so nothing is unsellable — but a deliberate restriction
is lost.

**Houzs is deliberately NOT refilled.** Its picker reads an empty pool as
unrestricted, so it is not broken, and writing an explicit pool there would
create a list somebody then has to maintain.

**The durable lesson.** `allowed_options` is read by at least three clients with
three different readings — our line editor (filter), our save gate (filter), and
the 2990 POS (source). Before changing that column again, enumerate its readers
INCLUDING the ones outside this repository. `pos-pools.ts`'s own header lists the
POS call sites for exactly this purpose.

**Ref.** fix/one-status-map, 2026-09-13.
