## The stock reconcile blamed a product NAME for a double-ship whose documents no longer exist [medium]

**Symptom.** Run 34132704988 of *Stock vs AutoCount reconcile* attributed
**14 cells / 139 units** to `KNOWN DOUBLE-SHIP (SO-2606-019, DO-2607-005 +
DO-2607-017) — traced, owner decision pending`, including the single largest
delta in the whole comparison (`NTYR-CS LTX PIL @ BALAKONG WAREHOUSE`,
AutoCount 494 vs ERP 551, +57). Two lines above it, the same run printed
`cells touched by the known double-ship pair (DO-2607-005 / DO-2607-017): 0`.
The report told the owner 139 units were already understood while its own
evidence line said nothing supported that.

**Root cause (traced).** `check-stock-vs-autocount.mjs:320`, the first branch of
`causeOf`:

```js
if (knownCells.has(`${r.code}|${r.whId}`) || isKnownDoubleShip(r.code)) return "KNOWN DOUBLE-SHIP …";
```

`knownCells` is the evidence — cells actually carrying a movement from
DO-2607-005 / DO-2607-017. `isKnownDoubleShip` is a bare prefix test over the
model list `["KETTA","NTYR","TRION","XAMMAR"]`, added to widen coverage while
those movement rows still existed. The re-import re-seeded
`scm.inventory_movements` and the pair now matches zero rows, so `knownCells` is
empty and the `||` left the prefix test labelling on its own — and because it is
the FIRST branch it pre-empted every movement-based cause below it. NTYR is a
whole pillow range, so the widening reached four unrelated products across three
warehouses. Every one of the 14 cells carries `AC_CUTOVER` movements and nothing
else (`AC_CUTOVERx2=551`, `AC_CUTOVERx1=380`, …), which is a seeding delta: a
double-ship IS a DO posted twice, so a cell with no DO movement at all cannot
have one.

**Fix.** The model widening is gated on the evidence still being present
(`doubleShipEvidence = knownCells.size > 0`); the exact-cell test is untouched,
so the label returns by itself if the documents return. When the widening is
withheld the run says so on its own line rather than going quiet. Proved RED on
the unfixed tree by run 34132704988 (14 cells / 139 units under the label, with
`knownCells` printed as 0) and GREEN by run 34133261172 on the same production
database and the same AutoCount snapshot: the label disappears and those 14
cells / 139 units move to `CUTOVER ADJUSTMENT ONLY`, which is what their
movements say. No other bucket moved.

**Ref.** chore/ac-stock-recut-0907, 2026-09-07.
