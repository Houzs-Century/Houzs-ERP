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
`variants` blocks on **every arm `backend/scripts/lib/fabric-write.mjs` declares
in `ARMS`** and fails the run if any exist. That list is the only place the arms
are written down — it was four arms when this document was first written and
fifteen since 2026-08-13, so read `ARMS`, never a count quoted in prose. The
figures in the APPLIED section below are what was measured on 2026-08-11,
against the four-arm list of that day; they are a record, not a current claim.

---

---

## APPLIED — production, 2026-08-11

| | |
|---|---|
| Read-only baseline | run **31450029537** |
| PLAN | run **31452278722** |
| APPLY (`move_colours=0`) | run **31452408610** |

Library before: **140 series / 742 colours**, 2,040 live bound document lines.

**29 of the 32 pairs merged. 3 were HELD.** Active series **140 → 111**; every
one of the 29 losers is still in `fabric_library`, `active = false`, label
stamped, colours retained. Read back on a fresh connection: 0 lines still name
any superseded series, and **0 array-shaped `variants` blocks on any of the four
arms**.

Lines repointed — 28, all on the two pairs that actually had live references:

```
HR805        <= FABRIC HR805    SO=2  on FABRIC HR805-10 -> HR805-10
                                SO=7 PO=8 GRN=6 on FABRIC HR805-90 -> HR805-90
ARMANI J9226 <= J9226           SO=3 PO=1 GRN=1 on J9226-2 -> ARMANI J9226-02 BUTTER CREAM
```

The other 27 moved **0** lines — pure library cleanup (18 `AVANI nn`, 7
`STAR nn`, `GARFIELD `, `CASSNYE 07`).

> The GRN arm carried 7 of those 28 lines. A merge that had swept only SO and PO
> — which is what the reference count is taken from — would have left them
> naming a superseded series.

### The 3 HELD pairs — applying them would have removed a named colour

**`GD8371` <= `HIRRING GD8371` — the one flagged in advance, and the numbers are worse than expected.**

Reference count picks `GD8371` (14 live lines) over `HIRRING GD8371` (9 by
SO+PO, **12 across all four arms**). But:

- `GD8371` holds **1** colour; `HIRRING GD8371` holds **10**, of which **9** the
  winner does not have;
- of the loser's 12 live lines, only 3 have a target on the winner:

```
 3 lines on "HIRRING GD8371-02# BEIGE"      [PO=3]        -> "GD8371-02"
 6 lines on "HIRRING GD8371-03# STRAW"      [PO=3 GRN=3]  -> NO TARGET
 3 lines on "HIRRING GD8371-15# DARK GREY"  [SO=3]        -> NO TARGET
```

So merging as reference count directs would have taken these nine named colours
out of the picker — `GD8371-03# STRAW`, `-04# COFFEE`, `-05# MOCHA`,
`-09# BERRY`, `-11# CLOUDY`, `-13# GREY`, `-15# DARK GREY`, `-19# MINT`,
`-20# PINE` — in favour of a series whose single colour is labelled literally
`FABRIC`, and repointed 9 live lines to a series that cannot express them.
**Held. This one needs the owner's eye**, and the options are: run with
`MOVE_COLOURS=1` to re-parent the nine onto `GD8371` (lossless, but the merged
series then carries `HIRRING`-prefixed colour ids), or overrule the reference
count and make `HIRRING GD8371` the canonical side.

**`AM 275` <= `AM275`** — winner holds 1 colour, loser holds 16, **15**
uncovered (`AM275-1` … `AM275-14-CHARCOAL`). 0 live lines on the loser, so
nothing would break — but 15 named colours would leave the picker in favour of a
series with one. Held; same shape as `GD8371`, and probably the same answer.

**`FG66151` <= `UNMATCHED`** — 1 uncovered colour,
`UNMATCHED-STAR-FABRIC-CLOUD` (label `FABRIC, COLOR: CLOUD (#13)`). 0 live
lines. Held by the same rule, though this one looks like import residue rather
than a real colour; it is a cheap owner call.

## STILL OPEN — two suspected duplicates this detector cannot see

`CH141` vs `CHANTIC`, and `NX` vs `NX016`. They **share no colour code**, and
this detector recognises a duplicate only by a shared colour code, so it is
structurally blind to them. They are **not** folded into the merge on a naming
hunch: doing that would be exactly the "loosen a rung so a query can match a key
it shares no number with" move the digit guard exists to prevent. They need the
owner's eye, or a second detector with a different premise.

The script prints both pairs, with each side's live-line and colour counts,
under `=== STILL OPEN ===` on every run, so they cannot be forgotten. As
measured on run **31452278722**:

```
CH141    76 live lines, 28 colours   (CH141-1-CREAM, CH141-4-WOOD, CH141-9-SKY, ...)
CHANTIC   7 live lines,  1 colour    (CHANTIC-141-2)

NX       10 live lines,  5 colours   (NX003, NX005, NX007, NX010, NX011)
NX016     0 live lines,  1 colour    (NX016)
```

Both look like duplicates to a human and neither can be proved by a shared
colour code. Note that the matcher's own `COLOUR_ALIAS` already contains
`"1411" -> [CH141, CH141-1]`, which is the same suspicion recorded as a single
named fact rather than as a rule — the precedent to follow if the owner
confirms.

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
   is an identity, not a spelling (#1893). **This stays refused**, enforced by
   `backend/scripts/lib/colour-digit-guard.mjs` rather than by a
   hand-maintained exclusion list — so it cannot be lost in a later edit.

### APPLIED — 6 bound, 1 refused (2026-08-11)

DRY-RUN **31453714298**, APPLY **31453761074**. 7 candidates, all `colourId`
empty, all resolved against the **712 colours on the 111 ACTIVE series** — a
superseded duplicate cannot be bound to.

```
BOUND   HC-SO-003154  "Col:STAR-09"   -> STAR / STAR-09         number 09     = 09
BOUND   HC-SO-003154  "Col:STAR-10"   -> STAR / STAR-10 NAVY    number 10     = 10
BOUND   HC-SO-009031  "Cream"         -> KS   / KS-02  (CREAM)  number (none) = 02
BOUND   HC-SO-009031  "sliver"        -> KS   / KS-15  (SILVER) number (none) = 15
BOUND   HC-SO-009614  "HC151-17"      -> PC151/ PC151-17        number 151-17 = 151-17
BOUND   HC-SO-010791  "col:MB-04"     -> MB   / MB-04           number 04     = 04

REFUSED HC-SO-011289  "PC151-101"     -> PC151-11 would MOVE A DIGIT  151-101 vs 151-11
```

`STAR-10` binding cleanly to the single canonical `STAR` series is the merge
paying off: before it, that colour resolved to one of two competing spellings.
Read back on a fresh connection — 6 bound, the refused line **untouched**
(`colourId` still null), every `variants` block still object-shaped, and no
gap / divan / leg axis moved.

**The refusal was not free.** The guard's first implementation joined its digit
runs and passed `PC151-101` -> `PC151-11` in DRY-RUN **31452652036**. See
BUG-HISTORY, "A digit guard that joined its digit runs together..." (#1976).
