# HANDOFF — special options, drawers and pillows (2026-09-12 → 2026-09-14)

Owner-facing thread: 「全部 special 能补齐的尽量补齐」, 「SO PO GR DO SI PI 全部」, and
「不要影响到我们的卖价」. Company 1 (Houzs) only unless stated. Every count below
is from a named production run; re-run the read-only checks in §6 before quoting
any of them.

---

## 1. What LANDED on production

| round | tool | run(s) | result |
|---|---|---|---|
| supplier options → six documents | `apply-supplier-specials.mjs` | (09-12) | 528 lines, 66 stock rows, VERIFY OK |
| our own book text → six documents | `apply-book-text-specials.mjs` | 34699055869, 34701789423 | **658 lines / 399 chains / 43 stock rows**, VERIFY OK ×2 |
| legacy spellings folded onto the catalogue code | `unify-legacy-specials.mjs` | 34771249828, 34777312495 | **1,019 lines / 587 chains / 223 stock rows**, VERIFY OK ×2 |
| option selling price zeroed (cost kept) | `zero-special-addon-selling-price.mjs` | 34770536637 (apply), 34771498050 (re-plan after deploy) | 11 options → selling 0, cost unchanged, company 2 untouched. **Held** 10 min after the screen fix went live |
| retired option re-activated | `reactivate-special-addon.mjs` | 34771168502 (plan: no active equivalent), 34771210523 (apply) | `Separate Backrest Packing` active; price/label/categories unchanged |

"Six documents" = sales order, purchase order, goods received, delivery order,
purchase invoice, sales invoice. `specials` composes `computeVariantKey`, so every
round moved the stock with the line.

## 2. Code that LANDED

- **Drawer decoding, two stages** — `parse-bedframe.mjs` (#3737) AND
  `special-order-phrase-map.json` (#3745). The map still filed `Side Drawer (side
  unknown)` as Front after the parser was fixed; caught by a self-test before any
  write. `docs/bugs/0824`, `0843`.
- **Stock guard, shared and tested** — `scripts/lib/spec-chain-guard.mjs` + 10
  tests. Two refusals: a bucket reached from outside the chain, and a bucket two
  chains would send to DIFFERENT keys (the real `HC-SO-010183` two-CODY case).
  Every line of the chain is asked for its bucket, including the DELIVERY line —
  a shipment's OUT movement is keyed on the delivery line's own code
  (`delivery-orders-mfg.ts:927`). `docs/bugs/0844`.
- **The option price box is COST** (#3772) — both maintenance screens wrote one
  "Price" figure into `selling_price_sen` too, so a costing number became a
  customer surcharge (`lookupSelling` adds it). Now writes `costPriceSen` only,
  labelled Cost. **Verified live**: 508 JS chunks crawled from
  erp.houzscentury.com, old label in zero. `SpecialAddonsTab.tsx` is imported by
  no page — not shipped. `docs/bugs/0859-one-price-box-…`.
- **Scope files, not flags** — `data/legacy-specials-unify.json` (authorised
  families with the owner's words), `data/drawer-side-owner-rulings.json`,
  `data/owner-decisions-2026-09-14.json`.

## 3. Owner rulings that govern this (all written into the files above)

- The side of a drawer is read **as you look at the drawing / photo** (confirmed on two documents).
- `2SIDE DRAWER` / `1 pair side drawer` is **not a rule**: `HC-SO-013353` is a pair (left + right, reconfirmed 09-14); `HC-SO-013119` and `HC-SO-010385` draw both on ONE side. Each document by its own drawing.
- Unstated side, no photo, order **not proceeded** → leave it (「还没有 proceed 就不需要看」).
- **Price is irrelevant to a variant fix, and must never move it.** The maintenance figure is costing; selling price is free, typed by sales on the line (「正常我们的 selling price 全部自由的」). Company 2 carries its own values to the 2990s POS.
- Fold scope: 13 families + `Separate Backrest Packing` (「那就批完」). The tool still refuses any RETIRED target by rule.
- Ohana / Hookka / Hookka Manufacturing are **one supplier**.

## 4. Measured facts worth not re-deriving

- Price exposure (34745750576): 3,944 of 3,948 sofa/bedframe sales lines are on a **migrated** order, where the surcharge arm is structurally inert (`mfg-pricing-recompute.ts:535-545`); **0** native lines carried a priced option. Nothing was ever repriced.
- All 35 catalogue options are reachable by a rule — the census first said 5 were not, because it read only `families` and not `cushionSwapModels` (`docs/bugs/0845-the-options-census-…`).
- Legacy values not in the catalogue: 200 on 1,491 lines; 72 of them (272 lines) the rules place on nothing — genuine free text, left alone.

## 5. STILL OPEN

| # | item | state | owner said |
|---|---|---|---|
| a | **Shared-bucket refusals** — `HC-SO-010981` JAGER-(Q), `HC-SO-013193` CELENE (A)-(K) from the fold, plus the 12 from the book-text round | NOT started | 「怎么可能我们的库存是分 item 的不是吗」 — stock IS per item+spec and pooled across orders. Next: measure, per refused chain, whether its lots trace to its OWN receipt and no other order consumed them, and move only those |
| b | `HC-SO-012046` / `HC-SO-013224` — shipped SKUs differ from the factory's build | NOT started | verify supplier code → correct documents → THEN stock adjustment; stock must end accurate; never an OUT against stock we do not hold (0722) |
| c | 4 sofa POs whose pieces differ from the supplier — `HC-PO-010086`, `010041`, `2609-051`, `010087` | NOT started | follow the factory |
| d | **Pillows** — first run 34777318705; `HC-PO-009780` was a false positive (fixed #3810); `HC-PO-009981` reads `OTHER-PILLOW ×200` vs supplier `SQUARE ×200` (probably a naming gap); `HC-PO-010170` random vs custom colour ×3, unreceived — check the customer line first | re-run dispatched after #3810 | 「配件…做到完」 |
| e | 21 side drawers with no hand: 6 with a photo (3 read, 3 are `HC-SO-012599`'s HB-FULLY-COVER diagram), 0 proceeded-without-photo, 15 not proceeded (leave) | worklist `dump-drawer-side-worklist` | photo or leave |
| f | Other-supplier sofas: 176 lines with a photo | NOT started | read the photos |

## 6. Read-only checks — safe to re-run any time (prod, workflow_dispatch)

| workflow | answers |
|---|---|
| `special-coverage-census.yml` | every option, lines carrying it, reachability, legacy spellings grouped |
| `priced-specials-exposure.yml` | can a variant fix move a price — native lines carrying a priced option |
| `drawer-side-worklist.yml` | unstated side drawers split into photo / ask / leave |
| `check-supplier-accessory-vs-erp.yml` | pillows vs our POs, with our line and the customer line |
| `unify-legacy-specials.yml` / `apply-book-text-specials.yml` with `mode=plan` | what is still left to fold / carry (should be only the refusals) |

## 7. Traps met in this thread

- **Staging vs prod in a run list.** A staging apply followed by a prod plan reads exactly like "the value was reverted". Read each run's executed job (`run-staging` / `run-prod`) before concluding anything.
- **Another session on the same workflow.** Every dispatch shows the same GitHub actor. `ListAgents` + `SendMessage` is the only way to tell sessions apart.
- **A self-test that hard-codes scope** refuses the day the scope widens (#3803).
- **A comment inside a SQL template literal** containing backticks ends the template — syntax error.
- Cite a ledger entry by its FULL filename: numbers collide (three files are `0859-*`).
