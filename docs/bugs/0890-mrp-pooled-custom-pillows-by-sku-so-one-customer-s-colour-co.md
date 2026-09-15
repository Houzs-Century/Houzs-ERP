## MRP pooled custom pillows by SKU, so one customer's colour covered another order and lines were ordered twice [high]

<!-- area: Purchase orders + GRN + PI -->

**Symptom.** Owner, 2026-09-14: 「你看一下我们的 Square Pillow 跟 Long Pillow。正常来说，
他们如果有选颜色，在 SpecialOrder 里的规格也是会出来的。因为它是 accessories，你也是 still
要根据它的规格来分配的，不是吗？」 Purchasing (Kathy), same day: "Square Pillow Custom &
Long Pillow custom can't use FIFO, because have custom choose colour. Example
HC-SO-013384 pillow PO is PO010084, no slot for HC-SO-013496 / 013236 … system not
allowed to order because already have PO", and "this PO has been double issued PO
for Long pillow PO2609-091 & PO2609-101".

**Root cause (traced).** A pillow's colour lives in the Special Order text
(`variants.extraAddonNote`), which `computeVariantKey` deliberately leaves out of
the bucket key. So every custom pillow of one SKU in one warehouse shared ONE
bucket, and `isHardBoundLine` (`scm/lib/so-stock-allocation.ts`) named only
sofa / bedframe / `(SP)` mattress as bound. MRP (`routes/mrp.ts` section 7) then
walked that bucket FIFO by delivery date and handed each purchase order to
whichever pillow line was due first, whatever colour it was raised for; the
stored allocator lit pillow lines READY off pooled stock of other colours.

Observed with `backend/scripts/probe-custom-pillow-binding.mjs` (the real
`computeMrp` + `mrpLineCoverage` over `pgrest-shim`, production, read-only
session, 2026-09-14 09:36Z): of **222** live company-1 SQUARE/LONG PILLOW lines,
**34** were reported covered by somebody else's purchase order and **7** reported
SHORT while their own was open. Kathy's three orders, exactly:
HC-SO-013496 (due 10-15, no PO) was covered by HC-PO-010084 — HC-SO-013385's ZL-16
pillows — so MRP offered nothing to order; HC-SO-013236's own HC-PO-009945 was
given to HC-SO-012693; HC-SO-013384 read SHORT with its own HC-PO-010083 open
because 013236 / 013503 had taken it.

The double orders follow from that plus a second hole: an MRP-origin convert has
NO per-line cap ("reference-only, infinitely convertible"), and the ordinary cap
`qty - po_qty_picked` excludes MRP-origin lines. Five live lines were ordered
twice, each an imported AutoCount PO plus an MRP-origin HC-PO-2609-0xx to the
same supplier (Ohana/Hookka): HC-SO-013236 L4 and L5, HC-SO-013310 L2 and L3,
HC-SO-013322 L2. HC-SO-013503 L2 got HC-PO-2609-091 (3) then HC-PO-2609-101 (2),
which is already CANCELLED.

**Fix.** `CUSTOM_ACCESSORY_CODES = {SQUARE PILLOW, LONG PILLOW}` joins
`isHardBoundLine`, matched on the SKU (the CUSTOM code is by the 2026-09-10 SKU
rule the coloured one; `SQUARE PILLOW RDM` stays pooled). Every consumer of that
one predicate follows: MRP covers a company-1 custom pillow from its own PO only,
the stored allocator lights it only from its own receipt, the SO readiness
promotion gate refuses pooled stock, the DO stock check exempts a received own
PO. `lib/bound-line-ordered.ts` caps a company-1 bound line on BOTH convert paths
against every live PO on it, MRP-origin included. Pinned by
`so-stock-allocation.custom-accessory.test.ts`, the pillow suites in
`mrp.test.ts` and `so-stock-allocation.c1-pool.test.ts` (all proved RED on the
unfixed tree: 3 + 2 + 3 failing), `bound-line-ordered.test.ts` and a wiring
assertion in `convert-ceilings.test.ts`. Same probe on the fixed engine against
the same production data: 0 covered by somebody else's PO.

**Not fixed here, on purpose.** The five duplicate purchase orders are left for
purchasing to cancel — a cancel reaches the supplier and AutoCount. Four
MRP-origin pillow PO lines (HC-PO-2609-056/058/059/060) carry no colour because
they were raised at 03:20Z on 2026-09-10, before #3526 copied the book's colour
into the Special Order text (merged 14:46Z that day).

**Ref.** fix/custom-accessory-hard-binding, 2026-09-14.
