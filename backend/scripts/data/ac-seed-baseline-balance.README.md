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

Byte-for-byte the `ac-live-stock-balance.json.gz` blob committed on `main` at
`35ce93849`, exported from `AED_HOUZS` at **2026-08-28 23:27 (+08)**. 2683
item+location cells.

The ERP's own `AC_CUTOVER` movements run to **2026-08-29 21:55 (+08)** (read
from `MAX(created_at)`, printed by every reconcile run). So this file sits about
22 hours BEFORE seeding finished: anything AutoCount posted during that window
is attributed to drift when it was in fact seeded. The bias is one-directional
and small, and it is stated in the run output rather than hidden.

## Why this file exists at all

`ac-stock-balance.json.gz` used to serve as the drift baseline. It is a working
export that `export-ac-reimport.py` re-cuts on every round, and it was re-cut on
2026-09-07 — after seeding. From that moment it equalled the live book, the
drift set collapsed to zero cells, and 175 cells / 1211 units of "AutoCount has
moved on" were reported as "the seeding was wrong". The two files are separated
here so a routine re-export cannot silently change what a cause means.

**Re-cut this only when the ERP's stock is genuinely re-seeded**, and update the
dates above in the same commit.
