## Migrated purchase lines were priced by inference, and 318 item codes have a price that varies by PO [high]

**Symptom.** 10,372 migrated purchase-order lines carried no unit price. The
standing repair for that was to infer one — a MAX or a single cost per item
code — which reads as reasonable and is wrong wherever the same product was
bought twice at different prices.

**Root cause, traced down the AutoCount document chain.** The cost was never
missing; it was on a document the cutover never read. `PO --(GRDTL.FromDocNo)-->
GR --(PIDTL.FromDocType='GR')--> PI`, and the purchase invoice is what was
actually paid. `NB-NH39(A)(K)` alone was bought at RM1,760.00, RM1,680.00,
RM1,500.00 and RM1,180.00 on four named invoices; 318 of 754 item codes vary the
same way, so one cost per code cannot be right about more than one of them —
MAX-by-item-code overstates PO-003645 by RM580 per unit.

**Fix.** Read the invoice. `stamp-real-po-costs.mjs` prices a blank line from its
OWN receipt's invoice and writes nothing anywhere else. The join is the
three-part key (source document, ItemCode, Desc2) because AutoCount publishes no
line-to-line key on this chain — `PIDTL.FromDocDtlKey` and `GRDTL.FromDocDtlKey`
are both 0-populated. An AutoCount GR is a MULTI-PO receipt, so GR lines are
narrowed by `FromDocNo = our PO` before a price is read; without that narrowing
the script imports another PO's price, silently.

**What it refuses to do, which is the finding.** It does not write
`inventory_lots.unit_cost_sen`. Measured on the committed extract: of 315
zero-cost cutover layers, 289 have an own-receipt invoice that ALSO says 0.00, 23
have no receipt at all, and 3 resolve to a real price. Reading the invoice
cannot cost those layers, and the only way to put a number on them is to borrow
one from a different document — the inference this lane exists to replace. A
blank is visible; a plausible wrong number is silent forever.

**Control.** On the 7,529 lines that already carried a price the invoice agrees
with 7,396 (98.2%); the 133 that differ are order-to-invoice price changes, where
the invoice is the truth for costing.

**Also fixed here (2026-08-14).** The script wrote on `APPLY=1` alone with no
CONFIRM phrase, no re-read on a fresh connection, and no stated re-run behaviour
— `audit:release-discipline`, inside the required `backend-typecheck` check,
failed on all three. `stamp-real-po-costs.yml` had been passing `CONFIRM` through
since it was written and nothing read it. It now refuses without the phrase and
verifies every priced line on a SECOND connection, asserting the VALUE and its
type rather than a row count.

**Ref** — 2026-08-14, PR #1969 `fix/real-po-costs-from-invoice`. No migration.
