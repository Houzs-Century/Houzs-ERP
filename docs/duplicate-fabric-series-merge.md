# The duplicate fabric series — DECIDED: merge, canonical side wins by reference count

**Date:** 2026-08-11
**Decision:** the owner, in person — **"合并，按引用数多的那边"**. Merge them, and
the side production references more is the one that survives.
**Tool:** `backend/scripts/merge-duplicate-fabric-series.mjs`, Actions →
**merge-duplicate-fabric-series** (`mode=plan` reads, `mode=apply` writes).

---

## What a duplicate is here

Two `scm.fabric_library` rows for **one physical fabric series**, with the live
document lines split across both. `refresh-sofa-colours.mjs` bound `HR805-90` to
`FABRIC HR805` and `HR805-30` to `HR805` in the same run. The picker then offers
the same fabric twice, and any report grouping by `fabric_id` splits one series'
history in half.

A duplicate is detected **by the colour, never by the series name** — two series
are duplicates when they hold the same colour CODE, folded the way the shared
matcher folds. Naming alone would have missed `AVANI` / `AVANI 01` and caught
nothing the colours do not already prove.

**Canonical side = the one production references more**, counted off live SO and
PO lines (`variants->>'fabricId'`), not off the library. Ties go to the series
holding more colours, then to the shorter id. The point is to move the fewest
live rows.

---

## Nothing is deleted — the loser is SUPERSEDED

A merge that removes the losing `fabric_library` row is a **delete**, and the
owner's standing rule is that nothing is deleted, only cancelled. So:

- the losing row **stays in the table** with `active = false`;
- its `label` is stamped `[MERGED into <winner> on <date> - superseded, not
  deleted]`, so the row records its own history;
- its `fabric_colours` children **stay attached to it** and are never dropped, so
  a historical document naming that series still resolves for display;
- `bind-null-colour-lines.mjs` will only ever bind to an **active** series, so a
  superseded duplicate cannot quietly come back.

## And nothing becomes unreachable either — LOSSLESS vs LOSSY

Superseding a series hides every colour hanging off it from the picker. That is
harmless when the loser only holds colours the winner already has — the usual
case, two spellings of one series — and it is a **real loss** when the loser
holds colours the winner does not. So every pair is classified from the data
before anything is written:

| Verdict | Meaning | What the tool does |
|---|---|---|
| `LOSSLESS` | every colour on the losing side has a counterpart on the winning side | repoints the live lines, supersedes the loser |
| `REFUSED-LOSSY` | the loser holds colours the winner does not | **held, not applied.** Applying would take a named colour out of the picker |
| `LOSSY-MOVE` | same, but `MOVE_COLOURS=1` was set | re-parents those colours onto the winner first, then merges — nothing lost |
| `REFUSED-UNMAPPED` | a live line names a colour that is not a row of the losing series at all | held; there is no defensible target |

`MOVE_COLOURS` is opt-in because re-parenting changes the library's **content**,
not just its shape.

### `GD8371` vs `HIRRING GD8371` — the pair to look at before applying

Reference count picks **`GD8371`** (14 live lines) over **`HIRRING GD8371`**
(9 live lines). But `GD8371` holds **one** colour, and `HIRRING GD8371` holds
**10 properly named ones**. Only one colour code is shared between them
(`GD8371-02` ↔ `HIRRING GD8371-02# BEIGE`, 3 live lines), so the other nine
`HIRRING` colours — and the live lines sitting on them — have **no target on the
winner**.

That makes this pair `REFUSED-LOSSY` by default. It is exactly the case the
classification exists for: following pure reference count here, with a naive
implementation, would delete nine named colours from the picker in favour of a
series whose only colour is labelled literally `FABRIC`. The tool reports the
before and after colour by colour and stops rather than guessing.

## Four document arms, not two

The reference **count** that picks the winner comes from SO and PO lines. The
**repoint** has to reach every table whose `variants` can name a series —
`mfg_sales_order_items`, `purchase_order_items`, `grn_items`,
`delivery_order_items` — or a merge leaves an arm pointing at a superseded row.
That is the same unswept-arm shape #1964 found in the GRN snapshot. All four are
measured and written.

## The jsonb write

`jsonb_set(..., to_jsonb($1::text))` over plain text binds. Nothing
pre-serialized is ever handed to a jsonb parameter, and there is no `||` merge
whose operand could be a non-object — the two failure modes that destroyed the
`variants` column three times on 2026-08-10
(`docs/jsonb-double-encoding-coe.md`). The post-apply read counts array-shaped
`variants` blocks on all four arms and fails the run if any exist.

---

## STILL OPEN — two suspected duplicates this detector cannot see

`CH141` vs `CHANTIC`, and `NX` vs `NX016`. They **share no colour code**, and
this detector recognises a duplicate only by a shared colour code, so it is
structurally blind to them. They are **not** folded into the merge on a naming
hunch: doing that would be exactly the "loosen a rung so a query can match a key
it shares no number with" move the digit guard exists to prevent. They need the
owner's eye, or a second detector with a different premise.

The script prints both pairs, with each side's live-line and colour counts,
under `=== STILL OPEN ===` on every run, so they cannot be forgotten.

## Secondary, and not addressed here

Duplicate **colours inside one series** (`CH141-1` and `CH141-1-CREAM` as two
picker choices for one fabric). That is not a series merge and is out of scope
for this decision; the count and examples are printed on every run.

---

## The payoff: the 7 NULL-colour lines

Merging unblocks half of the deferred finding in
BUG-HISTORY "The 7 variant mismatches that were never the collision". Those 7
migrated SO lines carry `colourId = NULL` while their own AutoCount text names a
colour the library holds. They were left unfilled for two reasons:

1. `STAR-10` resolved to `STAR-10 NAVY`, one half of a duplicate pair — binding
   would have picked a spelling arbitrarily. **The merge settles this.**
2. `PC151-101` resolves to `PC151-11`, which **moves a digit**. A colour number
   is an identity, not a spelling (#1893). **This stays refused**, enforced by a
   digit-signature guard in `bind-null-colour-lines.mjs` rather than by a
   hand-maintained exclusion list — so it cannot be lost in a later edit.
