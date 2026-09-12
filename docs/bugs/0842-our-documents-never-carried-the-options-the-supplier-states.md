## Our documents never carried the options the supplier states, so 177 lines had no drawer, headboard or covering [high]

**Symptom.** The owner, 2026-09-12, after the compartment and measurement rounds:
「跟着 supplier 改完我们的 SO PO GR DO 等等先，因为我们之前是没有规格和 sofa
compartment 的，所以要修复先」. Service cases and delivery notes were being raised
against lines that state no option at all — a bed with no drawer recorded, a sofa
with no backrest, a headboard with no covering.

**What was actually missing.** The 2026-09-11 rounds aligned two of the three
things the supplier states: the COMPARTMENT (71 builds) and the MEASUREMENTS
(divan / gap / leg / seat). The OPTIONS were never carried. The supplier writes
them in the same `Detail Description 2`, after the measurements:

    div:8inch / gap:14inch / Right Drawer, HB Straight
    div:10inch / gap:14inch / Front Drawer, HB Fully Cover, Divan Full Cover

and the vocabulary is our own catalogue's — measured across the export: Nylon
Fabric 152 rows, HB Fully Cover 84, HB Straight 64, Divan Full Cover 60, Front
Drawer 45, Divan Curve 39, Right Drawer 28, Divan Top Fully Cover 26, Left Drawer
24, No Side Panel 9.

**Measured on production, 2026-09-12** (375 supplier documents matching one of our
purchase orders, 616 lines pairing line-for-line):

| | |
|---|---|
| already carry every option the supplier states | 439 |
| **MISSING an option** | **177** |
| writable | **167**, over 106 purchase orders |
| refused — the stock bucket is shared outside the chain | 10 |
| we carry an option the supplier does not state | 113 — reported, never removed |

What would be added: Nylon Fabric 52, HB Fully Cover 45, Divan Full Cover 32, HB
Straight 30, **Right Drawer 12, Left Drawer 8, Front Drawer 6**, Divan Curve 7,
5537/5540 Backrest 16, Divan Top Fully Cover 2, 1 Piece Divan 1, No Side Panel 1.

**Fix.** `apply-supplier-specials.mjs` (+ workflow) carries the options onto the
purchase line, its sales line, its goods-received lines and the sales line's
delivery lines — the whole chain — and, because `specials` composes
`computeVariantKey`, re-keys that chain's `inventory_lots`,
`inventory_movements` and `inventory_lot_consumptions` in the SAME transaction
wherever goods are already in. A bucket shared with a document OUTSIDE the chain
is refused and named: moving it would point those documents at stock that is no
longer there, which is `docs/bugs/0722` in the other direction.

Three limits, each deliberate:

- **Only what the catalogue already holds.** A phrase becomes an option only when
  `scm.special_addons` holds that exact code for this company (35 today).
  Everything else — `Extend 5"`, `no layering`, `OTHER: ARM 12"` — is a free-text
  instruction whose home is the special-order NOTE, not the variant key
  (`special-order-text-is-the-home-for-spec`). Those are counted and listed,
  never invented as options.
- **It adds, it never removes.** An option we carry that the supplier does not
  state may be a later amendment of ours, and the listing is stale where we
  amended (`supplier-listing-is-stale-where-we-amended`). The 113 are reported.
- **The line pairs by piece or by size**, the same readers the compartment and
  bedframe tools use, so a document whose pieces do not pair is skipped rather
  than guessed at.

**Ref.** fix/supplier-specials, 2026-09-12. Related: `docs/bugs/0824` (the side
drawer the decoder called Front), `docs/bugs/0722` (why the stock moves with the
line).
