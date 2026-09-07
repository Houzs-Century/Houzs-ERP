## The retired-colour references were repaired and the sofa compartments keyed [high]

<!-- area: Sofa, fabric, variants -->

All times LOCAL (Malaysia, UTC+8). Company 1 (Houzs Century), prod.

## PART 1 — 280 live lines were bound to a colour the factory cannot buy

**Symptom.** `docs/bugs/0669` measured it and left it: live document lines
naming a `scm.fabric_colours` row that is `active = false`. A retired colour is
not a cosmetic label — it is absent from every picker, so the line names a
colour nobody can order.

**Root cause (traced).** Unchanged from 0669 and not re-litigated here:
`lib/fabric-colour-match.mjs` `live()` (`:340-343`) follows a superseded row to
its replacement, and it reads `r.active`, so it is a no-op for any caller whose
SELECT omits that column. The failure is silent and produces a confidently
WRONG binding, never a blank.

**Fix (APPLIED, both halves proved by a run).**

| step | run | local time | result |
|---|---|---|---|
| PLAN | [34143735823](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34143735823) | 00:32-00:45 | 951 colours (851 active, 100 retired); repairable 16, refused 1; **255** lines |
| APPLY | [34151098450](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34151098450) | 02:18-02:48 | repairable 16, refused 1; **280** lines; `repaired: 16 failed: 0 refused: 1`; fresh-connection read-back: `no repaired colour is named by any live line on any arm` |
| RE-MEASURE | [34157668964](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34157668964) | 03:59-04:11 | `repairable: 0 refused: 1` — **total live lines stranded on a retired colour: 0** |

**280 of 281 repaired.** The 281st is the refused `AVANI 02` line below, which is
still stranded on purpose. An hour and eleven minutes after the write, an
independent PLAN reads zero.

The 16 are every retired colour whose own label records what absorbed it, and
each destination was checked by the script to exist, to be ACTIVE and to sit in
the same series. All sixteen are one shape — a zero-pad or a dropped colour name
inside one series:

```
87 CH141-1 -> CH141-01          52 BO315-3 -> BO315-03         42 BO315-1-PEARL -> BO315-01
20 M2402-4-SAND -> M2402-04     16 BO315-4-SAND -> BO315-04    15 BO315-5-FOSSIL -> BO315-05
10 CH141-11-SILVER -> CH141-11   8 CH141-2 -> CH141-02          8 CH141-8 -> CH141-08
 6 J9226-2 -> J9226-02           6 CH141-9 -> CH141-09          3 M2402-1-PEARL -> M2402-01
 2 BO315-7 -> BO315-07           2 BO315-8 -> BO315-08          2 CH141-4 -> CH141-04
 1 "KS-01 BABY WHITE" -> KS-01
```

**THE ONE REFUSAL STANDS, and both sides are spelled out here so nobody forces
it later.** One line names `"AVANI 02"`. Its label points at `"AVANI-02"`, which
exists and is ACTIVE — but `AVANI-02` sits in series **`AVANI`** while the
retired row sits in series **`AVANI 02`** (space, not hyphen). The script refuses
a cross-series repoint because that is a re-parent, not a succession, and the two
readings — "the series name was normalised" and "these are two different series"
— are not distinguishable from the data. **Owner decision. Do not force it.**

**255 was already stale when it was written, and that is the finding.** The plan
read 255 at 00:32; the apply read **280** at 02:18. **+25 stranded lines appeared
in that 1h46m**, and nobody was working on colours — the callers that omit
`active` were still writing bindings onto retired rows.

**It is a burst, not a drip — do not quote it as a rate.** The re-measure covers
the following 1h11m and adds **zero**. So the +25 came from one or more of the
other go-live runs in that window (a re-import, a refresh, a delta sync), not
from a steady leak. What is PROVEN: the mechanism can still create new stranded
rows, and did, tonight, unattended. What is UNKNOWN: which run wrote them —
nothing stamps the writer on the row.

**THE 0669 LEDGER TABLE OF FIFTEEN IS INCOMPLETE — it is 27, and 23 of them omit
the column.** 0669 lists 15 callers found by grepping `FROM scm.fabric_colours`.
That grep is looser than the defect (it catches scripts that never build an
index) and, more importantly, its printed table is a hand-trimmed subset of its
own output. The precise question is which scripts hand rows to
`buildFabricColourIndex` — the function the `active` column defends:

```enumeration
$ git grep -l "buildFabricColourIndex(" -- backend/scripts
backend/scripts/backfill-sofa-variants-from-desc2.mjs
backend/scripts/bind-null-colour-lines.mjs
backend/scripts/check-ac-erp-reconcile.mjs
backend/scripts/check-golive-parity.mjs
backend/scripts/check-po-arm-own-text.mjs
backend/scripts/check-sofa-bedframe-completeness.mjs
backend/scripts/create-missing-sofa-fabrics.mjs
backend/scripts/diag-so-po-variant-divergence.mjs
backend/scripts/import-ac-outstanding-po.mjs
backend/scripts/import-ac-outstanding-so.mjs
backend/scripts/import-ac-so-linked-pos.mjs
backend/scripts/lib/fabric-colour-match.mjs
backend/scripts/probe-fabric-colour-classes.mjs
backend/scripts/probe-fabric-colours.mjs
backend/scripts/probe-sofa-absent-pieces.mjs
backend/scripts/probe-sofa-colour-misses.mjs
backend/scripts/probe-sofa-placeholder-desc2.mjs
backend/scripts/probe-write-persistence.mjs
backend/scripts/propose-sofa-colour-matches.mjs
backend/scripts/redecode-collapsed-sofa-lines.mjs
backend/scripts/refresh-po-variants.mjs
backend/scripts/refresh-so-variants.mjs
backend/scripts/refresh-sofa-colours.mjs
backend/scripts/repair-collided-so-variants.mjs
backend/scripts/repair-grn-variant-snapshot.mjs
backend/scripts/repair-leaked-sofa-lines.mjs
backend/scripts/sync-ac-delta.mjs
backend/scripts/topup-ac-po-lines.mjs
```

27 callers plus the module itself. **Four pass `active`** —
`backfill-sofa-variants-from-desc2` (0669's fix), `check-ac-erp-reconcile`,
`probe-fabric-colour-classes`, `propose-sofa-colour-matches`. **Twenty-three do
not.** Eleven of the twenty-three are missing from 0669's table entirely, and
five of those eleven predate its census by three to four weeks
(`refresh-so-variants` 2026-08-09, `repair-leaked-sofa-lines`,
`topup-ac-po-lines`, `probe-sofa-colour-misses` 2026-08-10,
`repair-grn-variant-snapshot` 2026-08-11) — so the table was incomplete when it
was written, not overtaken by new code.

Two of the omissions matter more than the rest:

- **`sync-ac-delta.mjs`** is the ONGOING delta sync. It omits the column, so it
  can keep minting stranded rows after go-live. Nothing else on this list runs
  unattended.
- **`bind-null-colour-lines.mjs`** looks defended and is not. It filters on
  `scm.fabric_library.active` — the **series** flag — and never reads the
  **colour** flag, so a retired colour on a live series passes straight through
  (`:73-80`).

**Deliberately NOT done, unchanged from 0669:** the 23 callers are not changed
here. Each one's match set widens when it gains the column, and changing 23
scripts' behaviour mid-go-live is not a safe trade. **Until they are changed,
new stranded rows will keep being created — that is measured, not feared: +25 in
1h46m tonight.** Decision owner: the owner.

**Stock and readiness did NOT move — observed, not argued.** The repoint writes
four things and not one of them is a quantity: `variants` colour aliases
(`jsonb_set`), `description2` (text `replace`), `variant_key` /
`committed_variant_key` (text `replace` of `fabriccode=<old>` to
`fabriccode=<new>`) and `product_models.allowed_options` —
`lib/fabric-write.mjs:212-276`. It touched 33 `inventory_movements` and 33
`inventory_lots` rows, so the claim was measured either way, with
`check-ac-vs-erp-reconcile` on both sides of the apply:

| | before repair ([34149401056](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34149401056), 01:52) | after repair ([34153268621](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34153268621), 02:50) | after the sofa keying ([34158712964](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34158712964), 04:14) |
|---|---|---|---|
| sofa READY / PENDING | 133 / 240 | 133 / 240 | 133 / 240 |
| bedframe READY / PENDING | 335 / 181 | 335 / 181 | 335 / 181 |
| mattress READY / PENDING / PARTIAL | 338 / 292 / 2 | 338 / 292 / 2 | 338 / 292 / 2 |
| accessory READY / PENDING / PARTIAL | 939 / 397 / 10 | 939 / 397 / 10 | 939 / 397 / 10 |
| headers READY_TO_SHIP / CONFIRMED | 233 / 121 | 233 / 121 | 233 / 121 |
| fully-received BOUND dedications not READY | 0 | 0 | 0 |
| sofa open lots / units | 121 / 121 | 121 / 121 | 121 / 121 |
| balance: compared / matching / differing | 512 / 498 / 14 | 512 / 498 / 14 | 512 / 498 / 14 |

Every line identical across all three readings. A colour is a variant, not a
quantity, and a line key is an identity, not a quantity. (The sofa keying writes
only `linked_ac_dtlkey` on `scm.mfg_sales_order_items` and
`scm.purchase_order_items` — neither is a stock table.)

## PART 2 — the reconcile was pairing a book line against a different line's sofa compartment

**Symptom.** `check-ac-erp-reconcile` reported quantity differences on
`SO-000814` DtlKey 58981 and `SO-012128` DtlKey 924549 that were not quantity
differences at all
([34140676108](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34140676108),
2026-09-07 23:54):

```
SO-000814 DtlKey 58981: AutoCount qty 0 vs ERP qty 1
SO-012128 DtlKey 924549: AutoCount qty 4 vs ERP qty 1
```

**Root cause (traced).** The migrated sofa lines carried **no**
`linked_ac_dtlkey`: the ordinary backfill matches on (DocNo + item code) and the
cutover split each sofa into compartments, so the mapping's `9028-1S` never
meets the ERP's `9028-1A(RHF)`. With no key,
`check-ac-erp-reconcile:938-970` falls back to (qty, price), then qty, then
**document order** — and document order put a sofa compartment against a note
line. On `SO-000814` the book's own three lines are
`58980 RDS-5526 SOFA qty 1`, `58981 (no item code) qty 0 "LEG: FOLLOW DISPLAY"`
and `79444 RDS-SQUARE PILLOW qty 2`; the ERP's keyless `5526-1NA` landed on the
note.

**Fix (APPLIED).** `backfill-ac-sofa-line-keys` groups the ERP compartment rows
back into builds, resolves the build to the `<model>-1S` code the mapping knows,
and gives every row of a build the same DtlKey — refusing any group where the
counts disagree.

| step | run | local time | result |
|---|---|---|---|
| DRY-RUN | [34153522961](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34153522961) | 02:54 | SO: 102 builds, **33** rows to key, 50 no-AutoCount-line, 38 count-mismatch. PO: 20 builds, **17** rows to key, 11 no-AutoCount-line, 1 count-mismatch |
| APPLY | [34155601876](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34155601876) | 03:26 | `..33/33` and `..17/17` — **50 keys written** |

**Result — one of the two named pairings is gone, and the other is a DIFFERENT
defect.** Reconcile after
([34157241944](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34157241944), 03:52):

- SO line pairs 14,862 to 14,893; **quantity differences 2 to 1**, unit price
  1 to 0, document total 7 to 6.
- **`SO-000814` / 58981 is FIXED.** The keyed `5526-1NA` now claims 58980 (the
  real sofa line) and the note reports honestly as
  `SO-000814: AutoCount DtlKey 58981 has no ERP line`. Its two invented variant
  findings went with it — the fake colour `"(blank)" vs "J9883-1-01"` and the
  fake leg `"LEG: FOLLOW DISPLAY" vs "(blank)"`.
- **`SO-012128` / 924549 is NOT fixed, and keying could never have fixed it.**
  The book's sofa line on that document is `833309 HOK-5530 SOFA`, which
  `data/autocount-erp-mapping-1561.csv:1159` resolves to `5530-1S`; the ERP line
  is `9028-1A(RHF)`, model **9028**, which maps from `AMN-SF9028 SOFA` /
  `DSL-9028 SOFA` (`:1136`, `:1154`) — neither of which appears on this
  document. The backfill therefore found no AutoCount line for `9028-1S` on
  SO-012128 and refused, correctly, leaving the row keyless, so the qty/price
  fallback still buckets it onto the four free `HOK-SQUARE PILLOW` at RM 0.00
  marked `FOR CONPESSANTION WRONG ITEM DELIVERY`. **The residual is a model
  identity defect — the ERP line names 9028 where the book names 5530 — not a
  pairing defect.** Fixing it is an alias ruling (`5530` to `9028`) or a
  correction to the ERP line; both are the owner's, and the sofa-alias record
  says an unconfirmed alias needs his word.

**The 296/98 shared line keys are settled: all sofa, none a cross-product
collision.** `probe-invoice-link-facts` section D, before
([34143079454](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34143079454), 00:24)
and after
([34157450265](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34157450265), 03:55):

| SO | groups | one model, distinct compartments | one model, a compartment REPEATS | two different models |
|---|---|---|---|---|
| before | 296 | 286 | 10 | **0** |
| after | 310 | 297 | 13 | **0** |

| PO | groups | one model, distinct compartments | one model, a compartment REPEATS | two different models |
|---|---|---|---|---|
| before | 98 | 94 | 4 | **0** |
| after | 106 | 101 | 5 | **0** |

**PROVEN:** not one of the 416 groups names two different models, before or
after. The 18 that fail the strict test fail on one condition only — a
compartment suffix appears twice inside a single model (`9058-1NA` x2,
`8050-1A(R)(LHF)` x2, `8030-Console` x2). **LIKELY** that is a long sofa carrying
two identical middle pieces, or two identical builds of one model on one book
line, both of which the owner's slip notation allows. It is **not PROVEN**: the
discriminator in `lib/sofa-compartment-suffixes.mjs` cannot tell "two identical
pieces in one build" from "two builds wrongly sharing one key", and it refuses
rather than guessing — which is the right behaviour and the reason this stays
open. The 18 keys are named in the two runs above. Not a go-live blocker: no
lane can pick the wrong PRODUCT off these groups, because there is only one
product in each.

The keying grew the shared-key population by 22 groups (SO +14, PO +8), which is
the intended shape — a keyed sofa is by definition several ERP rows on one book
DtlKey.

**Ref.** fix/golive-colour-sofa-keys, 2026-09-08. Follows `docs/bugs/0669`
(the matcher's dead `live()` redirect), `docs/bugs/0672` (key without identity)
and `docs/bugs/0673` (one DtlKey, many ERP rows, RM 2,216,501).
