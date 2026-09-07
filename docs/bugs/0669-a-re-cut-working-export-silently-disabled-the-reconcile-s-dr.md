## A re-cut working export silently disabled the reconcile's drift cause [high]

**Symptom.** Run 34133023365 of *Stock vs AutoCount reconcile* told the owner
that **175 cells / 1211 units** were `CUTOVER ADJUSTMENT ONLY — seeded once and
untouched since, so the delta was present at seeding`, and that **zero** cells
had moved since the snapshot. Read plainly: the seeding got 175 stock cells
wrong and nothing has changed since. That would call for a physical stock count.
It was not true. The ERP was nine days behind a book that had kept trading.

**Root cause (traced).** `check-stock-vs-autocount.mjs:246` built its drift
baseline from `data/ac-stock-balance.json.gz`. That file is not a frozen
baseline — it is a working export, re-cut by `export-ac-reimport.py` whenever
`want("bal")` is on (`export-ac-reimport.py:303`), and its blob changed three
times on 2026-09-07 alone (`b31971a9b`, `84e23b977`, `acf86c75d`). The last
re-cut happened *after* the ERP was seeded, so the "baseline" became a copy of
the live book. Measured, not assumed: rolled up per item+location, the committed
baseline and the fresh 22:21 export differ in **0 cells / 0 units**.

`movedSinceSnapshot` is therefore always empty, the `MIGRATION CUT-OFF` branch
of `causeOf` is unreachable, and every cell that had drifted fell through to the
next branch — which is `CUTOVER ADJUSTMENT ONLY`, the *opposite* diagnosis. The
failure is silent by construction: an empty cause bucket prints nothing, so the
report looked complete.

Against the frozen 2026-08-28 23:27 (+08) export the book had in fact moved
**234 item+location cells / 1331 units** in the nine days since, and that is
exactly where the largest deltas live:

| cell | 2026-08-28 | 2026-09-07 | ERP holds |
|---|---|---|---|
| `AK- ESSENTIAL BOLSTER` @ KL | 29 | 144 | 25 |
| `AK-CS AIRLOFT COMFY PIL` @ KL | 114 | 222 | 93 |
| `AK-SK + MICROFIL PIL` @ KL | 120 | 217 | 112 |
| `NTYR-CS LTX PIL + CSC` @ KL | 557 | 494 | 551 |

**Fix.** A dedicated frozen baseline, `data/ac-seed-baseline-balance.json.gz` —
byte-for-byte the `ac-live-stock-balance.json.gz` blob from `main@35ce93849`,
exported 2026-08-28 23:27 (+08), with a README recording its provenance and the
~22h bias against the ERP's own `AC_CUTOVER` `MAX(created_at)` of 2026-08-29
21:55 (+08). It is carried through the same binding and warehouse mapping as the
AutoCount side, so a seeded quantity is comparable to an ERP quantity cell for
cell. `MIGRATION CUT-OFF` splits into `ERP IS BEHIND THE BOOK` and `BOTH MOVED
SINCE SEEDING`, because those two need opposite remedies — a catch-up sync
versus a physical count — and the drift set's size is now printed on its own
line so it cannot go quiet again.

Proved RED by run 34133023365 (175 cells / 1211 units "CUTOVER ADJUSTMENT ONLY",
drift set 0) and GREEN by run 34133528726 on the same production database and
the same AutoCount snapshot: drift set **224 cells / 1331 units**, and the 202
disagreeing cells re-split as **157 cells / 410 units ERP IS BEHIND THE BOOK**,
**41 cells / 849 units BOTH MOVED SINCE SEEDING**, **4 cells / 4 units CUTOVER
ADJUSTMENT ONLY**. The genuine seeding defect is 4 units, not 1211.

**Ref.** chore/ac-stock-recut-0907, 2026-09-07.
