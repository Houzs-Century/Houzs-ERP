## Four consignment helpers have SO twins; three of the four pairs differ [open-question]

<!-- area: Sales orders + pricing -->

**Not a fix.** Three divergences found while shrinking
`scm/routes/consignment-orders.ts`, none of which I could show is reachable, and
each of which needs a decision rather than a refactor. Recorded so they stop
being invisible.

The Consignment Order router is a `mfg-sales-orders` clone. Four helpers exist in
both files. `extFromMime` is byte-identical. The other three are not:

| helper | Sales Order | Consignment Order |
|---|---|---|
| `deriveCountryFromState` | canonicalises the state first (`canonicalizeMyState`), so "PENANG" resolves via "Pulau Pinang" | looks up the raw string |
| `snapshotUnitCostSen` | wraps both the explicit value and the DB read in `senOrZero` | returns the explicit value raw; `Number(...)` on the DB read |
| `deriveSalesLocationFromState` | differs only in formatting, as far as a normalised comparison shows | — |

**Reachability, checked rather than assumed:**

- `snapshotUnitCostSen` — all three CO callsites already wrap the argument in
  `Number(...)`, so a string cannot reach it, and `NaN > 0` is false. The DB side
  reads `mfg_products.cost_price_sen`, which is `integer DEFAULT 0 NOT NULL`, so
  it can be neither null nor non-numeric. `Number(x)` and `senOrZero(x)` agree on
  every value that column can hold. **Unreachable.**
- `deriveCountryFromState` — both versions fall back to `'Malaysia'` when the
  lookup misses, and the only strings `canonicalizeMyState` rewrites are
  Malaysian states, whose country is Malaysia either way. `my_localities` DOES
  hold non-Malaysia rows (mig 0181 seeds SG + CN), but their state names are not
  ones the canonicaliser rewrites. **I could not construct a case where the
  outputs differ; that is weaker than proving there is none.**

**Why they are not consolidated in this PR.** Unifying them CHANGES behaviour —
the CO would start canonicalising, and start clamping. `CLAUDE.md` asks for
changes that can be shown to be behaviour-preserving, and these cannot be. Which
version is right is the owner's call.

**Related, and the same shape as the SERVICE finding recorded above.** That entry
should be read with one more fact this pass turned up: `consignment-orders.ts`
carries a deliberate comment saying the CO "has no `service_centi` /
`service_cost_centi`, because the consignment order carries no service category"
— and the schema agrees, there is no such column. So the missing SERVICE branch
in its `normCategory` may be CONSISTENT with the document model rather than an
oversight. Nothing validates `item_group` on a CO line, so a service-shaped line
is still possible in data. **Which reading is right is an owner decision, and the
copy was deliberately left alone here because of it.**

**What this PR did do.** Moved the inert half — the HEADER/ITEM select lists, the
finance-key set and gate, the identity-lock column set, and the photo constants —
into `scm/lib/consignment-order-shape.ts`. Verified by comparing the COLUMN SET
rather than the raw text: 108 columns before, 108 after, none lost, none added.
(The raw-text comparison said "different" and was answering a different question
— it counted the added `export` keyword and the indentation.)

`consignment-orders.ts` 2475 -> 2379 lines, ceiling follows.

**Ref.** 2026-08-15, file-size debt paydown.
