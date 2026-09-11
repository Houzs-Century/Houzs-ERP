## The scanner's TV rule stated the principle and not its consequence, so two readers derived opposite sides [high]
<!-- area: Sofa, fabric, variants -->
<!-- status: fixed -->

**Symptom.** Two of this project's own notes recorded sofa handedness in
OPPOSITE directions and sat contradicting each other for days. `HC-SO-012014`
was read as `2AL+1AR` — a hatched arm at the drawing's LEFT is the LEFT-hand
piece. `HC-SO-010955` read as the exact mirror. Both readings were defended, and
the memory index ended up telling the next session to resolve it by asking the
owner, which is a coin flip wearing a procedure.

Getting it backwards hands **every** piece on an order the wrong way round and
looks completely normal: the multiset of compartments is identical and only the
sides swap, so nothing downstream can catch it.

**Root cause (traced).** `scm.so_scan_rules` row `__GLOBAL_MANUAL__` — the
hand-written layer of the scanner's prompt — carried rule 5 as:

```
5. "TV" MARKS THE VIEWING DIRECTION. Left and right are as seen facing the sofa
   from the TV.
```

That principle is correct and it is not enough. It never says what the two cases
DO, so every reader had to derive the geometry, and the derivation depends on
something neither note recorded: **whether the TV is drawn above or below the
run**. HC-SO-012014 was a TV-BELOW slip and HC-SO-010955 a TV-ABOVE one, so both
readings were right about their own slip and irreconcilable as stated.

**A rule that requires the reader to derive its own consequence will be derived
both ways.** That is the class, and it is not specific to sofas.

**Fix.** Owner, 2026-09-09: 「主要是看TV的 要看TV在上还是下」, confirming the
geometry with 「是的」. Rule 5 now states both cases outright — TV BELOW means the
drawing reads directly (arm on the LEFT edge is `LHF`); TV ABOVE mirrors it — and
tells the scanner to read the TV's position BEFORE any arm and to name the case
in its notes. The "no TV marker, do not pick a side" refusal already in the
prompt is left exactly as it was.

`backend/scripts/update-so-scan-manual-rules-2026-09-09.mjs` +
`.github/workflows/update-so-scan-manual-rules.yml` write it. This is DATA, not
code: `scan-so.ts` says the row exists precisely because the distiller "can never
teach a reading TECHNIQUE", and `distillGlobalRules` never regenerates it — so no
deploy, and no busting the 1-hour prompt cache for every rep.

**Four more techniques were added in the same edit**, each measured against the
live account book during the 2026-09 reconciliation:

- **The BUILD itself can be TBC, not just the colour.** Of the 23 sales orders
  whose sofa build the reconcile cannot verify, **21 carry no drawing at all**
  and a Desc2 reading only `tbc` / `kiv` / `Size: TBC`. The compartments were
  never decided, so an invented build is not a near miss — it is a fabrication
  that reaches the factory.
- **The order book's shorthand**: `ELT` = `L`, `2ER` = `2A(RHF)`, a bare `NA` =
  `1NA`, and `2S(35") + 2S(28")` is two 2-seaters of different depths.
- **`C TABLE` is a console table, not the corner.** Rule 4 is right that a box
  marked C is the corner, but `HC-SO-011994`'s own Desc2 reads
  `C TABLE+1+C+2(28'INCH)` — both tokens in one string.
- **Model aliases are not symmetric**: `8030` = `5540`; `5535` is its OWN model
  and is never folded; `5537 -> 8030` is UNCONFIRMED. A wrongly folded model
  picks a catalog SKU for a sofa the customer did not buy, and the price follows
  the SKU.

The edit is pinned to the old rule-5 wording verbatim, so a row somebody else has
rewritten is refused rather than clobbered, and the verification asserts the
hatched-armrest and bedframe sections are still present afterwards.
