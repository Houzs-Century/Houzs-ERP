## GRN list quick-view read a qty field the detail API does not return, so every line showed 0 [medium]

<!-- area: Purchase orders + GRN + PI -->

**Symptom.** On the Goods Received list, clicking a row opens the side quick-view
(and the inline row-drill), and EVERY line showed `Qty 0` while the Received value
was full — e.g. HC-GR-005334 (a DIGLANT / AKEMI mattress receipt) showed all 11
lines at Qty 0 next to RM 1,080 / 1,050 / 1,880 … values. Opening the full detail
page for the same GRN showed the correct quantities (RECEIVED 1 per line, Qty
received 11). So: full page right, quick-view wrong.

**Root cause (traced).** The GRN detail GET (`backend/src/scm/routes/grns.ts`)
selects the line quantities as `qty_received` / `qty_accepted` (accepted =
landed-in-stock), NOT `qty` / `received_qty`. The full detail page was corrected
to read `qty_accepted` back on 2026-08-06 (see the header comment in
`GoodsReceivedDetailV2.tsx` — "the page previously read nonexistent
`qty`/`received_qty` and rendered 0 on EVERY GRN"), but the LIST quick-view was
not part of that fix and kept reading `l.received_qty ?? l.qty ?? 0`
(`GoodsReceivedListV2.tsx`, the drawer render + the `GrnLinesExpansion`
row-drill). Both of those keys are absent on the GRN detail line, so the
expression resolved to `0` on every line — a `?? 0` fallback dressed as data. The
Received value column was unaffected because it reads a different, real field
(`line_total_sen`), which is why the row looked internally contradictory (Qty 0,
value RM 1,880).

The AutoCount migration note on these receipts ("No stock movement: units already
on hand from the balance snapshot") was a RED HERRING checked and ruled out: the
line quantities ARE recorded (`qty_accepted = 1` each; the full page proves it);
`migrated_no_stock` only suppresses the inventory-ledger movement, not the
recorded qty. Nothing about the qty was wrong in the data.

**Fix.** Point both list reads at the fields the detail API actually returns —
`l.qty_accepted ?? l.qty_received ?? 0` — matching the full page's RECEIVED
column and the header's "Qty received" total, and add those two fields to the
`GrnItem` and shared `DrillItemFields` types so the wrong keys can't be read
again. Frontend-only; no API, data or stock change. Verified `tsc -b` clean.
Audited the sibling list quick-views (DO / PI / SI / PR / DR / PO): only GRN read
keys absent from its own detail; the others read their real line field
(`qty` / `qty_returned` / `received_qty`), several with a `?? qty` fallback, and
DeliveryReturn's `qty_returned` matches its detail page — so GRN was the lone
mismatch, because it is the only doc whose detail renames the received qty.

**Ref.** fix/grn-quickview-received-qty, 2026-09-11.
