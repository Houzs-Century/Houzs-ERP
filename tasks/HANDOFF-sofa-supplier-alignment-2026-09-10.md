# HANDOFF — sofa alignment to the supplier listing, 2026-09-10 / updated 2026-09-11

If you are picking this up: the first apply to production in this whole line of
work is IN FLIGHT or JUST DONE — see "State of the apply" below before anything
else. Everything before that was read-only.

## The owner's task list, in his order

1. Correct every PO **and GR** to match the supplier's listing — compartments
   AND variants. 「包过我的GR」.
2. Once those agree, re-check the **not-proceeded** orders against the photos
   (TV above/below).
3. Check every sales order against the TV rule.
4. When a PO or SO is confirmed correct, **back-fill the whole chain**
   SO -> PO -> GR -> DO.
5. **Tally** every sofa compartment and variant, to prove the round ran.

## The rulings that govern this work (all in session memory too)

| ruling | his words | effect |
|---|---|---|
| supplier is the authority | 「supplier的肯定对的 基本上你可以跟」 | correct OURS to match, no asking |
| **unless we amended it** | 「除非我们submit了amendment…」 | a PO amended after their cut is EXCLUDED; REQUESTED counts |
| a PO we cannot find is finished | 「找不到PO 可能已经送完了的 就不理」 | 80 refs below PO-009122 — not work |
| photos only for NOT-proceeded | 「你只需要看那些还没proceed的单…」 | proceeded builds come back from the supplier |
| supplier beats our OWN rounds | 「ok 四张跟supplier的」 | four docs were genuinely different sofas; supplier won, earlier entries superseded |
| a reversal is the SAME sofa | 「一样的东西啊 只是LHF 在第一个item而已」 | reverse ≠ mirror; only reverse-AND-swap-hands is different |
| the goods are right, the migrated docket is wrong | 「我做GR的时候…docket entry是错的（旧的单）」 | this whole exercise is so his GR can be received |

## State of the apply (THE important section)

`apply-sofa-compartment-corrections.yml`, target=prod, apply=1, run **34507126629**,
dispatched 2026-09-11 ~01:2x. The DRY-RUN that preceded it (run 34504568090) was:

    builds touched 293 (295 sofas) · lines updated 774 · added 9 · removed 0
    refused: 11 real-stock-movement, 1 downstream/money, 6 piece-SKU-not-minted, 1 seat
    HELD: HC-PO-010056, HC-PO-000162, HC-SO-011733, HC-SO-013384 (x2),
          GR-000287 chain, HC-SO-012025 (already done by reverse-sofa-build-middle)
    money moved: 0 on every build

The four TV-round mirror fixes are in it: HC-SO-012368, -012760, -013075,
-013239, each 2A(LHF)+L(RHF) -> L(LHF)+2A(RHF), money unchanged.

**When the run finishes**: it re-reads every touched document on a FRESH
connection and asserts the piece multiset + both money columns. Read the tail of
the log for `VERIFIED` / any `VERIFY FAILED`. If it failed mid-way, the applier
does each build in its own transaction, so completed builds are committed and
re-running is inert on them (RE-RUN header). Re-dispatch the same workflow.

## What is DONE (merged to main)

- Supplier sofa corrections data (51 builds / 102 entries) — PR #3597
- TV photo round (4 mirrors) + all 129 readings — PR #3591
- same-sofa reversal rule — PR #3578
- prior-selection fix (supplier-confirmed round wins) — PR #3593
- 9 earlier entries superseded to match the supplier

## What is READ-ONLY MEASURED, numbers you can trust

- product master: 372 sofa SKUs, ZERO name/code contradictions (run 34462427810)
- sofa SO lines: 2 of 1,329 disagreed (HC-SO-012016, an amendment-path artefact)
- supplier vs our sofa POs: 51 to change, 26 of them already received stock
- 129 of 129 sofa drawings read: 109 correct, 4 mirrored, 13 undecided, 3 n/a

## What is STILL OPEN

- **Bedframe supplier comparison** — PR #3599 (`check-supplier-bedframe-vs-erp`),
  NOT YET RUN. The sofa check over bedframes gave false numbers (53 order, 239
  variant); this one is bedframe-aware (multiset only, div/gap/leg grammar).
  1,230 bedframe rows, 3 real size-diffs seen in the sofa-run partial
  (HC-PO-009933, 009990, 010115). Accessory (66 rows) not compared at all.
- **26 sofa builds with received stock** — the applier refuses to change their
  item_code (it would move the lot off its product). List them for the owner;
  his call.
- **11 PO lines whose code and name disagree** (from run 34483881613): 3 have a
  supplier record (HC-PO-009679/010041/010161 — will be fixed by #3597's data),
  3 are new Sept orders not in the listing (HC-PO-2609-043/045/053).
- **Square pillow custom-vs-random colour** — NOT touched this round.
- **51 not-proceeded sofas with NO drawing** — direction unknown; wait for
  proceed or ask the customer.
- **13 undecided drawings** — 5 rotated photos, 3 not plans, 5 piece-mismatch.
- HELD items above, each needs one word from the owner.
- Older backlog untouched: I-000213 invoice (RM 2,549), AutoCount payments
  since the cut, 42+21 stock cells disagreeing on quantity.

## The two bugs assigned to SOMEONE ELSE — do not fix

- `so-revision.ts:694` — `applySoAmendment` updates item_code, not description.
- `so-revision.ts:1386` — `reviseBoundPo` writes neither item_code nor
  material_name to the bound PO.

## Corrections I issued this round, so nobody re-inherits them

- the 4 "double-posted" GRNs were a FALSE POSITIVE (docs/bugs/0780).
- product master is NOT the code/description root; it is clean.
- "TV above = our record is mirrored" was BACKWARDS: TV above means the naive
  read is the mirror; a recorder who saw the TV recorded it right.
- five agreeing earlier entries on HC-PO-010041 were one reading copied forward,
  not evidence.
