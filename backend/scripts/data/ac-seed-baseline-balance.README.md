# `ac-seed-baseline-balance.json.gz` — FROZEN. Do not re-cut.

What AutoCount held **at the time the ERP's stock was seeded**, so the stock
reconcile can tell two very different things apart:

- the ERP never matched the book it was seeded from (a seeding defect), and
- the ERP matches what it was seeded with, and AutoCount has traded since (the
  ERP is simply behind).

Those look identical in a two-way comparison. They need completely different
remedies, so the reconcile needs a third point of reference, and that reference
only works if it **never moves**.

## Provenance

Byte-for-byte the `ac-live-stock-balance.json.gz` blob exported from `AED_HOUZS`
at **2026-09-07 22:21:06 (+08)** — the snapshot the go-live re-seed was run from.
2689 item+location cells.

**There is no offset any more, and that is the point of this re-cut.** The
baseline and the seeding INPUT are now the same file, so a cell can differ from
this baseline only because AutoCount traded after 22:21 (+08) — never because the
ERP was seeded from a later export than the baseline records.

## What this replaced, and what the old offset actually cost

The previous baseline was the `2026-08-28 23:27 (+08)` export, while the ERP's
`AC_CUTOVER` movements ran to `2026-08-29 21:55 (+08)`. It sat about 22 hours
BEFORE seeding finished, so anything AutoCount posted inside that window was in
the ERP already and still read as drift. The size of that bias was stated as
"one-directional and small" and never measured.

**It is measured now: 47 cells / 128 units absolute**, printed by
`reseed-stock-from-ac-snapshot.mjs` (run 34140365685, PLAN, 2026-09-07). The
measurement is: reconstruct what the ERP held the moment seeding finished
(current on-hand minus every movement written after it) and compare that to the
frozen baseline. Where the two differ, the seeding input and the baseline
disagreed — which is exactly the bias. Every one of those cells was a cell the
reconcile could label "BOTH MOVED SINCE SEEDING" when only AutoCount had moved.

## Why this file exists at all

`ac-stock-balance.json.gz` used to serve as the drift baseline. It is a working
export that `export-ac-reimport.py` re-cuts on every round, and it was re-cut on
2026-09-07 — after seeding. From that moment it equalled the live book, the
drift set collapsed to zero cells, and 175 cells / 1211 units of "AutoCount has
moved on" were reported as "the seeding was wrong". The two files are separated
here so a routine re-export cannot silently change what a cause means.

**Re-cut this only when the ERP's stock is genuinely re-seeded**, and update the
dates above in the same commit. The 2026-09-07 re-cut qualifies:
`reseed-stock-from-ac-snapshot.mjs` overwrote the balance from this exact file
(run 34140557010, APPLY — 199 adjustment movements, then a fresh-connection shape
check reading 988/988 governed cells equal to AutoCount and 0 cells changed
outside that set).
