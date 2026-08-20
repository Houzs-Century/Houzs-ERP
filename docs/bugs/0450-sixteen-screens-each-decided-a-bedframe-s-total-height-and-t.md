## Sixteen screens each decided a bedframe's Total Height, and two of them refused to clear it [high]

<!-- area: Sofa, fabric, variants -->

**The rule.** A bedframe line's Total Height is not typed by anyone — no form in
the system has a Total Height input. It is derived from three pickers
(Divan + Leg + Gap) by whichever screen is open, written into the line's
`variants` blob, and sent to the server, which then prices and validates it.

**Sixteen homes, zero imports, three answers.** `grep -rn 'const parseInches'
frontend/src` returned 16 definitions and `grep -rn 'import.*parseInches'`
returned 0. Fourteen of the sixteen — the purchasing screens (New/Detail PO, PI,
PR, GRN, Goods Received, Stock Adjustment, and the four consignment pairs) —
were byte-identical. The other two had drifted, and they drifted on the SECOND
half of the question, which is the half nobody writes down: *what is written
when divan, leg and gap are all blank?*

| | behaviour when all three parts are blank |
|---|---|
| 14 purchasing screens | always assign; write `''` — the total is CLEARED |
| `SoLineCard.tsx` (Sales Order) | computed `''`, then the writer effect bailed on `if (!computedTotalHeight) return;` — the OLD value stayed |
| `MobileNewSO.tsx` (`buildVariants`) | `if (th > 0)` — the OLD value stayed, and on a fresh line the key was omitted entirely |

**Why the two stragglers cost money.** Blanking divan/leg/gap on a Sales Order
line that already carried a Total Height left the stale number in the draft, and
the draft is what gets saved. Downstream that stale number is not cosmetic:
`mfg-pricing.ts` prices a selling surcharge off it via `lookupSelling(
maintenanceConfig.totalHeights, input.totalHeight)`, and
`allowed-options-check.ts` refuses the whole line with `variant_not_allowed` /
field `total_height` when it is not in the Model's pool. That refusal names a
field the operator has no box to correct — the same shape as the curly-inch
refusal recorded above, which the owner has already paid for once.

**Behaviour was CHOSEN, not preserved, and the choice is the fourteen.** Two of
the sixteen change behaviour here; that is the fix, not a side effect. Clearing
is what keeps the stored value honest — a line reading `T.Heights 21"` with no
divan, no leg and no gap is a number the paperwork cannot justify. `''` was
verified safe against every consumer rather than assumed:

- `mfg-pricing.ts` — `lookupSelling` / `lookupCost` both open `if (!pool ||
  !value) return 0;`, so an empty height contributes no surcharge instead of
  missing a lookup.
- `allowed-options-check.ts` — short-circuits on `if (v.totalHeight && …)`, so
  `''` SKIPS the gate rather than tripping `variant_not_allowed`.
- `variant-key.ts` — `computeVariantKey` runs every axis through `norm()` then
  `if (val) parts.push(…)`, so `''` and an ABSENT key produce byte-identical
  stock-bucket keys. This is what makes MobileNewSO's old "omit the key" and the
  new "write `''`" interchangeable, and it was the one place the two were not
  obviously the same.
- `variant-summary.ts` — guards `if (total)`, so the `T.Heights` segment simply
  does not render.
- `so-amendment-line-diff.ts` — `hasAxis` / `unrenderedVariantAxes` both test
  `bag[k] != null && String(bag[k]).trim() !== ''`, so `''` reads as absent, and
  `resolveVariantGroup` trusts the stamped `item_group` before it ever consults
  those axes.

**The fix.** `backend/src/scm/shared/total-height.ts`, mirrored byte-for-byte to
`frontend/src/vendor/shared/total-height.ts`, exporting `parseInches`,
`TOTAL_HEIGHT_PARTS`, `isTotalHeightPart`, `isTotalHeightCategory`,
`computeTotalHeight` and `totalHeightPatch`. Sixteen call sites collapse to one
import each; the fifteen surplus `parseInches` definitions are gone.

`totalHeightPatch` exists because the arithmetic was never the bug — the WRITE
decision was. It returns `null` only when the stored value already equals the
computed one, and never merely because the computed one is empty. That is
precisely the distinction `if (!computedTotalHeight) return;` got wrong, and
keeping it inside the module means a caller cannot spell it wrong again.

The shared layer is the right home even though the server never computes this
value: the client must author it BEFORE the round-trip, because there is no
input box, so a server-only home would be unreachable at the moment of need —
which is exactly how sixteen copies were born. The frontend cannot import from
`backend/src`, so the pair is a mirror, and the mirror is only safe because
`total-height.canonical.test.ts` asserts byte-identity. `check-shared-mirrors`
now reports the pair IDENTICAL (its module count went 48 → 49).

**What stops it coming back.** `total-height.canonical.test.ts` (24 tests) pins
the rule, the write decision, the byte-identical mirror, and the call sites: no
file outside the module may define `parseInches`, none may re-derive
divan + leg + gap inline, and all sixteen named screens must still call
`computeTotalHeight`. Proven non-vacuous rather than asserted — four violations
were planted and each was caught by name:

- un-wiring `GrnNew.tsx` back to a private copy → 3 assertions fired, two naming
  `src/pages/scm-v2/GrnNew.tsx`;
- drifting the backend mirror by one token → the byte-identity test failed;
- swapping in MobileNewSO's rejected `th > 0` rule → "parts that are set but sum
  to zero are a REAL total" failed;
- reintroducing `if (!next) return null;` — the original bug, exactly — → the two
  `totalHeightPatch` clearing tests failed.

Each plant was reverted and the tree confirmed byte-identical afterwards.

**Also corrected.** `allowed-options-check.ts`'s comment cited
`SoLineCard.tsx:439-445` as the writer; line-number citations into a file that
moves are a stale reference by construction, so it now names the shared module
and records why an empty height is safe to skip the gate.
