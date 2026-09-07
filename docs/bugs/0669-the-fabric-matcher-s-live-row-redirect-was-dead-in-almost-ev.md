## The fabric matcher's live-row redirect was dead in almost every caller [high]

<!-- area: Sofa, fabric, variants -->

**Symptom.** The recorded trap from the 2026-09-02 cutover clean-up: *the fabric
library renumbered itself on 2026-08-11 and a matcher answered the DEAD row.*
It was treated as a one-off. It is not — the mechanism that was supposed to stop
it has never run in the scripts that write migrated lines.

**Root cause (traced, not guessed).** `backend/scripts/lib/fabric-colour-match.mjs`
reads `active` in exactly two places, and both are the defence:

| where | what it does |
|---|---|
| `claimIndex`, `:257-258` | when a key is claimed by two rows, the ACTIVE one takes it if every other claimant is superseded; sixty-six padded keys are exactly such a pair |
| `live()`, `:340-343` | when a pass returns a superseded row, follow it to its replacement |

Both read `r.active`, and the file says so plainly: *"`active` is read ONLY where
the caller selected it. A row with no `active` property is neither active nor
superseded."*

Census of every caller, 2026-09-07 (`grep -n "FROM scm.fabric_colours" backend/scripts/*.mjs`):

```
align-fabric-trackings.mjs            SELECT colour_id, label, active   <- the only one
add-missing-sofa-fabrics.mjs          SELECT fabric_id, colour_id, label
backfill-sofa-variants-from-desc2.mjs SELECT fabric_id, colour_id, label
bind-null-colour-lines.mjs            SELECT fabric_id, colour_id, label
check-cutover-metrics.mjs             SELECT fabric_id, colour_id, label
check-golive-parity.mjs               SELECT fabric_id, colour_id, label
check-po-arm-own-text.mjs             SELECT fabric_id, colour_id, label
check-sofa-bedframe-completeness.mjs  SELECT fabric_id, colour_id, label
create-missing-sofa-fabrics.mjs       SELECT fabric_id, colour_id, label
diag-so-po-variant-divergence.mjs     SELECT fabric_id, colour_id, label
fix-modenza-label-and-5526-pieces.mjs SELECT fabric_id, colour_id, label
import-ac-outstanding-po.mjs          SELECT fabric_id, colour_id, label
import-ac-outstanding-so.mjs          SELECT fabric_id, colour_id, label
import-ac-so-linked-pos.mjs           SELECT fabric_id, colour_id, label
merge-duplicate-fabric-series.mjs     SELECT fabric_id, colour_id, label
```

**One of fifteen callers passes the column.** The other fourteen include both
AutoCount importers and every sofa/bedframe backfill — that is, precisely the
scripts that WRITE the migrated colour bindings. For all of them `live()` is a
no-op, so a pass that lands on a retired row binds the line to the retired row
and nothing says so.

**The failure is asymmetric, which is why it went unnoticed.** Omitting `active`
makes `claimIndex` STRICTER — a live/superseded pair refuses the key instead of
resolving it — so the visible symptom is a blank colour, which reads as "the
matcher is being careful". The `live()` half is the dangerous one and it is
silent: it produces a confidently WRONG binding, never a blank.

**Fix.** `backfill-sofa-variants-from-desc2.mjs:85` now selects `active`. That
is the script that will apply the colour pairings the owner is being asked to
confirm, so it is the one that had to be right before he confirms anything.

`backend/scripts/propose-sofa-colour-matches.mjs` (read-only, new) builds the
index BOTH ways and reports, per proposal, where the answer differs — so the
size of this defect on today's data is a number in a run log rather than an
argument.

**Deliberately NOT done.** The other thirteen callers are unchanged. Fixing them
is correct and should happen, but each one's match set widens when it gains the
column, and changing fourteen scripts' behaviour at once in the middle of a
go-live is not a safe trade for a defect whose write path is FUZZY-gated
anyway. Decision owner: the owner, after the pairings above are confirmed.

**APPLIED 2026-09-08, and the trap was real on the way through.** The 19 colour
pairings were written to prod with `backfill-sofa-variants` `fuzzy=1 apply=1`
(run [34140545099](https://github.com/hello-houzs/Houzs-ERP/actions/runs/34140545099),
00:53 local): `company 1`, `fabric library: 951 colour rows`, `TO FILL 82`,
`APPLIED — 82 line(s) merged`. Four of those texts would have bound to a RETIRED
row without the `active` column, and `propose-sofa-colour-matches` says so per
proposal:

```
"CH141-8 ARMY"  -> CH141-08   *** without `active`, the matcher would have answered CH141-8 ***
"CH141-9 sky"   -> CH141-09   *** ... would have answered CH141-9 ***
"BO315-4 Sand"  -> BO315-04   *** ... would have answered BO315-4-SAND ***
"BO315-7 Peach" -> BO315-07   *** ... would have answered BO315-7 ***
```

Those four cover **18 of the 82 lines**. Independent read-back of what the run
actually wrote: all 20 distinct colour codes in the plan are LIVE rows, and the
plan contains **zero** retired codes.

**THE DAMAGE FROM THE OTHER CALLERS IS NOW A NUMBER, NOT AN ARGUMENT.**
`repair-superseded-colour-refs` plan against prod, same sitting:

```
fabric_colours: 951  (active 851, retired 100)
  repairable: 16   refused: 1
  total live lines stranded on a retired colour: 255
       75 "CH141-1" -> "CH141-01"      50 "BO315-3" -> "BO315-03"
       36 "BO315-1-PEARL" -> "BO315-01"  18 "M2402-4-SAND" -> "M2402-04"
       ... 12 more mappings
  REFUSED 1 line "AVANI 02" — "AVANI-02" is in series "AVANI", not "AVANI 02"
```

255 live lines, written by the thirteen callers that still omit the column.
Not repaired here: it is a 255-row write in the middle of a go-live, the repair
script and its workflow already exist, and the decision is the owner's.

**Ref.** fix/ac-lines-match-2026-09-07, 2026-09-07; applied and measured
docs/cutover-keys-and-ledger, 2026-09-08.
