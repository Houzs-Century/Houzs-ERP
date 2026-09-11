## One option field, two vocabularies: the fabric pool held series while the gate read colours, and both pickers dropped a curly-quoted inch [high]

**Symptom.** Owner 2026-09-11: 「为什么我的SO fabric 突然search不到一些fabric了」,
then, with a phone screenshot of *Edit Sales Order*:

> `2 lines could not be saved — Fabric GD2502-11 isn't offered on this model.
> Pick one of 311, A201, AH, ALPINE-5311, … or GD2034 (HIVE) (and 80 more)..`

and 「我可以用 有些人不行…可是我的权限明明全部sofa bedframe都开完了啊」, then
「不止 fabric，divan gap 等等也是」.

It is not permissions — no rule in this system varies the option pools by user.
It is TWO faults in the same field, `product_models.allowed_options`.

### Fault 1 — the fabric pool holds a SERIES, both readers compared a COLOUR

`ProductModelDetail.tsx` hands the Modular drawer
`fabricLibQ.data.filter(active).map((f) => f.id)` — `fabric_library.id`, a fabric
SERIES. The server gate (`allowed-options-check.ts`) and the desktop picker
(`SoLineCard.tsx` `FabricColourCombobox`) both compared the line's
`fabricCode` / `colourId` — a `fabric_colours.colour_id`. The gate's own comment
asserted the pool "holds fabric_colours.colour_id values", and the code matched
the comment; the SCREEN THAT FILLS IT never did.

**MEASURED on production, company 1, 2026-09-11:** all **79** sofa Models carry
the SAME 101-entry pool. Of those 101 entries **91 are `fabric_library` ids**,
**3 are colour ids**, **10 are library LABELS** (`"GD2034 (HIVE)"`). **851**
fabric colours are active. So of 851 colours exactly **THREE** were pickable, and
`GD2502-11` (`GD2502#11 WHEAT`, active) was refused by every Model.

**Why it looked person-dependent — it is SURFACE-dependent:**

| | what happens |
|---|---|
| Houzs bedframes | all 113 Models unrestricted — unaffected, works normally |
| Houzs sofas, DESKTOP | picker filters the server results, so 3 of 851 colours appear — "search 不到" |
| Houzs sofas, MOBILE | `MobileNewSO.tsx:3298` does NOT filter by the pool at all, so every colour is offered and the SAVE is refused — the screenshot |
| any surface, saved line | the stored fabric always renders (the picker never blanks a selection), so an old order looks fine |

### Fault 2 — both pool filters compared the inch mark RAW

A maintenance pool is typed by a person, and Windows turns `"` into U+201C /
U+201D; the editors emit U+0022 (`${d + l + g}"`). The SERVER gate has folded
those since 2026-08-17 (`inPool`). **Neither picker did.** MEASURED the same day,
company 1: `gaps` holds **10 curly-spelled values** (`11” 12“ 13” 14“ 15” 16“ 17”
18“ 19” 20“`) and `total_heights` **6** (`17“ 19“ 21” 23“ 25” 27“`), across **10
bedframe Models** — so Gap 11 through 20 inch were invisible on both surfaces
while the server would have accepted every one. `divan_heights`, `leg_heights`,
`compartments` and `sizes` carry no curly values and were never affected.

This was KNOWN and left. `SoLineCard.tsx` carried: *"these two filters
deliberately still do not [fold], because widening them CHANGES WHICH OPTIONS
APPEAR — an owner's call, not a bug fix."* The call was never put to the owner;
he raised it himself as 「不止 fabric，divan gap 等等也是」.

**Fix.**

- `allowed-options-check.ts` accepts a colour whose SERIES is in the pool
  (`variants.fabricId`, which `pickFabricColour` has written on every pick and
  **3,732 live sales-order lines already carry**). A pool entry that is a colour
  still means that one shade, so a per-shade allow keeps working. 7 cases pinned.
- `SoLineCard.tsx`'s `FabricColourCombobox` applies the same rule, so the desktop
  picker shows every colour of a ticked series. Mobile needs no picker change —
  it never filtered.
- `maintenance-pools.ts`'s `restrictPricedToPool` / `restrictStringsToPool` now
  fold typographic quotes. 12 cases pinned, including one that records the OLD
  behaviour (3 of 5 real options vanished).
- `SoLineCard.tsx` had inlined its own copy of those two filters, which is why
  the folding landed on mobile and not the desktop — the file now calls the
  shared ones, as `maintenance-pools.ts` has demanded in writing since it was
  written ("no editor may inline its own copy again").
- `backend/scripts/repair-fabric-pool-labels.mjs` rewrites the 10 LABEL entries
  to their codes (a rename — each maps to exactly one library row; an ambiguous
  label is refused and listed). Plan reported 79 models, 10 distinct rewrites.
- `backend/scripts/check-allowed-options-vocabulary.mjs` resolves EVERY pool
  value against the table its gate reads and reports what matches nothing, so
  the next pool filled from the wrong list says so instead of a salesperson
  finding out at the till. It answers the owner's question
  (「fix 掉了就不会有相同的问题了是吧」) with a check instead of a promise.

**What the sweep RULED OUT.** The same measurement over all eight pool keys:
`compartments` (33 values), `divan_heights`, `leg_heights`, `sizes` resolve
cleanly. An earlier probe reported `compartments` as "0 matches" and it was the
PROBE reading `variants.compartment`, which sofa lines do not use — the
compartment is the item-code suffix (`8030-1A(LHF)`), and the pool's
`1S / 2S / 1A(LHF)…` match it exactly. Nearly reported as a second defect.

**Ref.** `fix/fabric-pool-series-vocabulary`, 2026-09-11.
