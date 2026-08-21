## A PO raised from a Sales Order dropped the total-height surcharge [medium]

**Symptom.** Owner, 2026-08-17: *"PO2608-003 /SO2607-018 price incorrect short
RM80 due to additional charges for total height less than 20""*. On
`2990-PO-2608-003`, CODY-(SS) at total height 18" was raised at **RM407.50**
against the SO line's own stored cost of **RM487.50** — exactly the RM80 the
Products · Maintenance *Total Heights* table prices that tier at. The same PO's
CODY-(Q) at 22" matched to the cent.

**Root cause (traced, not guessed).** `computeMfgPoUnitCost` accepts
`totalHeight` and `computeMfgLineCost` prices it for BEDFRAME out of
`maintenanceConfig.totalHeights`. All **five** frontend callers passed it
(`PurchaseOrderNew`, `PurchaseOrderDetail`, `PurchaseInvoiceDetail`, both
Consignment pages). All **three** backend callers did not —
`scm/lib/po-pricing.ts` and two in `scm/routes/mfg-purchase-orders.ts`. The
lookup therefore received `undefined` and returned 0. So a PO keyed by hand on
the PO screen carried the surcharge and a PO converted from an SO did not, which
is why this read as a data problem rather than a code one. The 22" line matched
because that tier is priced 0 — the omission was invisible on every line at or
above 20", which is most of them.

**Fix.** Pass `totalHeight` at all three backend call sites, unconditionally, as
the frontend does (the engine ignores it off BEDFRAME).

**The test is structural, on purpose.** An engine test would have stayed green
throughout — the engine was never broken; it was reached through an argument
nobody passed. `backend/tests/poTotalHeightSurcharge.test.ts` asserts every
`computeMfgPoUnitCost(` call site passes the key, so a fourth caller that forgets
it fails here instead of in a supplier's PO. Written first WITHOUT stripping
comments, it passed against a probe that deleted the argument — the explanatory
comment above it still contained the word. It now asserts on `\btotalHeight\s*:`
in comment-free source and is proven to fail when the argument is removed.

**Not repriced.** 28 bedframe PO lines carry a sub-20" total height and were
raised through a server-side path; whether to recover the difference on already
-issued POs is the owner's call, not the fix's.

**Ref.** PR (branch `fix/do-so-link-repair-and-po-total-height`), 2026-08-17.
